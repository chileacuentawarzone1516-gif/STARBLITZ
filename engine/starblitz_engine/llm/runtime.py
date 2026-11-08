"""Servidor de modelos de lenguaje propio: ejecuta ``llama-server`` (llama.cpp) como proceso hijo.

STARBLITZ no depende de Ollama ni de ningún servicio externo: empaqueta el servidor oficial de
llama.cpp (con Vulkan, que funciona en GPU NVIDIA, AMD e Intel sin instalar CUDA) y lo gestiona:

- se inicia bajo demanda con el modelo activo y un token aleatorio, solo en ``127.0.0.1``;
- se detiene solo tras un rato de inactividad para devolver la memoria al sistema;
- si una opción opcional no existe en la versión empaquetada, se reintenta con menos opciones;
- el registro del servidor queda en ``logs/llama-server.log`` para diagnóstico.
"""

from __future__ import annotations

import contextlib
import logging
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import httpx

from ..core.errors import CancelledError, LLMUnavailableError
from ..core.hardware import detect as detect_hardware
from ..core.settings import SettingsStore
from .advisor import VISION_RESERVE_GB, current_profile, effective_context
from .catalog import estimate_memory_gb, fit_model
from .library import LLMLibrary

log = logging.getLogger(__name__)

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
EXE = "llama-server.exe" if sys.platform == "win32" else "llama-server"
LOAD_TIMEOUT_S = 20 * 60  # cargar un modelo grande desde un disco lento puede tardar minutos


@dataclass(frozen=True)
class Endpoint:
    base_url: str
    api_key: str
    model_id: str


