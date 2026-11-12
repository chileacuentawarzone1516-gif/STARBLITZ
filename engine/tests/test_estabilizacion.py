"""Regresiones de la auditoría de estabilización (2026-11-12). Cada prueba fallaba antes de su corrección."""

import io
import json
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from PIL import Image

from conftest import make_png
from starblitz_engine.core.errors import CancelledError
from starblitz_engine.core.settings import LLMSettings, SettingsStore
from starblitz_engine.importers.ingest import ingest, iter_zip, load_image
from starblitz_engine.pipeline.processor import _keep_reviewed, _merge_unchanged, _snapshot
from starblitz_engine.projects.schema import Region
from starblitz_engine.translate.contextual import _item_n
from starblitz_engine.translate.llm import OllamaClient, OpenAICompatibleClient


def _region(rid: str, bbox=(10, 10, 110, 60), **kw) -> Region:
    return Region(id=rid, order=0, bbox=bbox, layout_box=bbox, **kw)


# -- importación ---------------------------------------------------------------------------------------------------

def _zip_with_damaged_second_entry() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("001.png", make_png(text="uno"))
        zf.writestr("002.png", make_png((250, 250, 250), text="dos"))
    data = bytearray(buf.getvalue())
    with zipfile.ZipFile(io.BytesIO(bytes(data))) as zf:
        info = zf.getinfo("002.png")
    start = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra)
    for i in range(start + 10, start + 40):  # datos comprimidos corruptos → CRC o deflate inválidos
        data[i] ^= 0xFF
    return bytes(data)


def test_zip_with_one_damaged_entry_imports_the_rest():
    entries = list(iter_zip("cap.zip", _zip_with_damaged_second_entry()))
    assert [type(p).__name__ for _n, p in entries] == ["bytes", "ValueError"]
    added: list[str] = []
    report = ingest([("cap.zip", _zip_with_damaged_second_entry())], [], 10,
                    lambda img, dup: added.append(img.name) or f"p{len(added)}")
    assert len(report.added) == 1 and len(report.errors) == 1
    assert "dañado" in report.errors[0]["reason"]


def _jpeg(orientation: int | None) -> bytes:
    img = Image.new("RGB", (300, 200), (200, 30, 30))
    buf = io.BytesIO()
    if orientation is None:
        img.save(buf, "JPEG", quality=90)
    else:
        exif = Image.Exif()
        exif[0x0112] = orientation
        img.save(buf, "JPEG", quality=90, exif=exif)
    return buf.getvalue()


def test_jpeg_without_rotation_is_kept_as_jpeg():
    raw = _jpeg(None)
    img = load_image("a.jpg", raw)
    assert img.ext == "jpg" and img.data == raw  # antes se recodificaba SIEMPRE a PNG (3-5x más espacio)
    assert load_image("b.jpg", _jpeg(1)).ext == "jpg"


def test_jpeg_with_exif_rotation_is_applied():
    img = load_image("c.jpg", _jpeg(6))  # 6 = girar 90°
    assert img.ext == "png" and (img.width, img.height) == (200, 300)


# -- ajustes -------------------------------------------------------------------------------------------------------

def test_one_invalid_setting_keeps_dictionary_and_token(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({
        "llm": {"hf_token": "hf_secreto_de_prueba", "temperature": 0.4},
        "processing": {"detector": "futuro-detector"},
        "translation": {"dictionary": [{"source": "Kaito", "target": "Kaito"}]},
    }), encoding="utf-8")
    s = SettingsStore(path).value
    assert s.llm.hf_token == "hf_secreto_de_prueba" and s.llm.temperature == 0.4
    assert s.processing.detector == "default"
    assert [e.source for e in s.translation.dictionary] == ["Kaito"]
    assert (tmp_path / "settings.json.bad").exists()


