"""Clientes para modelos de lenguaje locales.

- Integrado (por defecto): ``llama-server`` de llama.cpp gestionado por STARBLITZ (ver ``llm/runtime.py``),
  con salida JSON restringida por esquema, imágenes y cancelación a mitad de generación.
- Ollama (API nativa) y servidores compatibles con OpenAI (LM Studio, KoboldCpp…) ya instalados por el usuario.

Todo el tráfico es local; no se usa ninguna API de pago.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..core.errors import CancelledError, LLMUnavailableError
from ..core.settings import LLMSettings

log = logging.getLogger(__name__)

_THINK_RE = re.compile(r"<think>.*?</think>", re.S)
_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.S)


# Tope de salida de una respuesta JSON (traducción de una página); el mismo que usa el motor integrado.
JSON_MAX_TOKENS = 4096


@dataclass
class ChatMessage:
    role: str
    content: str
    images: list[bytes] = field(default_factory=list)  # JPEG/PNG


@dataclass
class ModelInfo:
    name: str
    size_bytes: int = 0
    vision: bool = False
    thinking: bool = False
    family: str = ""
    parameter_size: str = ""
    quantization: str = ""


class LLMClient:
    """Interfaz común: chat con respuesta JSON validada por esquema."""

    def __init__(self, settings: LLMSettings):
        self.s = settings
        self._capabilities: dict[str, ModelInfo] = {}

    # -- API pública ------------------------------------------------------
    def chat_json(self, messages: list[ChatMessage], schema: dict, *, model: str, temperature: float | None = None,
                  cancel: threading.Event | None = None) -> dict:
        if cancel and cancel.is_set():
            raise CancelledError()
        raw = self._chat(messages, schema, model=model, temperature=self.s.temperature if temperature is None else temperature,
                         cancel=cancel)
        try:
            return parse_json(raw)
        except ValueError:
            log.warning("Respuesta JSON inválida; se reintenta con instrucciones de reparación.")
            if cancel and cancel.is_set():
                raise CancelledError()
            repair = messages + [
                ChatMessage("assistant", raw[:4000]),
                ChatMessage("user", "Tu respuesta no era JSON válido según el esquema. Devuelve SOLO el JSON corregido."),
            ]
            return parse_json(self._chat(repair, schema, model=model, temperature=0.1, cancel=cancel))

    def chat_plain(self, messages: list[ChatMessage], *, model: str, temperature: float = 0.0, max_tokens: int = 1024,
                   extra: dict | None = None, cancel: threading.Event | None = None) -> str:
        """Chat de texto plano (sin esquema JSON): devuelve lo que el modelo escribe. `extra` se mezcla en el cuerpo."""
        raise LLMUnavailableError("Este proveedor no admite la traducción en texto plano.")

    def health(self) -> dict:
        raise NotImplementedError

    def list_models(self) -> list[ModelInfo]:
        raise NotImplementedError

    def warm_up(self, model: str, cancel: threading.Event | None = None) -> None:
        """Carga el modelo en memoria por adelantado (solo tiene efecto con el servidor integrado)."""

    def model_info(self, model: str) -> ModelInfo:
        return ModelInfo(name=model)

    def _chat(self, messages: list[ChatMessage], schema: dict, *, model: str, temperature: float,
              cancel: threading.Event | None = None) -> str:
        raise NotImplementedError

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(connect=5.0, read=float(self.s.timeout_s), write=60.0, pool=5.0)


class OllamaClient(LLMClient):
    def _url(self, path: str) -> str:
        return f"{self.s.base_url}{path}"

    def health(self) -> dict:
        try:
            r = httpx.get(self._url("/api/version"), timeout=3.0)
            r.raise_for_status()
            return {"ok": True, "version": r.json().get("version", "")}
        except (httpx.HTTPError, ValueError):
            return {"ok": False, "version": ""}

    def list_models(self) -> list[ModelInfo]:
        try:
            r = httpx.get(self._url("/api/tags"), timeout=10.0)
            r.raise_for_status()
        except httpx.HTTPError as exc:
            raise LLMUnavailableError(_unreachable_msg()) from exc
        models = []
        for m in r.json().get("models", []):
            details = m.get("details") or {}
            models.append(ModelInfo(
                name=m.get("name", ""), size_bytes=int(m.get("size", 0)), family=details.get("family", ""),
                parameter_size=details.get("parameter_size", ""), quantization=details.get("quantization_level", ""),
            ))
        return models

    def model_info(self, model: str) -> ModelInfo:
        if model in self._capabilities:
            return self._capabilities[model]
        info = ModelInfo(name=model)
        try:
            r = httpx.post(self._url("/api/show"), json={"model": model}, timeout=15.0)
            if r.status_code == 200:
                data = r.json()
                caps = set(data.get("capabilities") or [])
                details = data.get("details") or {}
                info = ModelInfo(name=model, vision="vision" in caps, thinking="thinking" in caps,
                                 family=details.get("family", ""), parameter_size=details.get("parameter_size", ""),
                                 quantization=details.get("quantization_level", ""))
                self._capabilities[model] = info
        except httpx.HTTPError:
            pass
        return info

    def _chat(self, messages: list[ChatMessage], schema: dict, *, model: str, temperature: float,
              cancel: threading.Event | None = None) -> str:
        info = self.model_info(model)
        payload: dict[str, Any] = {
            "model": model,
            "stream": False,
            "format": schema,
            "keep_alive": "20m",
            "options": {"temperature": temperature, "num_ctx": self.s.context_window, "top_p": 0.9,
                        "repeat_penalty": 1.05, "num_predict": JSON_MAX_TOKENS},
            "messages": [self._message(m, info.vision) for m in messages],
        }
        if info.thinking:
            payload["think"] = False  # la traducción no se beneficia del razonamiento largo y es mucho más lenta
        try:
            r = httpx.post(self._url("/api/chat"), json=payload, timeout=self._timeout())
        except httpx.TimeoutException as exc:
            raise LLMUnavailableError("El modelo tardó demasiado en responder. Prueba un modelo más ligero o aumenta el tiempo de espera.") from exc
        except httpx.HTTPError as exc:
            raise LLMUnavailableError(_unreachable_msg()) from exc
        if r.status_code == 404:
            raise LLMUnavailableError(f"El modelo «{model}» no está instalado en Ollama. Descárgalo en Configuración → Modelos.")
        if r.status_code >= 400:
            detail = _safe_error(r)
            raise LLMUnavailableError(f"Ollama devolvió un error: {detail}")
        return (r.json().get("message") or {}).get("content", "")

    def chat_plain(self, messages: list[ChatMessage], *, model: str, temperature: float = 0.0, max_tokens: int = 1024,
                   extra: dict | None = None, cancel: threading.Event | None = None) -> str:
        if cancel and cancel.is_set():
            raise CancelledError()
        msgs = list(messages)
        payload: dict[str, Any] = {
            "model": model, "stream": False, "keep_alive": "20m",
            "options": {"temperature": temperature, "num_ctx": self.s.context_window, "num_predict": max_tokens},
            "messages": [{"role": m.role, "content": m.content} for m in msgs],
        }
        if self.model_info(model).thinking:
            payload["think"] = False
        try:
            r = httpx.post(self._url("/api/chat"), json=payload, timeout=self._timeout())
        except httpx.TimeoutException as exc:
            raise LLMUnavailableError("El modelo tardó demasiado en responder. Prueba un modelo más ligero o aumenta el tiempo de espera.") from exc
        except httpx.HTTPError as exc:
            raise LLMUnavailableError(_unreachable_msg()) from exc
        if r.status_code == 404:
            raise LLMUnavailableError(f"El modelo «{model}» no está instalado en Ollama. Descárgalo en Configuración → Modelos.")
        if r.status_code >= 400:
            raise LLMUnavailableError(f"Ollama devolvió un error: {_safe_error(r)}")
        return (r.json().get("message") or {}).get("content", "")

    def _message(self, m: ChatMessage, vision: bool) -> dict:
        msg: dict[str, Any] = {"role": m.role, "content": m.content}
        if m.images and vision and self.s.use_vision:
            msg["images"] = [base64.b64encode(i).decode() for i in m.images]
        return msg


class OpenAICompatibleClient(LLMClient):
    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.s.api_key}"} if self.s.api_key else {}

    def _url(self, path: str) -> str:
        base = self.s.base_url
        return f"{base}{path}" if base.endswith("/v1") else f"{base}/v1{path}"

    def health(self) -> dict:
        try:
            r = httpx.get(self._url("/models"), headers=self._headers(), timeout=3.0)
            return {"ok": r.status_code == 200, "version": ""}
        except httpx.HTTPError:
            return {"ok": False, "version": ""}

    def list_models(self) -> list[ModelInfo]:
        try:
            r = httpx.get(self._url("/models"), headers=self._headers(), timeout=10.0)
            r.raise_for_status()
        except httpx.HTTPError as exc:
            raise LLMUnavailableError("No se pudo conectar con el servidor compatible con OpenAI configurado.") from exc
        return [ModelInfo(name=m.get("id", "")) for m in r.json().get("data", [])]

    def _payload(self, messages: list[ChatMessage], schema: dict, *, model: str, temperature: float) -> dict:
        def content(m: ChatMessage):
            if not m.images or not self.s.use_vision:
                return m.content
            parts: list[dict] = [{"type": "text", "text": m.content}]
            for img in m.images:
                parts.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(img).decode()}})
            return parts

        return {
            "model": model,
            "temperature": temperature,
            "messages": [{"role": m.role, "content": content(m)} for m in messages],
            "response_format": {"type": "json_schema", "json_schema": {"name": "respuesta", "schema": schema, "strict": True}},
            # Igual que el motor integrado: sin tope ni «enable_thinking=False», Qwen3.5 en un servidor externo (llama.cpp, LM Studio,
            # vLLM) razona y puede generar miles de tokens por página (medido el 2026-11-09: >8 500 en una sola llamada).
            "max_tokens": JSON_MAX_TOKENS,
            "chat_template_kwargs": {"enable_thinking": False},
        }

    def chat_plain(self, messages: list[ChatMessage], *, model: str, temperature: float = 0.0, max_tokens: int = 1024,
                   extra: dict | None = None, cancel: threading.Event | None = None) -> str:
        if cancel and cancel.is_set():
            raise CancelledError()
        payload = {"model": model, "temperature": temperature, "max_tokens": max_tokens,
                   "messages": [{"role": m.role, "content": m.content} for m in messages], **(extra or {})}
        try:
            r = httpx.post(self._url("/chat/completions"), json=payload, headers=self._headers(), timeout=self._timeout())
        except httpx.HTTPError as exc:
            raise LLMUnavailableError("No se pudo conectar con el servidor compatible con OpenAI configurado.") from exc
        if r.status_code >= 400:
            raise LLMUnavailableError(f"El servidor devolvió un error: {_safe_error(r)}")
        choices = r.json().get("choices") or [{}]
        return (choices[0].get("message") or {}).get("content", "")

    def _chat(self, messages: list[ChatMessage], schema: dict, *, model: str, temperature: float,
              cancel: threading.Event | None = None) -> str:
        payload = self._payload(messages, schema, model=model, temperature=temperature)
        try:
            r = httpx.post(self._url("/chat/completions"), json=payload, headers=self._headers(), timeout=self._timeout())
        except httpx.HTTPError as exc:
            raise LLMUnavailableError("No se pudo conectar con el servidor compatible con OpenAI configurado.") from exc
        if r.status_code >= 400:
            raise LLMUnavailableError(f"El servidor devolvió un error: {_safe_error(r)}")
        choices = r.json().get("choices") or [{}]
        return (choices[0].get("message") or {}).get("content", "")


class BuiltinClient(OpenAICompatibleClient):
    """Servidor llama.cpp integrado: se inicia bajo demanda y la generación se puede cancelar al instante."""

    def __init__(self, settings: LLMSettings, runtime, library):
        super().__init__(settings)
        self.runtime = runtime
        self.library = library
        self.last_stats: dict[str, float] = {}

    def health(self) -> dict:
        installed = self.library.installed()
        return {"ok": self.runtime.available() and bool(installed), "version": "llama.cpp",
                "running": self.runtime.running_model() is not None, "installed": len(installed)}

    def list_models(self) -> list[ModelInfo]:
        return [ModelInfo(name=m.id, size_bytes=m.size, vision=m.vision, family=m.arch,
                          parameter_size=f"{m.params_b:g}B", quantization=m.quant) for m in self.library.installed()]

    def warm_up(self, model: str, cancel: threading.Event | None = None) -> None:
        self.runtime.ensure(model, cancel)

    def _payload(self, messages: list[ChatMessage], schema: dict, *, model: str, temperature: float) -> dict:
        payload = super()._payload(messages, schema, model=model, temperature=temperature)
        payload.update({
            "stream": True, "stream_options": {"include_usage": True}, "cache_prompt": True, "top_p": 0.9,
            "repeat_penalty": 1.05, "max_tokens": 4096,
            "chat_template_kwargs": {"enable_thinking": False},  # la traducción no necesita razonamiento largo
        })
        return payload

    def chat_plain(self, messages: list[ChatMessage], *, model: str, temperature: float = 0.0, max_tokens: int = 1024,
                   extra: dict | None = None, cancel: threading.Event | None = None) -> str:
        if cancel and cancel.is_set():
            raise CancelledError()
        payload = {
            "model": model, "temperature": temperature, "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True, "stream_options": {"include_usage": True}, "cache_prompt": True, "max_tokens": max_tokens,
            "chat_template_kwargs": {"enable_thinking": False},  # los modelos con plantilla propia lo reciben en `extra` y lo sustituye
            **(extra or {}),
        }
        return self._stream(payload, model, cancel)

    def _chat(self, messages: list[ChatMessage], schema: dict, *, model: str, temperature: float,
              cancel: threading.Event | None = None) -> str:
        return self._stream(self._payload(messages, schema, model=model, temperature=temperature), model, cancel)

    def _stream(self, payload: dict, model: str, cancel: threading.Event | None) -> str:
        """Petición en streaming al `llama-server` integrado (compartida por la llamada con JSON y la de texto plano)."""
        cancel = cancel or threading.Event()
        with self.runtime.use(model, cancel) as ep:
            headers = {"Authorization": f"Bearer {ep.api_key}"}
            parts: list[str] = []
            started = time.monotonic()
            tokens = 0
            try:
                with httpx.stream("POST", f"{ep.base_url}/v1/chat/completions", json=payload, headers=headers,
                                  timeout=self._timeout()) as r:
                    if r.status_code >= 400:
                        r.read()
                        raise LLMUnavailableError(f"El motor de lenguaje devolvió un error: {_safe_error(r)}")
                    for line in r.iter_lines():
                        if cancel.is_set():
                            raise CancelledError()  # al salir se cierra la conexión y llama.cpp deja de generar
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        for choice in chunk.get("choices") or []:
                            piece = (choice.get("delta") or {}).get("content")
                            if piece:
                                parts.append(piece)
                        usage = chunk.get("usage")
                        if usage:
                            tokens = int(usage.get("completion_tokens") or tokens)
            except httpx.TimeoutException as exc:
                raise LLMUnavailableError("El modelo tardó demasiado en responder. Prueba un modelo más ligero o "
                                          "aumenta el tiempo de espera en Configuración.") from exc
            except httpx.HTTPError as exc:
                raise LLMUnavailableError("Se perdió la conexión con el motor de lenguaje integrado.") from exc
            elapsed = max(time.monotonic() - started, 1e-6)
            self.last_stats = {"tokens": tokens, "seconds": round(elapsed, 2),
                               "tps": round(tokens / elapsed, 1) if tokens else 0.0}
            return "".join(parts)


def create_client(settings: LLMSettings, runtime=None, library=None) -> LLMClient:
    if settings.provider == "builtin":
        if runtime is None or library is None:
            raise LLMUnavailableError("El motor de lenguaje integrado no está disponible.")
        return BuiltinClient(settings, runtime, library)
    return OllamaClient(settings) if settings.provider == "ollama" else OpenAICompatibleClient(settings)


# ---------------------------------------------------------------------------

def parse_json(raw: str) -> dict:
    text = _THINK_RE.sub("", raw or "").strip()
    text = _FENCE_RE.sub("", text).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("sin JSON")
        try:
            data = json.loads(text[start:end + 1])
        except json.JSONDecodeError as exc:
            raise ValueError(str(exc)) from exc
    if not isinstance(data, dict):
        raise ValueError("el JSON no es un objeto")
    return data


def _safe_error(r: httpx.Response) -> str:
    try:
        data = r.json()
        msg = data.get("error") if isinstance(data, dict) else None
        if isinstance(msg, dict):
            msg = msg.get("message")
        return str(msg or r.reason_phrase)[:300]
    except Exception:
        try:
            r.read()
            return r.text[:300] or r.reason_phrase
        except Exception:
            return r.reason_phrase


def _unreachable_msg() -> str:
    return ("No se pudo conectar con Ollama. Asegúrate de que está instalado y en ejecución "
            "(https://ollama.com/download).")
