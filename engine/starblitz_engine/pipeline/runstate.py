"""Estado persistente de una ejecución de proyecto completo (``projects/<id>/run.json``).

Sirve para tres cosas:

- mostrar en vivo en qué punto está *cada página* (detectando, traduciendo, reconstruyendo…);
- calcular progreso global y tiempo restante;
- recuperar un trabajo interrumpido (cierre de la app, apagón): el estado queda en disco y, al volver,
  la interfaz ofrece «Reanudar». Las etapas son idempotentes, así que reanudar solo hace lo que falta.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Literal

from ..core.fsutil import atomic_write_json, read_json
from ..projects.store import ProjectStore

PageState = Literal["pending", "analyzing", "analyzed", "translating", "translated", "cleaning", "done", "error"]
RunStatus = Literal["running", "paused", "done", "error", "cancelled"]

# Peso de cada etapa en el progreso global (el LLM es lo más lento).
STAGE_WEIGHT = {"analyze": 0.25, "translate": 0.55, "clean": 0.20}


class RunState:
    def __init__(self, store: ProjectStore, project_id: str, publish: Callable[[dict], None] | None = None):
        self.store = store
        self.project_id = project_id
        self._publish = publish or (lambda _e: None)
        self._lock = threading.Lock()
        self.data: dict = {}

    # -- ciclo de vida ---------------------------------------------------------
    @property
    def path(self):
        return self.store.project_dir(self.project_id) / "run.json"

    def begin(self, stages: list[str], page_ids: list[str], initial: dict[str, str], force: bool, job_id: str) -> None:
        now = time.time()
        with self._lock:
            self.data = {
                "version": 1, "job_id": job_id, "status": "running", "stages": stages, "force": force,
                "started": now, "updated": now, "finished": None, "error": "", "language": "",
                "pages": {pid: {"state": initial.get(pid, "pending"), "error": "", "t": now} for pid in page_ids},
            }
            self._save()
        self._emit_run()

    def finish(self, status: RunStatus, error: str = "") -> None:
        with self._lock:
            if not self.data:
                return
            self.data.update(status=status, error=error, finished=time.time(), updated=time.time())
            self._save()
        self._emit_run()

    def set_status(self, status: RunStatus) -> None:
        with self._lock:
            if self.data and self.data.get("status") != status:
                self.data["status"] = status
                self._save()

    def set_language(self, lang: str) -> None:
        with self._lock:
            self.data["language"] = lang
            self._save()

    def set_page(self, page_id: str, state: PageState, error: str = "") -> None:
        with self._lock:
            entry = self.data["pages"].get(page_id)
            if entry is None:
                return
            entry.update(state=state, error=error, t=time.time())
            self.data["updated"] = time.time()
            self._save()
        self._publish({"type": "page", "project_id": self.project_id, "page_id": page_id, "state": state, "error": error})

    # -- consulta --------------------------------------------------------------------
    def counts(self) -> dict:
        with self._lock:
            states = [p["state"] for p in self.data.get("pages", {}).values()]
        total = len(states)
        return {"total": total, "done": states.count("done"), "error": states.count("error"),
                "pending": states.count("pending"), "active": total - states.count("done") - states.count("error")
                - states.count("pending")}

    def _save(self) -> None:
        atomic_write_json(self.path, self.data)

    def _emit_run(self) -> None:
        self._publish({"type": "run", "project_id": self.project_id, "status": self.data.get("status"),
                       "counts": self.counts()})


def load(store: ProjectStore, project_id: str) -> dict | None:
    return read_json(store.project_dir(project_id) / "run.json", default=None)


def describe(store: ProjectStore, project_id: str, active_job: dict | None) -> dict | None:
    """Estado público de la última ejecución, marcando como «interrumpida» la que quedó a medias sin tarea viva."""
    data = load(store, project_id)
    if not data:
        return None
    pages = data.get("pages", {})
    states = [p["state"] for p in pages.values()]
    status = data.get("status", "done")
    interrupted = status in ("running", "paused") and active_job is None
    if interrupted:
        status = "interrupted"
    done = states.count("done")
    return {
        "status": status, "interrupted": interrupted, "job_id": data.get("job_id"), "stages": data.get("stages", []),
        "started": data.get("started"), "updated": data.get("updated"), "finished": data.get("finished"),
        "error": data.get("error", ""), "language": data.get("language", ""), "pages": pages,
        "counts": {"total": len(states), "done": done, "error": states.count("error"),
                   "pending": states.count("pending"), "active": len(states) - done - states.count("error") - states.count("pending")},
        "resumable": status in ("interrupted", "error", "cancelled") and done < len(states),
    }