def find_binary(bin_dir: Path | None) -> Path | None:
    candidates: list[Path] = []
    env = os.environ.get("STARBLITZ_LLAMA_SERVER")
    if env:
        candidates.append(Path(env))
    if bin_dir:
        candidates += [bin_dir / EXE, bin_dir / "llama" / EXE]
    for c in candidates:
        if c.is_file():
            return c
    return None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LlamaRuntime:
    WATCH_INTERVAL_S = 15.0

    def __init__(self, library: LLMLibrary, settings: SettingsStore, logs_dir: Path, bin_dir: Path | None):
        self.library = library
        self.settings = settings
        self.bin_dir = bin_dir
        self.log_path = logs_dir / "llama-server.log"
        logs_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._proc: subprocess.Popen | None = None
        self._endpoint: Endpoint | None = None
        self._started = 0.0
        self._last_used = 0.0
        self._inflight = 0
        self._last_error = ""
        self._flags_used: list[str] = []
        self._watchdog: threading.Thread | None = None
        self._stop_watchdog = threading.Event()

    # -- consulta ------------------------------------------------------------
    def binary(self) -> Path | None:
        return find_binary(self.bin_dir)

    def available(self) -> bool:
        return self.binary() is not None

    def running_model(self) -> str | None:
        with self._lock:
            return self._endpoint.model_id if self._alive() and self._endpoint else None

    def status(self) -> dict:
        with self._lock:
            alive = self._alive()
            return {
                "available": self.available(),
                "running": alive,
                "model": self._endpoint.model_id if alive and self._endpoint else None,
                "pid": self._proc.pid if alive and self._proc else None,
                "uptime_s": round(time.time() - self._started) if alive else 0,
                "idle_s": round(time.time() - self._last_used) if alive else 0,
                "flags": list(self._flags_used) if alive else [],
                "error": self._last_error,
                "log_tail": self.log_tail(12),
            }

    def log_tail(self, lines: int = 30) -> list[str]:
        try:
            with open(self.log_path, "rb") as fh:
                fh.seek(max(0, self.log_path.stat().st_size - 16384))
                text = fh.read().decode("utf-8", errors="replace")
            return text.splitlines()[-lines:]
        except OSError:
            return []

    def _alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    # -- ciclo de vida ---------------------------------------------------------
    @contextlib.contextmanager
    def use(self, model_id: str, cancel: threading.Event | None = None) -> Iterator[Endpoint]:
        """Garantiza el servidor en marcha con ``model_id`` mientras dure el bloque."""
        endpoint = self.ensure(model_id, cancel)
        with self._lock:
            self._inflight += 1
        try:
            yield endpoint
        finally:
            with self._lock:
                self._inflight -= 1
                self._last_used = time.time()

    def ensure(self, model_id: str, cancel: threading.Event | None = None) -> Endpoint:
        with self._lock:
            if self._alive() and self._endpoint and self._endpoint.model_id == model_id:
                self._last_used = time.time()
                return self._endpoint
            self.stop()
            exe = self.binary()
            if exe is None:
                raise LLMUnavailableError("Falta el servidor de modelos integrado (llama-server). Reinstala STARBLITZ o "
                                          "configura un servidor externo en Configuración → Modelos.")
            if not self.library.is_installed(model_id):
                raise LLMUnavailableError("No hay un modelo de traducción instalado. Instálalo en la sección Modelos.")
            return self._start(exe, model_id, cancel or threading.Event())

    def _start(self, exe: Path, model_id: str, cancel: threading.Event) -> Endpoint:
        last_failure = ""
        for attempt, level in enumerate(("full", "basic", "bare")):
            port, key = _free_port(), secrets.token_urlsafe(24)
            cmd = self._command(exe, model_id, port, key, level)
            log.info("Iniciando llama-server (%s): %s", level, " ".join(c if c != key else "***" for c in cmd))
            try:
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                logfile = open(self.log_path, "wb")
                self._proc = subprocess.Popen(cmd, stdout=logfile, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                              cwd=str(exe.parent), creationflags=_NO_WINDOW)
            except OSError as exc:
                self._last_error = f"No se pudo iniciar el servidor de modelos: {exc}"
                raise LLMUnavailableError(self._last_error) from exc
            finally:
                with contextlib.suppress(Exception):
                    logfile.close()  # el proceso hijo conserva su propio descriptor
            endpoint = Endpoint(f"http://127.0.0.1:{port}", key, model_id)
            outcome = self._wait_ready(endpoint, cancel)
            if outcome == "ready":
                self._endpoint, self._started, self._last_used = endpoint, time.time(), time.time()
                self._flags_used = [c for c in cmd[1:] if c.startswith("--")]
                self._last_error = ""
                self._ensure_watchdog()
                return endpoint
            last_failure = self._failure_reason()
            self.stop()
            if outcome == "cancelled":
                raise CancelledError()
            if outcome == "timeout":
                break  # no es un problema de opciones: reintentar sólo duplicaría la espera
        self._last_error = last_failure or "El servidor de modelos no arrancó."
        raise LLMUnavailableError(f"El motor de lenguaje no pudo arrancar. {self._last_error} "
                                  "(Detalles en Configuración → Modelos → Registro del servidor.)")

    def _command(self, exe: Path, model_id: str, port: int, key: str, level: str) -> list[str]:
        cfg = self.settings.value
        s = cfg.llm
        model = self.library.get(model_id)
        hw = detect_hardware()
        gpu = hw.best_gpu
        # Los modelos de visión (detector, OCR, LaMa) comparten la GPU: se les deja su parte.
        shares_gpu = cfg.processing.device != "cpu" and any(p in hw.onnx_providers for p in ("CUDAExecutionProvider", "DmlExecutionProvider"))
        vram = max(0.0, (gpu.vram_mb / 1024) - (VISION_RESERVE_GB if shares_gpu else 0.0)) if gpu else 0.0
        ctx = effective_context(current_profile(hw, cfg.processing.profile), s.context_window, model.context_native)
        need = estimate_memory_gb(model.size, model.params_b or 4.0, ctx, 0, model.arch)
        verdict = fit_model(need, hw.ram_mb / 1024, vram)
        cmd = [str(exe), "-m", str(self.library.model_path(model_id)), "--host", "127.0.0.1", "--port", str(port),
               "--api-key", key, "-c", str(ctx), "--parallel", "1"]
        if verdict["fits"] == "gpu":
            cmd += ["-ngl", "99"]
        elif verdict["fits"] == "cpu":
            cmd += ["-ngl", "0"]
        # "hybrid": sin -ngl, llama.cpp reparte las capas según la memoria libre de la GPU.
        if level in ("full", "basic"):
            cmd += ["--jinja"]
        if level == "full":
            cmd += ["--no-webui", "--reasoning-budget", "0"]
            mm = self.library.mmproj_path(model_id)
            if s.use_vision and mm is not None and verdict["fits"] in ("gpu", "hybrid"):
                cmd += ["--mmproj", str(mm)]
        return cmd

    def _wait_ready(self, ep: Endpoint, cancel: threading.Event) -> str:
        deadline = time.monotonic() + LOAD_TIMEOUT_S
        headers = {"Authorization": f"Bearer {ep.api_key}"}
        while time.monotonic() < deadline:
            if cancel.is_set():
                return "cancelled"
            if self._proc is None or self._proc.poll() is not None:
                return "exited"
            try:
                r = httpx.get(f"{ep.base_url}/health", headers=headers, timeout=2.0)
                if r.status_code == 200:
                    return "ready"
            except httpx.HTTPError:
                pass
            time.sleep(0.4)
        return "timeout"

    def _failure_reason(self) -> str:
        tail = self.log_tail(40)
        for line in reversed(tail):
            low = line.lower()
            if any(k in low for k in ("error", "failed", "invalid", "unknown", "cannot", "out of memory")):
                return line.strip()[:240]
        return tail[-1].strip()[:240] if tail else ""

    def stop(self) -> None:
        with self._lock:
            proc, self._proc, self._endpoint = self._proc, None, None
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            with contextlib.suppress(subprocess.TimeoutExpired):
                proc.wait(timeout=5)
        log.info("llama-server detenido")

    def shutdown(self) -> None:
        self._stop_watchdog.set()
        self.stop()

    # -- descarga de memoria por inactividad ---------------------------------------
    def _ensure_watchdog(self) -> None:
        if self._watchdog and self._watchdog.is_alive():
            return
        self._stop_watchdog.clear()
        self._watchdog = threading.Thread(target=self._watch, name="llama-idle", daemon=True)
        self._watchdog.start()

    def _idle_limit_s(self) -> float:
        return self.settings.value.llm.idle_unload_minutes * 60.0

    def _watch(self) -> None:
        while not self._stop_watchdog.wait(self.WATCH_INTERVAL_S):
            with self._lock:
                if not self._alive():
                    return
                limit = self._idle_limit_s()
                if limit > 0 and self._inflight == 0 and time.time() - self._last_used > limit:
                    log.info("Descargando el modelo de la memoria por inactividad")
                    self.stop()
                    return


__all__ = ["LlamaRuntime", "Endpoint", "find_binary"]
