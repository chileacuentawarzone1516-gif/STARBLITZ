"""``llama-server`` simulado: mismo contrato HTTP (``/health``, ``/v1/chat/completions`` en streaming con salida
JSON por esquema) y mismas opciones de línea de comandos que el real, para probar el ciclo de vida del
runtime (arranque, reintento sin opciones, cancelación, descarga por inactividad) sin un modelo de verdad.

Variables de entorno de control: FAKE_LLAMA_LOG (JSONL de arranques y peticiones), FAKE_LLAMA_REJECT (opciones que
rechaza, separadas por coma), FAKE_LLAMA_DELAY (segundos de «carga»), FAKE_LLAMA_CHUNK_DELAY (pausa entre trozos).
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def _log(entry: dict) -> None:
    path = os.environ.get("FAKE_LLAMA_LOG")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _text_of(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if p.get("type") == "text")
    return content or ""


def _completion(body: dict) -> dict:
    schema = body["response_format"]["json_schema"]["schema"]
    user = _text_of(body["messages"][-1])
    props = schema["properties"]
    if "new_terms" in props:  # pase de traducción
        items = []
        for m in re.finditer(r"^\[(\d+)\] \([^)]*\) (.+)$", user, re.M):
            n, text = int(m.group(1)), m.group(2)
            translation = "Lo siento, no puedo ayudar con eso." if "RECHAZA" in text else f"ES: {text}"
            items.append({"n": n, "translation": translation, "speaker": "Asami", "emotion": "neutral",
                          "confidence": 0.9 if n % 3 else 0.5, "flags": [] if n % 3 else ["ambiguous"], "note": "", "source_fix": ""})
        return {"items": items, "new_terms": [{"source": "ラーメン", "target": "ramen", "note": ""}],
                "characters": [{"source": "麻美", "target": "Asami", "gender": "f", "speech": "informal"}],
                "page_summary": "Asami recibe una carta de casa."}
    items = [{"n": int(m.group(1)), "final": m.group(2) + " (rev)", "issue": "naturalidad", "confidence": 0.85}
             for m in re.finditer(r"^\[(\d+)\].*\n  ORIGINAL: .*\n  TRADUCCIÓN: (.+)$", user, re.M)]
    return {"items": items}


class Handler(BaseHTTPRequestHandler):
    api_key = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # silencio
        pass

    def _send(self, code: int, payload: dict) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"status": "ok"})
        else:
            self._send(404, {"error": "no"})

    def do_POST(self):
        if self.headers.get("Authorization") != f"Bearer {self.api_key}":
            return self._send(401, {"error": {"message": "invalid api key"}})
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if self.path != "/v1/chat/completions":
            return self._send(404, {"error": "no"})
        has_image = any(isinstance(m.get("content"), list) and any(p.get("type") == "image_url" for p in m["content"])
                        for m in body["messages"])
        _log({"type": "request", "stream": body.get("stream"), "has_image": has_image,
              "enable_thinking": (body.get("chat_template_kwargs") or {}).get("enable_thinking"),
              "schema_keys": sorted(body["response_format"]["json_schema"]["schema"]["properties"]),
              "user": _text_of(body["messages"][-1])[:4000]})
        text = json.dumps(_completion(body), ensure_ascii=False)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        delay = float(os.environ.get("FAKE_LLAMA_CHUNK_DELAY", "0"))
        pieces = [text[i:i + 40] for i in range(0, len(text), 40)]

        def chunk(data: str) -> None:
            raw = data.encode()
            self.wfile.write(f"{len(raw):x}\r\n".encode() + raw + b"\r\n")
            self.wfile.flush()
        try:
            for piece in pieces:
                chunk("data: " + json.dumps({"choices": [{"delta": {"content": piece}}]}, ensure_ascii=False) + "\n\n")
                if delay:
                    time.sleep(delay)
            chunk("data: " + json.dumps({"choices": [], "usage": {"completion_tokens": len(pieces) * 10}}) + "\n\n")
            chunk("data: [DONE]\n\n")
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            _log({"type": "client_disconnected"})


def main(argv: list[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    rejected = [r for r in os.environ.get("FAKE_LLAMA_REJECT", "").split(",") if r]
    for flag in rejected:
        if flag in argv:
            print(f"error: invalid argument: {flag}", flush=True)
            sys.exit(1)

    def opt(name: str, default: str = "") -> str:
        return argv[argv.index(name) + 1] if name in argv else default

    model = opt("-m")
    if not model or not Path(model).is_file():
        print(f"error: failed to load model '{model}'", flush=True)
        sys.exit(1)
    Handler.api_key = opt("--api-key")
    _log({"type": "start", "model": Path(model).name, "ctx": opt("-c"), "ngl": opt("-ngl", "auto"),
          "flags": [a for a in argv if a.startswith("--")], "mmproj": opt("--mmproj")})
    time.sleep(float(os.environ.get("FAKE_LLAMA_DELAY", "0.2")))
    server = ThreadingHTTPServer((opt("--host", "127.0.0.1"), int(opt("--port", "8080"))), Handler)
    print("main: server is listening", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
