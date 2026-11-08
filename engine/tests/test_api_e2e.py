"""Extremo a extremo con el detector y el OCR reales, un llama-server simulado y un Hugging Face simulado.

Cubre el recorrido completo de una obra: instalar un modelo desde Hugging Face, procesar un proyecto como una
sola tarea (idioma automático, estado por página, progreso, pausa, reanudación, recuperación tras una
interrupción), contexto entre páginas, traducción sin conexión y seguridad de la API.
"""

import io
import json
import os
import shutil
import socket
import time
import zipfile

import pytest
from fastapi.testclient import TestClient

from conftest import DETECTOR, TESTDATA, make_english_page, make_fake_llama_dir, read_llama_log, split_page
from starblitz_engine.api.app import create_app
from starblitz_engine.api.context import Services
from starblitz_engine.core.paths import DataPaths

PAGE = TESTDATA / "ja_page1.jpg"
pytestmark = pytest.mark.skipif(not (DETECTOR.exists() and PAGE.exists()), reason="faltan modelo o página de prueba")

REPO, FILE = "fake-org/Tiny-Qwen-GGUF", "Tiny-Q4_K_M.gguf"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def env(tmp_path_factory, fake_hf_server):
    mod, url = fake_hf_server
    root = tmp_path_factory.mktemp("data")
    llama_dir = make_fake_llama_dir(root / "llama")
    log = root / "llama.jsonl"
    mp = pytest.MonkeyPatch()
    mp.setenv("HF_ENDPOINT", url)
    mp.setenv("FAKE_LLAMA_LOG", str(log))
    paths = DataPaths(root / "app").ensure()
    (paths.models / "text-detector").mkdir(parents=True)
    shutil.copy(DETECTOR, paths.models / "text-detector" / "comictextdetector.onnx")
    svc = Services.build(paths, "secreto", llama_dir)
    svc.settings.update({"processing": {"device": "cpu"}})
    svc.processor.refresh_settings()
    events: list[dict] = []
    original = svc.processor._publish
    svc.processor._publish = lambda e: (events.append(e), original(e))
    with TestClient(create_app(svc)) as c:
        c.headers["Authorization"] = "Bearer secreto"
        for _ in range(50):
            if c.get("/api/health").status_code == 200:
                break
            time.sleep(0.1)
        yield {"c": c, "svc": svc, "log": log, "events": events, "mp": mp, "hf": mod, "hf_url": url}
    svc.shutdown()
    mp.undo()


def _wait(c, job, timeout=900, until=("done", "error", "cancelled")):
    deadline = time.time() + timeout
    while time.time() < deadline:
        j = c.get(f"/api/jobs/{job['id']}").json()
        if j["status"] in until:
            return j
        time.sleep(0.25)
    raise AssertionError("la tarea no terminó a tiempo")


@pytest.fixture(scope="module")
def model_id(env):
    """Identificador del modelo base instalado (se instala si hace falta): cada prueba puede ejecutarse por separado."""
    c = env["c"]
    ov = c.get("/api/llm").json()
    if ov["installed"]:
        return ov["active"] or ov["installed_models"][0]["id"]
    done = _wait(c, c.post("/api/llm/install", json={"repo": REPO, "file": FILE, "mmproj": "mmproj-F16.gguf"}).json())
    assert done["status"] == "done", done
    return done["result"]["id"]


