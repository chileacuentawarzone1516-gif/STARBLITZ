"""Prueba de extremo a extremo de la interfaz: gestor de modelos y procesamiento en vivo (modo navegador).

Arranca por sí sola el motor real (detector y OCR reales) con un Hugging Face simulado y un llama-server simulado
(el servidor de modelos real solo puede ejecutarse en el equipo del usuario), y conduce la interfaz construida
(`apps/desktop/dist`) con Chromium:

  1. Explorar Hugging Face → buscar → ver archivos → instalar un modelo → queda activo.
  2. Probar la traducción en japonés e inglés con el modelo instalado.
  3. Importar un capítulo, procesarlo completo, comprobar que cada página cambia de estado a la vista,
     pausar, reanudar y llegar al final; ver las miniaturas traducidas.
  4. Recuperación: un proyecto interrumpido ofrece «Reanudar».
  5. Cero errores de JavaScript ni de consola.

Uso:  python ui_models_run_e2e.py <carpeta_con_ja_page1.jpg> <detector.onnx> [carpeta_capturas]
"""
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

REPO = Path(__file__).resolve().parents[3]
# El motor y los simulados corren con el entorno Python del proyecto; Playwright, con el que lo trae instalado.
ENGINE_PY = os.environ.get("STARBLITZ_PYTHON") or str(REPO / ".venv" / "bin" / "python")
TESTS = REPO / "engine" / "tests"

