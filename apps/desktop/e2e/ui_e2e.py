"""Prueba de extremo a extremo de la interfaz de escritorio (modo navegador).

Requiere un motor en marcha con un proyecto procesado:
  python ui_e2e.py http://127.0.0.1:47900 <token> <project_id>
Comprueba edición, guardado, deshacer/rehacer, vistas, exportación PDF/ZIP
y que no haya errores de JavaScript en consola.
"""
import io
import json
import sys
import time
import urllib.request
import zipfile

from playwright.sync_api import expect, sync_playwright

BASE, TOKEN, PID = sys.argv[1], sys.argv[2], sys.argv[3]
H = {"Authorization": f"Bearer {TOKEN}"}


def api(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H)))


def first_region():
    page = api(f"/api/projects/{PID}")["pages"][0]
    return page, page["regions"][0]


errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.goto(f"{BASE}/?token={TOKEN}#/editor/{PID}")
    expect(page.locator(".region-item").first).to_be_visible(timeout=15000)

    pg, region = first_region()
    original = region["translation"]
    page.locator(".region-item").first.click()
    area = page.locator("#tgt-text")
    expect(area).to_have_value(original)
    area.fill("Texto editado por la prueba.")
    time.sleep(1.2)  # escritura diferida
    assert first_region()[1]["translation"] == "Texto editado por la prueba.", "no se guardó la edición"
    assert first_region()[1]["status"] == "edited"
    print("OK edición guardada")

    page.locator(".stage").click(position={"x": 5, "y": 5})  # quita el foco del campo
    page.keyboard.press("Control+z")
    time.sleep(1.2)
    assert first_region()[1]["translation"] == original, "deshacer no restauró el texto"
    print("OK deshacer")
    page.keyboard.press("Control+y")
    time.sleep(1.2)
    assert first_region()[1]["translation"] == "Texto editado por la prueba."
    print("OK rehacer")
    page.keyboard.press("Control+z")
    time.sleep(1.2)

    # Estilo: tamaño manual y alineación
    page.locator(".region-item").first.click()
    page.get_by_label("Alinear a la izquierda").click()
    time.sleep(1.0)
    assert first_region()[1]["style"]["align"] == "left"
    page.get_by_label("Alinear al centro").click()
    print("OK estilos")

    for view in ("Original", "Comparar", "Traducido"):
        page.get_by_role("button", name=view).click()
        page.wait_for_timeout(600)
    page.screenshot(path="/tmp/claude-0/e2e_editor.png")
    print("OK vistas")

    # Exportación PDF
    page.get_by_role("button", name="Exportar").first.click()
    page.get_by_role("radio", name="PDF").click()
    with page.expect_download(timeout=60000) as dl:
        page.get_by_role("button", name="Exportar 1 página").click()
    data = open(dl.value.path(), "rb").read()
    assert data[:5] == b"%PDF-" and len(data) > 50_000, f"PDF inválido ({len(data)} bytes)"
    print(f"OK PDF {len(data)//1024} KB -> {dl.value.suggested_filename}")

    # Exportación ZIP
    page.get_by_role("button", name="Exportar").first.click()
    page.get_by_role("radio", name="ZIP").click()
    with page.expect_download(timeout=60000) as dl:
        page.get_by_role("button", name="Exportar 1 página").click()
    zf = zipfile.ZipFile(io.BytesIO(open(dl.value.path(), "rb").read()))
    names = zf.namelist()
    assert names and names[0].endswith("/001.jpg"), names
    from PIL import Image
    im = Image.open(io.BytesIO(zf.read(names[0])))
    assert im.size == (pg["width"], pg["height"]), f"resolución alterada: {im.size}"
    print(f"OK ZIP {names} {im.size}")

    # PNG suelto
    page.get_by_role("button", name="Exportar").first.click()
    page.get_by_role("radio", name="PNG").click()
    with page.expect_download(timeout=60000) as dl:
        page.get_by_role("button", name="Exportar 1 página").click()
    assert open(dl.value.path(), "rb").read()[:4] == b"\x89PNG"
    print("OK PNG")

    for route in ("/", "/projects", f"/project/{PID}", "/settings/models", "/settings/translation", "/settings/processing", "/settings/mobile", "/settings/system", "/about"):
        page.evaluate(f"window.location.hash = '{route}'")
        page.wait_for_timeout(900)
    print("OK navegación")
    b.close()

real_errors = [e for e in errors if "Failed to load resource" not in e]
print("Errores de consola:", real_errors or "ninguno")
sys.exit(1 if real_errors else 0)