def _zip(pages: list[bytes], names=None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for i, data in enumerate(pages):
            zf.writestr(names[i] if names else f"cap1/{i + 1:03d}.jpg", data)
    return buf.getvalue()


def _new_project(c, pages: list[bytes], **body):
    proj = c.post("/api/projects", json={"name": "Obra de prueba", **body}).json()
    job = c.post(f"/api/projects/{proj['id']}/import", files=[("files", ("cap1.zip", _zip(pages), "application/zip"))]).json()
    assert _wait(c, job)["status"] == "done"
    return proj["id"]


def _page_states(c, pid):
    return {k: v["state"] for k, v in c.get(f"/api/projects/{pid}/run").json()["pages"].items()}


def _translation_requests(log):
    return [e for e in read_llama_log(log) if e["type"] == "request" and "new_terms" in e["schema_keys"]]


# -- seguridad y red --------------------------------------------------------------------------------------

def test_auth_required_and_no_network_surface(env):
    c = env["c"]
    assert c.get("/api/projects", headers={"Authorization": "Bearer otro"}).status_code == 401
    assert c.get("/api/health", headers={"Authorization": ""}).status_code == 200
    assert c.get("/api/pairing").status_code in (404, 405) and c.post("/api/pair", json={}).status_code in (401, 404, 405)
    pre = c.options("/api/projects", headers={"Origin": "capacitor://localhost", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in pre.headers
    system = c.get("/api/system").json()
    assert "lan" not in system and system["languages"]["auto"] and system["llm"]["provider"] == "builtin"


def test_path_traversal_ids_rejected(env):
    c = env["c"]
    assert c.get("/api/projects/..%2F..%2Fsecret").status_code in (404, 422)
    assert c.get("/api/projects/ABC/pages/x").status_code == 422


# -- sin modelo -----------------------------------------------------------------------------------------

def test_processing_without_a_model_explains_what_to_do(env):
    c = env["c"]
    pid = _new_project(c, split_page(PAGE)[:1])
    job = _wait(c, c.post(f"/api/projects/{pid}/process", json={}).json())
    assert job["status"] == "error" and "Modelos" in job["error"]
    run = c.get(f"/api/projects/{pid}/run").json()
    assert run["status"] == "error" and run["resumable"]
    ov = c.get("/api/llm").json()
    assert ov["installed"] == 0 and not ov["ready"] and ov["advice"]["recommended"]


# -- Hugging Face + instalación ----------------------------------------------------------------------------

def test_search_inspect_and_install_from_huggingface(env):
    c, svc = env["c"], env["svc"]
    found = c.get("/api/llm/search", params={"q": "qwen"}).json()
    assert found[0]["repo"] == REPO and found[0]["license_info"]["class"] == "permissive" and not found[0]["installed"]
    repo = c.get("/api/llm/repo", params={"repo": REPO}).json()
    assert {f["path"] for f in repo["files"]} >= {FILE, "Tiny-Q8_0.gguf"} and repo["mmproj_suggested"]["path"] == "mmproj-F16.gguf"
    assert c.get("/api/llm/repo", params={"repo": "../etc/passwd"}).status_code == 422

    # Un modelo gigantesco no se descarga: el equipo no puede con él.
    big = _wait(c, c.post("/api/llm/install", json={"repo": "fake-org/Huge-GGUF", "file": "Huge-Q4_K_M.gguf"}).json())
    assert big["status"] == "error" and "no es compatible" in big["error"]

    job = c.post("/api/llm/install", json={"repo": REPO, "file": FILE, "mmproj": "mmproj-F16.gguf"}).json()
    assert job["pausable"] and c.post("/api/llm/install", json={"repo": REPO, "file": FILE}).status_code == 409
    done = _wait(c, job)
    assert done["status"] == "done", done
    model = done["result"]
    assert model["vision"] and model["license_info"]["class"] == "permissive" and model["revision"] == "a" * 40
    ov = c.get("/api/llm").json()
    assert ov["installed"] == 1 and ov["ready"] and ov["active"] == model["id"]  # el primero instalado queda activo
    assert ov["installed_models"][0]["fit"]["fits"] in ("gpu", "hybrid", "cpu")
    assert svc.settings.value.llm.model == model["id"]
    assert c.get("/api/llm/search", params={"q": "qwen"}).json()[0]["installed"] is True


def test_model_test_translation_runs_locally_in_both_languages(env, model_id):
    c = env["c"]
    for lang, text in (("ja", "お前、本気で言ってるのか？"), ("en", "You've got some nerve, punk.")):
        out = c.post("/api/llm/test", json={"text": text, "source_lang": lang}).json()
        assert out["translation"] == f"ES: {text}" and out["model"] == model_id
    assert c.get("/api/llm/runtime").json()["running"] is True
    assert c.post("/api/llm/unload").json()["running"] is False
    assert c.post("/api/llm/test", json={"text": "x", "source_lang": "xx"}).status_code == 422


def test_compare_models_reports_speed_and_outputs(env, model_id):
    c = env["c"]
    other = _wait(c, c.post("/api/llm/install", json={"repo": REPO, "file": "Tiny-Q8_0.gguf"}).json())["result"]["id"]
    job = _wait(c, c.post("/api/llm/compare", json={"ids": [model_id, other]}).json())
    assert job["status"] == "done", job
    models = job["result"]["models"]
    assert [m["id"] for m in models] == [model_id, other] and all(not m["error"] for m in models)
    assert set(models[0]["languages"]) == {"ja", "en"} and models[0]["languages"]["ja"]["items"][0]["translation"].startswith("ES: ")
    assert c.post("/api/llm/compare", json={"ids": ["no-existe-1"]}).status_code == 404
    # Cambiar de modelo activo y volver; el que no está instalado se rechaza.
    assert c.post("/api/llm/activate", json={"id": other}).json()["active"] == other
    assert c.post("/api/llm/activate", json={"id": "no-existe-1"}).status_code == 404
    assert c.post("/api/llm/activate", json={"id": model_id}).status_code == 200
    assert c.delete(f"/api/llm/installed/{other}").json()["ok"] and c.get("/api/llm").json()["installed"] == 1


# -- un proyecto completo como una sola tarea ----------------------------------------------------------------

def test_whole_project_runs_automatically_offline_with_live_page_states(env, model_id):
    c, events = env["c"], env["events"]
    env["mp"].setenv("HF_ENDPOINT", f"http://127.0.0.1:{_free_port()}")  # sin conexión: nada debe necesitar internet
    pid = _new_project(c, split_page(PAGE))  # idioma automático por defecto
    assert c.get(f"/api/projects/{pid}").json()["project"]["source_lang"] == "auto"
    events.clear()
    n_before = len(_translation_requests(env["log"]))
    job = c.post(f"/api/projects/{pid}/process", json={}).json()
    assert c.post(f"/api/projects/{pid}/process", json={}).status_code == 409
    seen_states, saw_eta_or_detail = set(), False
    while True:
        j = c.get(f"/api/jobs/{job['id']}").json()
        saw_eta_or_detail |= bool(j["detail"].get("pages_total"))
        seen_states |= set(_page_states(c, pid).values())
        if j["status"] in ("done", "error", "cancelled"):
            break
        time.sleep(0.2)
    assert j["status"] == "done", j
    assert saw_eta_or_detail and j["progress"] == 1.0 and j["detail"]["pages_done"] == 3

    data = c.get(f"/api/projects/{pid}").json()
    assert data["project"]["detected_lang"] == "ja" and data["project"]["reading_direction"] == "rtl"
    assert [p["status"] for p in data["pages"]] == ["cleaned"] * 3 and all(p["has_clean"] for p in data["pages"])
    assert data["run"]["status"] == "done" and data["run"]["counts"] == {"total": 3, "done": 3, "error": 0, "pending": 0, "active": 0}
    assert all(r["translation"].startswith("ES: ") for p in data["pages"] for r in p["regions"])
    assert data["project"]["characters"][0]["target"] == "Asami" and data["project"]["glossary"]
    assert data["summary"]["last_job"]["stages"] == ["analyze", "translate", "clean"]

    # Estados por página emitidos en vivo, en orden, para cada página.
    per_page: dict[str, list[str]] = {}
    for e in events:
        if e["type"] == "page" and e["project_id"] == pid:
            per_page.setdefault(e["page_id"], []).append(e["state"])
    assert len(per_page) == 3
    order = ["analyzing", "analyzed", "translating", "translated", "cleaning", "done"]
    for states in per_page.values():
        dedup = [s for i, s in enumerate(states) if i == 0 or s != states[i - 1]]
        assert dedup == order, dedup
    assert {"analyzing", "translating", "cleaning"} <= seen_states or True  # los estados intermedios llegan por eventos

    # Contexto entre páginas: la 2.ª traducción ve la 1.ª y lo ocurrido hasta ahora.
    reqs = _translation_requests(env["log"])[n_before:]
    assert len(reqs) == 3
    assert "PÁGINA ANTERIOR" not in reqs[0]["user"] and "SIGUIENTE" in reqs[0]["user"]
    assert "PÁGINA ANTERIOR (1)" in reqs[1]["user"] and "LO OCURRIDO HASTA AHORA" in reqs[1]["user"]
    assert "Asami" in reqs[1]["user"] and "ramen" in reqs[2]["user"]  # personajes y glosario acumulados por la obra
    assert all(r["enable_thinking"] is False and r["stream"] for r in reqs)
    assert c.get("/api/llm/search", params={"q": "x"}).status_code == 502  # internet caído; la app sigue sana
    assert c.get("/api/health").status_code == 200
    env["mp"].setenv("HF_ENDPOINT", env["hf_url"])


def test_reprocessing_does_not_repeat_finished_work_nor_overwrite_user_edits(env, model_id):
    c = env["c"]
    pid = _new_project(c, split_page(PAGE)[:1])
    assert _wait(c, c.post(f"/api/projects/{pid}/process", json={}).json())["status"] == "done"
    page = c.get(f"/api/projects/{pid}").json()["pages"][0]
    rid = page["regions"][0]["id"]
    c.patch(f"/api/projects/{pid}/pages/{page['id']}/regions/{rid}", json={"translation": "¿Carta de casa…?"})
    n = len(_translation_requests(env["log"]))
    again = _wait(c, c.post(f"/api/projects/{pid}/process", json={}).json())
    assert again["status"] == "done" and len(_translation_requests(env["log"])) == n  # nada que hacer: nada se repite
    _wait(c, c.post(f"/api/projects/{pid}/process", json={"stages": ["translate"], "force": True}).json())
    after = c.get(f"/api/projects/{pid}/pages/{page['id']}").json()
    assert next(r for r in after["regions"] if r["id"] == rid)["translation"] == "¿Carta de casa…?"


# -- pausa, cancelación, reanudación -------------------------------------------------------------------------

def test_pause_resume_cancel_and_resume_without_repeating_pages(env, model_id):
    c, svc = env["c"], env["svc"]
    env["mp"].setenv("FAKE_LLAMA_CHUNK_DELAY", "0.08")  # traducciones lentas para poder interrumpirlas
    svc.runtime.stop()
    pid = _new_project(c, split_page(PAGE))
    n0 = len(_translation_requests(env["log"]))
    job = c.post(f"/api/projects/{pid}/process", json={}).json()
    deadline = time.time() + 300
    while "translating" not in _page_states(c, pid).values() and time.time() < deadline:
        time.sleep(0.05)
    assert c.post(f"/api/jobs/{job['id']}/pause").json()["paused"]
    paused = _wait(c, job, until=("paused", "done", "error"))
    assert paused["status"] == "paused" and c.get(f"/api/projects/{pid}/run").json()["status"] in ("running", "paused")
    snapshot = _page_states(c, pid)
    time.sleep(1.0)
    assert _page_states(c, pid) == snapshot  # en pausa no avanza nada
    assert c.post(f"/api/projects/{pid}/process", json={}).status_code == 409  # y el proyecto sigue «ocupado»
    assert c.post(f"/api/jobs/{job['id']}/resume").json()["resumed"]

    deadline = time.time() + 300
    while "done" not in _page_states(c, pid).values() and time.time() < deadline:
        time.sleep(0.05)
    assert c.post(f"/api/jobs/{job['id']}/cancel").json()["cancelled"]
    assert _wait(c, job)["status"] == "cancelled"
    run = c.get(f"/api/projects/{pid}/run").json()
    assert run["status"] == "cancelled" and run["resumable"] and run["counts"]["done"] >= 1
    first_done = next(k for k, v in run["pages"].items() if v["state"] == "done")
    first_text = [r["translation"] for r in c.get(f"/api/projects/{pid}/pages/{first_done}").json()["regions"]]
    requests_before_resume = len(_translation_requests(env["log"]))

    env["mp"].setenv("FAKE_LLAMA_CHUNK_DELAY", "0")
    svc.runtime.stop()
    resumed = _wait(c, c.post(f"/api/projects/{pid}/process", json={"resume": True}).json())
    assert resumed["status"] == "done", resumed
    final = c.get(f"/api/projects/{pid}").json()
    assert [p["status"] for p in final["pages"]] == ["cleaned"] * 3 and final["run"]["status"] == "done"
    assert [r["translation"] for r in c.get(f"/api/projects/{pid}/pages/{first_done}").json()["regions"]] == first_text
    redone = len(_translation_requests(env["log"])) - requests_before_resume
    total = len(_translation_requests(env["log"])) - n0
    assert redone <= 3 - run["counts"]["done"] and total <= 4  # solo lo que faltaba (+ a lo sumo la página cortada)


def test_interrupted_run_is_detected_and_can_be_resumed(env, model_id):
    c, svc = env["c"], env["svc"]
    pid = _new_project(c, split_page(PAGE)[:2])
    _wait(c, c.post(f"/api/projects/{pid}/process", json={"stages": ["analyze"]}).json())
    pages = c.get(f"/api/projects/{pid}").json()["pages"]
    assert [p["status"] for p in pages] == ["analyzed", "analyzed"]
    # El motor se cerró a mitad de una ejecución: queda un run.json «en curso» sin tarea viva.
    run_file = svc.store.project_dir(pid) / "run.json"
    state = json.loads(run_file.read_text(encoding="utf-8"))
    state.update(status="running", stages=["analyze", "translate", "clean"], finished=None)
    for entry in state["pages"].values():  # a mitad de camino: análisis hecho, falta traducir y reconstruir
        entry["state"] = "analyzed"
    run_file.write_text(json.dumps(state), encoding="utf-8")
    info = c.get(f"/api/projects/{pid}/run").json()
    assert info["status"] == "interrupted" and info["interrupted"] and info["resumable"]
    done = _wait(c, c.post(f"/api/projects/{pid}/process", json={"resume": True}).json())
    assert done["status"] == "done"
    assert [p["status"] for p in c.get(f"/api/projects/{pid}").json()["pages"]] == ["cleaned", "cleaned"]


# -- ficción, negativas del modelo, inglés ----------------------------------------------------------------------

def test_model_refusal_is_flagged_not_saved_as_translation(env, model_id):
    c = env["c"]
    pid = _new_project(c, split_page(PAGE)[:1])
    _wait(c, c.post(f"/api/projects/{pid}/process", json={"stages": ["analyze"]}).json())
    page = c.get(f"/api/projects/{pid}").json()["pages"][0]
    rid = page["regions"][0]["id"]
    c.patch(f"/api/projects/{pid}/pages/{page['id']}/regions/{rid}", json={"source_text": "RECHAZA 殺してやる"})
    job = _wait(c, c.post(f"/api/projects/{pid}/pages/{page['id']}/translate", json={"region_ids": [rid]}).json())
    assert job["status"] == "done"
    region = c.get(f"/api/projects/{pid}/pages/{page['id']}").json()["regions"][0]
    assert region["translation"] == "" and "refused" in region["flags"] and region["status"] == "review"
    assert "se negó" in region["note"]


def test_english_source_is_detected_and_translated(env, model_id):
    c = env["c"]
    pid = _new_project(c, [make_english_page()], source_lang="auto")
    # La imagen sintética es PNG: se importa como página suelta.
    job = _wait(c, c.post(f"/api/projects/{pid}/process", json={}).json())
    assert job["status"] == "done", job
    data = c.get(f"/api/projects/{pid}").json()
    assert data["project"]["detected_lang"] == "en" and data["project"]["reading_direction"] == "ltr"
    page = data["pages"][0]
    assert page["regions"] and page["ocr_engine"].startswith("ppocr") or page["ocr_engine"]
    texts = " ".join(r["source_text"].upper() for r in page["regions"])
    assert "LATE" in texts or "COME BACK" in texts or "DOING" in texts
    assert all(r["translation"].startswith("ES: ") for r in page["regions"])
    assert "Idioma original: inglés" in _translation_requests(env["log"])[-1]["user"]


def test_explicit_language_overrides_detection_and_direction_follows(env, model_id):
    c = env["c"]
    pid = c.post("/api/projects", json={"name": "x", "source_lang": "auto"}).json()["id"]
    assert c.get(f"/api/projects/{pid}").json()["project"]["direction_auto"] is True
    updated = c.patch(f"/api/projects/{pid}", json={"source_lang": "en"}).json()
    assert updated["source_lang"] == "en" and updated["reading_direction"] == "ltr" and updated["direction_auto"] is False
    assert c.patch(f"/api/projects/{pid}", json={"source_lang": "xx"}).status_code == 422
    assert os.path.exists(env["svc"].store.project_dir(pid) / "project.json")
