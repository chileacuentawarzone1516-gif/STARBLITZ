import threading
import time

import numpy as np

from starblitz_engine.core.jobs import EventBus, JobManager
from starblitz_engine.pipeline.processor import _Progress, _initial_state, _todo
from starblitz_engine.projects.schema import Page
from starblitz_engine.vision.detector import DetectedBlock
from starblitz_engine.vision.langid import direction_for, guess_from_blocks, guess_from_text, script_counts


def _wait(cond, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def test_job_pause_blocks_at_checkpoint_and_resume_continues():
    jobs = JobManager(EventBus())
    steps: list[int] = []
    gate = threading.Event()

    def work(ctx):
        for i in range(6):
            ctx.check()
            steps.append(i)
            if i == 1:
                gate.set()
            time.sleep(0.05)
        return "ok"

    job = jobs.submit("process", "x", work, pausable=True)
    assert gate.wait(3) and jobs.pause(job.id)
    assert _wait(lambda: job.status == "paused")
    frozen = len(steps)
    time.sleep(0.4)
    assert len(steps) == frozen and job.status == "paused"  # no avanza mientras está en pausa
    assert jobs.active_for_kind("process") is job  # una tarea en pausa sigue contando como activa
    assert jobs.resume(job.id)
    assert _wait(lambda: job.status == "done") and job.result == "ok" and len(steps) == 6


def test_cancel_while_paused_ends_the_job():
    jobs = JobManager(EventBus())
    started = threading.Event()

    def work(ctx):
        started.set()
        while True:
            ctx.check()
            time.sleep(0.02)

    job = jobs.submit("process", "x", work, pausable=True)
    started.wait(3)
    jobs.pause(job.id)
    assert _wait(lambda: job.status == "paused")
    assert jobs.cancel(job.id) and _wait(lambda: job.status == "cancelled")


def test_non_pausable_job_ignores_pause():
    jobs = JobManager(EventBus())
    assert jobs.pause(jobs.submit("import", "x", lambda ctx: 1).id) is False


def test_script_counts_and_language_guess_from_text():
    assert script_counts("こんにちは abc 漢字 한").kana == 5
    assert guess_from_text(["何を言ってるんだ、お前は！", "やれやれ…"]) == "ja"
    assert guess_from_text(["What are you doing here?", "Get out!"]) == "en"
    assert guess_from_text(["ok"]) is None
    assert direction_for("ja") == "rtl" and direction_for("en") == "ltr"


def _block(w, h, hint, vertical=False, conf=0.9):
    return DetectedBlock(bbox=(0, 0, w, h), confidence=conf, lang_hint=hint, vertical=vertical)


def test_language_guess_from_detector_blocks():
    ja = [_block(60, 200, "ja", True), _block(50, 180, "ja", True), _block(120, 80, "eng")]
    en = [_block(200, 80, "eng"), _block(180, 70, "eng"), _block(60, 150, "ja", True, conf=0.3)]
    assert guess_from_blocks(ja)[0] == "ja" and guess_from_blocks(en)[0] == "en"
    assert guess_from_blocks([_block(10, 10, "ja")]) == (None, 0.0)  # muy pocos bloques para decidir


def test_todo_is_idempotent_by_page_status():
    def page(status):
        return Page(id="p", index=0, filename="f", ext="png", width=1, height=1, sha1="", dhash="0", status=status)

    full = ["analyze", "translate", "clean"]
    assert _todo(page("imported"), full, False) == full
    assert _todo(page("analyzed"), full, False) == ["translate", "clean"]
    assert _todo(page("translated"), full, False) == ["clean"]
    assert _todo(page("cleaned"), full, False) == []
    assert _todo(page("error"), full, False) == full
    assert _todo(page("cleaned"), full, True) == full
    assert _todo(page("imported"), ["translate"], False) == []  # sin análisis no hay nada que traducir
    assert _initial_state(page("cleaned"), []) == "done" and _initial_state(page("error"), []) == "error"
    assert _initial_state(page("imported"), full) == "pending"


class _Ctx:
    def __init__(self):
        self.last = {}

    def check(self):
        pass

    def update(self, progress=None, stage=None, message=None, force=False, eta_s=None, detail=None):
        self.last.update({k: v for k, v in dict(progress=progress, eta_s=eta_s, detail=detail).items() if v is not None})


class _Run:
    def counts(self):
        return {"total": 4, "done": 0, "error": 0, "pending": 4, "active": 0}


def test_progress_counts_previous_work_and_estimates_eta():
    ctx = _Ctx()
    p = _Progress(ctx, _Run(), pages=4, total_units=4.0, pre_units=2.0, work_units=2.0)  # 2 de 4 páginas ya hechas
    p.started -= 20
    p.step_done("analyze", "a")
    assert 0.5 < ctx.last["progress"] < 0.6 and ctx.last.get("eta_s") is None  # aún no hay una página completa
    p.step_done("translate", "a")
    p.step_done("clean", "a")
    p.page_finished("a", ["analyze", "translate", "clean"])
    assert abs(ctx.last["progress"] - 0.75) < 1e-6
    assert 15 < ctx.last["eta_s"] < 25  # 1 página en ~20 s → la página restante tardará ≈ 20 s


def test_pages_with_errors_count_for_percentage_but_not_for_speed():
    ctx = _Ctx()
    p = _Progress(ctx, _Run(), pages=2, total_units=2.0, pre_units=0.0, work_units=2.0)
    p.started -= 10
    p.step_done("analyze", "bad")
    p.page_finished("bad", ["analyze", "translate", "clean"])  # falló: lo que faltaba se da por descartado
    assert abs(ctx.last["progress"] - 0.5) < 1e-6
    assert p.done_units == 0.25 and abs(p.skipped_units - 0.75) < 1e-6


def test_no_numpy_warnings_import():
    assert np.__version__