TESTDATA, DETECTOR = Path(sys.argv[1]), Path(sys.argv[2])
SHOTS = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(tempfile.mkdtemp(prefix="sb-shots-"))
SHOTS.mkdir(parents=True, exist_ok=True)
TOKEN = "ui-e2e-token"
UI_DIR = REPO / "apps" / "desktop" / "dist"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def split_page(path: Path) -> list[bytes]:
    """Tres páginas distintas a partir de una real: completa, mitad izquierda y mitad derecha."""
    from PIL import Image

    img = Image.open(path).convert("RGB")
    w, h = img.size
    out = []
    for box in ((0, 0, w, h), (0, 0, w // 2, h), (w // 2, 0, w, h)):
        buf = io.BytesIO()
        img.crop(box).save(buf, "JPEG", quality=92)
        out.append(buf.getvalue())
    return out


def start_fake_hf(port: int):
    code = f"import sys,time; sys.path.insert(0, {str(TESTS)!r}); import fake_hf; fake_hf.serve({port}); time.sleep(10**6)"
    proc = subprocess.Popen([ENGINE_PY, "-c", code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/models?search=qwen", timeout=1)
            return proc
        except Exception:
            time.sleep(0.2)
    proc.kill()
    raise SystemExit("el Hugging Face simulado no arrancó")


def make_fake_llama_dir(directory: Path) -> Path:
    """Carpeta con un «llama-server» de pruebas (nunca el real) que lanza el servidor simulado."""
    import stat

    directory.mkdir(parents=True, exist_ok=True)
    exe = directory / "llama-server"
    exe.write_text(f"#!{ENGINE_PY}\nimport sys\nsys.path.insert(0, {str(TESTS)!r})\n"
                   "import fake_llama_server\nfake_llama_server.main()\n", encoding="utf-8")
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)
    return directory


def start_engine(root: Path, hf_url: str, log: Path):
    (root / "models" / "text-detector").mkdir(parents=True, exist_ok=True)
    shutil.copy(DETECTOR, root / "models" / "text-detector" / "comictextdetector.onnx")
    llama = make_fake_llama_dir(root / "llama")
    env = {**os.environ, "STARBLITZ_TOKEN": TOKEN, "HF_ENDPOINT": hf_url, "FAKE_LLAMA_LOG": str(log),
           "FAKE_LLAMA_CHUNK_DELAY": "0.08", "PYTHONPATH": str(REPO / "engine")}
    proc = subprocess.Popen([ENGINE_PY, "-m", "starblitz_engine", "--port", "0", "--data-dir", str(root),
                             "--ui-dir", str(UI_DIR), "--llama-dir", str(llama)],
                            cwd=REPO / "engine", env=env, stdout=subprocess.PIPE, stderr=open(root / "engine.err", "w"), text=True)
    deadline = time.time() + 60
    while time.time() < deadline:
        line = proc.stdout.readline()
        if line.startswith("STARBLITZ_READY"):
            return proc, json.loads(line.split(" ", 1)[1])["port"]
    proc.kill()
    raise SystemExit("el motor no arrancó")


def api(base, method, path, body=None, raw=None, headers=None):
    h = {"Authorization": f"Bearer {TOKEN}", **(headers or {})}
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=h, method=method)
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def multipart_zip(name: str, payload: bytes):
    boundary = "----sbboundary"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{name}\"\r\n"
            "Content-Type: application/zip\r\n\r\n").encode() + payload + f"\r\n--{boundary}--\r\n".encode()
    return body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def wait_job(base, job_id, timeout=300):
    end = time.time() + timeout
    while time.time() < end:
        j = api(base, "GET", f"/api/jobs/{job_id}")
        if j["status"] in ("done", "error", "cancelled"):
            return j
        time.sleep(0.3)
    raise SystemExit("tarea sin terminar")


def make_project(base, name):
    pages = split_page(TESTDATA / "ja_page1.jpg")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for i, p in enumerate(pages):
            zf.writestr(f"cap/{i + 1:03d}.jpg", p)
    pid = api(base, "POST", "/api/projects", {"name": name, "source_lang": "auto"})["id"]
    body, hdr = multipart_zip("cap.zip", buf.getvalue())
    job = api(base, "POST", f"/api/projects/{pid}/import", raw=body, headers=hdr)
    assert wait_job(base, job["id"])["status"] == "done"
    return pid


def main():
    hf_port = free_port()
    hf_server = start_fake_hf(hf_port)
    root = Path(tempfile.mkdtemp(prefix="sb-ui-e2e-"))
    proc, port = start_engine(root, f"http://127.0.0.1:{hf_port}", root / "llama.jsonl")
    base = f"http://127.0.0.1:{port}"
    api(base, "PATCH", "/api/settings", {"processing": {"device": "cpu"}})
    errors: list[str] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

            # 0 · Inicio: sin modelo, el equipo pide el modelo y lo dice con claridad
            page.goto(f"{base}/?token={TOKEN}#/")
            expect(page.get_by_text("Completa la configuración")).to_be_visible(timeout=20000)
            expect(page.get_by_text("Falta un modelo de traducción")).to_be_visible()
            page.screenshot(path=str(SHOTS / "01-inicio-sin-modelo.png"))
            print("OK inicio sin modelo")

            # 1 · Explorar Hugging Face e instalar
            page.get_by_role("button", name="Modelos").first.click()
            page.get_by_role("tab", name="Explorar Hugging Face").click()
            page.get_by_label("Buscar modelos en Hugging Face").fill("qwen")
            page.get_by_role("button", name="Buscar").click()
            expect(page.get_by_text("fake-org/Tiny-Qwen-GGUF")).to_be_visible(timeout=15000)
            page.get_by_role("button", name="Ver archivos").first.click()
            row = page.locator(".model-row", has_text="Tiny-Q4_K_M.gguf")
            expect(row).to_be_visible(timeout=15000)
            page.screenshot(path=str(SHOTS / "02-explorar-archivos.png"))
            row.get_by_role("button", name="Instalar").click()
            expect(row.get_by_text("Instalado")).to_be_visible(timeout=60000)
            print("OK instalación desde Hugging Face")

            # 2 · Mis modelos + prueba de traducción JA y EN
            page.get_by_role("tab", name="Mis modelos").click()
            expect(page.get_by_text("En uso").first).to_be_visible()
            page.get_by_role("button", name="Traducir").click()
            expect(page.locator(".test-translation")).to_contain_text("ES:", timeout=30000)
            page.get_by_role("button", name="Inglés").click()
            page.get_by_role("button", name="Traducir").click()
            expect(page.locator(".test-translation")).to_contain_text("ES: Don't get the wrong idea", timeout=30000)
            page.screenshot(path=str(SHOTS / "03-mis-modelos-prueba.png"))
            print("OK traducción de prueba JA/EN en local")

            # 3 · Recomendados y Avanzado se muestran
            page.get_by_role("tab", name="Recomendados").click()
            expect(page.get_by_text("Descargar también la parte visual")).to_be_visible()
            page.screenshot(path=str(SHOTS / "04-recomendados.png"))
            page.get_by_role("tab", name="Avanzado").click()
            expect(page.get_by_label("Perfil de rendimiento")).to_be_visible()
            page.screenshot(path=str(SHOTS / "05-avanzado.png"))
            print("OK recomendados y avanzado")

            # 4 · Proyecto completo, en vivo, con pausa y reanudación
            pid = make_project(base, "Capítulo de prueba")
            page.goto(f"{base}/#/project/{pid}")
            expect(page.get_by_role("heading", name="Capítulo de prueba")).to_be_visible(timeout=15000)
            page.get_by_role("button", name="Procesar").click()
            page.get_by_role("menuitem", name="Todo el proyecto, automático").click()
            expect(page.locator(".run-panel")).to_be_visible(timeout=15000)
            seen = set()
            paused = False
            end = time.time() + 300
            while time.time() < end:
                for chip in page.locator(".page-thumb figcaption .chip").all_inner_texts():
                    seen.add(chip.strip())
                if not paused and page.get_by_role("button", name="Pausar").count():
                    page.screenshot(path=str(SHOTS / "06-procesando.png"))
                    page.get_by_role("button", name="Pausar").click()
                    expect(page.get_by_text("En pausa").first).to_be_visible(timeout=10000)
                    expect(page.get_by_role("button", name="Reanudar")).to_be_visible()
                    page.screenshot(path=str(SHOTS / "07-pausado.png"))
                    paused = True
                    time.sleep(1.0)
                    page.get_by_role("button", name="Reanudar").click()
                if page.get_by_text("Traducción completada").count():
                    break
                time.sleep(0.2)
            else:
                raise SystemExit("el proyecto no terminó a tiempo")
            assert paused, "no se llegó a pausar"
            live = {"Detectando diálogos", "Traduciendo", "Reconstruyendo globos", "Terminada", "Lista para traducir", "Pendiente", "Traducida"}
            assert len(seen & live) >= 3, f"no se vieron estados en vivo: {seen}"
            page.screenshot(path=str(SHOTS / "08-completado.png"))
            page.keyboard.press("Escape")
            page.get_by_role("button", name="Traducida").click()
            expect(page.locator(".thumb-canvas").first).to_be_visible(timeout=15000)
            time.sleep(1.5)
            page.screenshot(path=str(SHOTS / "09-miniaturas-traducidas.png"))
            detected = api(base, "GET", f"/api/projects/{pid}")["project"]["detected_lang"]
            assert detected == "ja", detected
            print("OK proyecto completo en vivo con pausa/reanudación; estados vistos:", sorted(seen))

            # 5 · Recuperación de una ejecución interrumpida
            pid2 = make_project(base, "Interrumpido")
            run_file = root / "projects" / pid2 / "run.json"
            api(base, "POST", f"/api/projects/{pid2}/process", {"stages": ["analyze"]})
            end = time.time() + 120
            while time.time() < end and api(base, "GET", f"/api/projects/{pid2}/run") is None:
                time.sleep(0.3)
            while time.time() < end and api(base, "GET", f"/api/projects/{pid2}/run")["status"] != "done":
                time.sleep(0.3)
            state = json.loads(run_file.read_text(encoding="utf-8"))
            state.update(status="running", stages=["analyze", "translate", "clean"], finished=None)
            for entry in state["pages"].values():
                entry["state"] = "analyzed"
            run_file.write_text(json.dumps(state), encoding="utf-8")
            page.goto(f"{base}/#/project/{pid2}")
            page.reload()
            expect(page.get_by_text("El procesamiento se interrumpió")).to_be_visible(timeout=15000)
            page.screenshot(path=str(SHOTS / "10-interrumpido.png"))
            page.get_by_role("button", name="Reanudar").click()
            expect(page.get_by_text("Traducción completada")).to_be_visible(timeout=300000)
            print("OK recuperación tras interrupción")

            browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        hf_server.kill()
    if errors:
        print("ERRORES DE CONSOLA:\n" + "\n".join(errors))
        raise SystemExit(1)
    print("SIN ERRORES DE CONSOLA · capturas en", SHOTS)


if __name__ == "__main__":
    main()