def test_truncated_settings_file_does_not_block_startup(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text('{"llm": {"hf_token": "hf_x", "temper', encoding="utf-8")
    store = SettingsStore(path)  # antes: JSONDecodeError y el motor no arrancaba
    assert store.value.llm.provider == "builtin"
    assert (tmp_path / "settings.json.bad").read_text(encoding="utf-8").startswith('{"llm"')
    json.loads(path.read_text(encoding="utf-8"))  # reescrito válido


# -- traducción ----------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("value, expected", [(3, 3), (3.0, 3), ("4", 4), (" 5 ", 5), (None, None), (2.7, None),
                                             (True, None), ("dos", None), ("²", None), (float("nan"), None)])
def test_item_number_is_parsed_safely(value, expected):
    assert _item_n(value) == expected  # antes int(None) tumbaba la página y 2.7 iba al globo 2


def test_translation_does_not_overwrite_edits_made_meanwhile():
    a, b = _region("a", source_text="HI"), _region("b", bbox=(10, 100, 110, 150), source_text="BYE")
    seen = _snapshot([a, b])
    from_model = [a.model_copy(update={"translation": "Hola", "status": "translated"}),
                  b.model_copy(update={"translation": "Adiós", "status": "translated"})]
    edited_b = b.model_copy(update={"translation": "TEXTO DEL USUARIO", "status": "edited", "updated": b.updated + 1})
    merged = _merge_unchanged([a, edited_b], from_model, seen)
    assert [r.translation for r in merged] == ["Hola", "TEXTO DEL USUARIO"]
    assert merged[1].status == "edited"


def test_reanalysis_keeps_reviewed_regions_without_a_detector_match():
    manual = _region("manual", bbox=(400, 400, 500, 450), source_text="HAND", translation="A mano", status="approved",
                     erase=False)
    moved = _region("old", bbox=(10, 10, 110, 60), source_text="OK!", translation="¡Vale!", status="edited", render=False)
    fresh = [_region("n1", bbox=(12, 11, 111, 61), source_text="0K!"), _region("n2", bbox=(200, 200, 260, 240))]
    out = _keep_reviewed(fresh, [manual, moved])
    assert [r.id for r in out] == ["n1", "n2", "manual"] and [r.order for r in out] == [0, 1, 2]
    assert (out[0].translation, out[0].status, out[0].source_text, out[0].render) == ("¡Vale!", "edited", "OK!", False)
    assert out[2].translation == "A mano" and out[2].erase is False


# -- cancelación con servidores externos ---------------------------------------------------------------------------

class _Slow(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if "/api/show" in self.path:  # metadatos del modelo (Ollama): rápidos; lo lento es la generación
            body = b"{}"
        else:
            time.sleep(8)
            body = b'{"message": {"content": "{}"}, "choices": [{"message": {"content": "{}"}}]}'
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass

    def log_message(self, *_a):
        pass


@pytest.mark.parametrize("cls", [OllamaClient, OpenAICompatibleClient])
def test_cancel_interrupts_a_blocking_request(cls):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Slow)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        client = cls(LLMSettings(base_url=f"http://127.0.0.1:{server.server_address[1]}"))
        cancel = threading.Event()
        threading.Timer(0.3, cancel.set).start()
        t0 = time.monotonic()
        with pytest.raises(CancelledError):
            client.chat_plain([], model="m", cancel=cancel)
        assert time.monotonic() - t0 < 3  # antes esperaba la respuesta entera (hasta timeout_s = 600 s)
    finally:
        server.shutdown()


# -- descargas parciales de modelos ----------------------------------------------------------------------------------

def test_incomplete_downloads_are_listed_counted_and_removable(tmp_path):
    from starblitz_engine.llm.library import LLMLibrary, _partial_bytes

    lib = LLMLibrary(tmp_path)
    part = tmp_path / "tiny-q4" / "Tiny-Q4_K_M.gguf.part"
    part.parent.mkdir()
    part.write_bytes(b"x" * 1000)
    assert lib.incomplete() == [{"id": "tiny-q4", "bytes": 1000}]  # antes no aparecía en ningún sitio
    assert lib.disk_usage() == 1000
    assert _partial_bytes(part.parent / "Tiny-Q4_K_M.gguf", 5000) == 1000  # se descuenta al comprobar el espacio
    lib.remove("tiny-q4")
    assert lib.incomplete() == [] and not part.parent.exists()
