"""Cola de tareas en segundo plano con progreso, cancelación y eventos.

Las tareas pesadas (visión, LLM) se ejecutan de una en una en un hilo dedicado
para no competir por la GPU; las descargas e importaciones usan un hilo aparte para no
bloquear el procesamiento.
"""

from __future__ import annotations

import asyncio
import logging
import queue
import threading
import time
import traceback
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from .errors import AppError, CancelledError
from .ids import new_id

log = logging.getLogger(__name__)

JobStatus = Literal["queued", "running", "paused", "done", "error", "cancelled"]
Lane = Literal["compute", "io"]


@dataclass
class Job:
    id: str
    kind: str
    title: str
    project_id: str | None = None
    lane: Lane = "compute"
    status: JobStatus = "queued"
    progress: float = 0.0
    stage: str = ""
    message: str = ""
    result: Any = None
    error: str = ""
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    eta_s: float | None = None          # segundos estimados hasta terminar (None = aún sin datos suficientes)
    detail: dict = field(default_factory=dict)   # información estructurada (páginas hechas, etc.)
    pausable: bool = False
    cancel: threading.Event = field(default_factory=threading.Event, repr=False)
    running: threading.Event = field(default_factory=threading.Event, repr=False)  # activo = no pausado

    def public(self) -> dict:
        return {
            "id": self.id, "kind": self.kind, "title": self.title, "project_id": self.project_id,
            "status": self.status, "progress": round(self.progress, 4), "stage": self.stage, "message": self.message,
            "result": self.result, "error": self.error, "created": self.created, "started": self.started,
            "finished": self.finished, "eta_s": None if self.eta_s is None else round(self.eta_s),
            "detail": self.detail, "pausable": self.pausable,
        }


class JobContext:
    """Lo que recibe la función de una tarea para informar progreso y comprobar cancelación."""

    def __init__(self, job: Job, emit: Callable[[Job], None]):
        self.job = job
        self._emit = emit
        self._last = 0.0

    @property
    def cancel_event(self) -> threading.Event:
        return self.job.cancel

    def check(self) -> None:
        """Punto de control: lanza si se canceló y se queda esperando mientras la tarea esté en pausa."""
        job = self.job
        if job.cancel.is_set():
            raise CancelledError()
        if not job.running.is_set():
            job.status = "paused"
            self._emit(job)
            while not job.running.wait(0.25):
                if job.cancel.is_set():
                    raise CancelledError()
            if job.cancel.is_set():
                raise CancelledError()
            job.status = "running"
            self._emit(job)

    def wait_if_paused(self) -> None:
        """Para operaciones de larga duración (descargas): igual que ``check`` pero compatible con ``Callable[[], None]``."""
        self.check()

    def update(self, progress: float | None = None, stage: str | None = None, message: str | None = None,
               force: bool = False, eta_s: float | None = None, detail: dict | None = None) -> None:
        if progress is not None:
            self.job.progress = max(0.0, min(1.0, progress))
        if stage is not None:
            self.job.stage = stage
        if message is not None:
            self.job.message = message
        if eta_s is not None:
            self.job.eta_s = max(0.0, eta_s)
        if detail is not None:
            self.job.detail = detail
        now = time.monotonic()
        if force or now - self._last > 0.25:  # limita la frecuencia de eventos
            self._last = now
            self._emit(self.job)


class EventBus:
    def __init__(self):
        self._subscribers: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        with self._lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subscribers.discard(q)

    def publish(self, event: dict) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        with self._lock:
            subs = list(self._subscribers)
        for q in subs:
            loop.call_soon_threadsafe(_offer, q, event)


def _offer(q: asyncio.Queue, event: dict) -> None:
    try:
        q.put_nowait(event)
    except asyncio.QueueFull:  # cliente lento: se descarta el evento más antiguo
        try:
            q.get_nowait()
            q.put_nowait(event)
        except (asyncio.QueueEmpty, asyncio.QueueFull):
            pass


