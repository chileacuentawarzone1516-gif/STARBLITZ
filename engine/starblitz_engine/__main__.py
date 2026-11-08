"""Punto de entrada: `python -m starblitz_engine --port 0 --token ...`.

Al arrancar imprime en stdout `STARBLITZ_READY {"port": N}` para que la app de
escritorio sepa dónde conectarse. El token también puede llegar por la
variable de entorno STARBLITZ_TOKEN (preferible: no aparece en la lista de
procesos).
"""

from __future__ import annotations

import argparse
import json
import logging
import logging.handlers
import os
import secrets
import socket
import threading
import time
import sys
from pathlib import Path

import uvicorn

from . import __version__
from .core.paths import DataPaths, default_data_dir


def _pick_port(host: str, preferred: int) -> int:
    """Usa el puerto pedido si está libre; si no (o si es 0), uno libre cualquiera."""
    for candidate in ((preferred, 0) if preferred else (0,)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, candidate))
                return s.getsockname()[1]
            except OSError:
                continue
    raise SystemExit("No hay puertos libres")


def _setup_logging(paths: DataPaths, level: str) -> None:
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    root = logging.getLogger()
    root.setLevel(level.upper())
    fh = logging.handlers.RotatingFileHandler(paths.logs / "engine.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(fh)
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(fmt)
    root.addHandler(sh)
    for noisy in ("httpx", "httpcore", "uvicorn.access", "PIL"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="starblitz-engine", description="Motor local de STARBLITZ")
    parser.add_argument("--port", type=int, default=0, help="0 = puerto libre automático")
    parser.add_argument("--data-dir", type=Path, default=None)
    parser.add_argument("--ui-dir", type=Path, default=None, help="Carpeta con la interfaz web compilada")
    parser.add_argument("--llama-dir", type=Path, default=None, help="Carpeta con llama-server (motor de lenguaje integrado)")
    parser.add_argument("--token", default=None, help="Token de sesión (mejor usar STARBLITZ_TOKEN)")
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args(argv)

    paths = DataPaths(args.data_dir or default_data_dir()).ensure()
    _setup_logging(paths, args.log_level)
    token = args.token or os.environ.get("STARBLITZ_TOKEN") or secrets.token_urlsafe(32)
    host = "127.0.0.1"  # el motor nunca escucha en la red: cada dispositivo trabaja con sus propios recursos
    port = _pick_port(host, args.port)

    from .api.app import create_app
    from .api.context import Services

    llama_dir = args.llama_dir or (Path(os.environ["STARBLITZ_LLAMA_DIR"]) if os.environ.get("STARBLITZ_LLAMA_DIR") else None)
    svc = Services.build(paths, token, llama_dir)
    svc.port = port

    app = create_app(svc, args.ui_dir)
    logging.getLogger(__name__).info("STARBLITZ Engine %s en %s:%s (datos: %s)", __version__, host, port, paths.root)
    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="warning", access_log=False,
                                           timeout_keep_alive=30))

    def announce_when_listening() -> None:
        """Avisa de que el motor está listo solo cuando el puerto ya acepta conexiones (no antes del arranque de la app)."""
        while not server.started and not server.should_exit:
            time.sleep(0.02)
        if server.started:
            print("STARBLITZ_READY " + json.dumps({"port": port, "version": __version__}), flush=True)

    threading.Thread(target=announce_when_listening, name="announce-ready", daemon=True).start()
    try:
        server.run()
    finally:
        svc.shutdown()  # detiene llama-server para no dejar procesos huérfanos reteniendo memoria


if __name__ == "__main__":
    main()