class JobManager:
    def __init__(self, bus: EventBus, history: int = 200):
        self.bus = bus
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._history = history
        self._lock = threading.Lock()
        self._queues: dict[Lane, queue.Queue] = {"compute": queue.Queue(), "io": queue.Queue()}
        self._fns: dict[str, Callable[[JobContext], Any]] = {}
        for lane in self._queues:
            threading.Thread(target=self._worker, args=(lane,), name=f"jobs-{lane}", daemon=True).start()

    def submit(self, kind: str, title: str, fn: Callable[[JobContext], Any], project_id: str | None = None,
               lane: Lane = "compute", pausable: bool = False) -> Job:
        job = Job(id=new_id("j"), kind=kind, title=title, project_id=project_id, lane=lane, pausable=pausable)
        job.running.set()
        with self._lock:
            self._jobs[job.id] = job
            self._fns[job.id] = fn
            self._order.append(job.id)
            self._trim()
        self._emit(job)
        self._queues[lane].put(job.id)
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list(self, project_id: str | None = None) -> list[dict]:
        with self._lock:
            jobs = [self._jobs[j] for j in self._order if j in self._jobs]
        return [j.public() for j in reversed(jobs) if project_id is None or j.project_id == project_id]

    def active_for(self, project_id: str) -> Job | None:
        with self._lock:
            for jid in reversed(self._order):
                j = self._jobs.get(jid)
                if j and j.project_id == project_id and j.status in ("queued", "running", "paused") and j.lane == "compute":
                    return j
        return None

    def active_for_kind(self, kind: str) -> Job | None:
        with self._lock:
            for jid in reversed(self._order):
                j = self._jobs.get(jid)
                if j and j.kind == kind and j.status in ("queued", "running", "paused"):
                    return j
        return None

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job or job.status not in ("queued", "running", "paused"):
            return False
        job.cancel.set()
        if job.status == "queued":
            job.status = "cancelled"
            job.finished = time.time()
            self._emit(job)
        return True

    def pause(self, job_id: str) -> bool:
        """Pide la pausa; surte efecto en el siguiente punto de control (al terminar el paso en curso)."""
        job = self._jobs.get(job_id)
        if not job or not job.pausable or job.status not in ("queued", "running"):
            return False
        job.running.clear()
        if job.status == "running":
            job.message = "Pausando al terminar el paso en curso…"
            self._emit(job)
        return True

    def resume(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job or not job.pausable or job.status not in ("queued", "running", "paused"):
            return False
        job.running.set()
        return True

    def _trim(self) -> None:
        while len(self._order) > self._history:
            old = self._order[0]
            if self._jobs[old].status in ("queued", "running", "paused"):
                break
            self._order.pop(0)
            self._jobs.pop(old, None)
            self._fns.pop(old, None)

    def _emit(self, job: Job) -> None:
        self.bus.publish({"type": "job", "job": job.public()})

    def _worker(self, lane: Lane) -> None:
        q = self._queues[lane]
        while True:
            job_id = q.get()
            job = self._jobs.get(job_id)
            fn = self._fns.pop(job_id, None)
            if job is None or fn is None or job.status != "queued":
                continue
            job.status, job.started = "running", time.time()
            if job.pausable and not job.running.is_set():
                job.status = "paused"  # se pidió la pausa antes de empezar
            ctx = JobContext(job, self._emit)
            ctx.update(0.0, force=True)
            try:
                ctx.check()
                job.result = fn(ctx)
                job.status, job.progress = "done", 1.0
            except CancelledError:
                job.status = "cancelled"
            except AppError as exc:
                job.status, job.error = "error", exc.message
                log.warning("Tarea %s falló: %s", job.kind, exc.message)
            except Exception as exc:  # error inesperado: mensaje genérico al cliente, detalle al log
                job.status, job.error = "error", "Error interno inesperado. Consulta el registro para más detalles."
                log.error("Tarea %s falló: %s\n%s", job.kind, exc, traceback.format_exc())
            job.finished = time.time()
            self._emit(job)
