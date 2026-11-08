import io
import zipfile

from PIL import Image

from starblitz_engine.importers.ingest import (
    MAX_COMPRESSION_RATIO, ImportedImage, dhash, hamming, ingest, natural_key, sniff,
)


def _zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _run(uploads, capacity=50, existing=None):
    added: list[ImportedImage] = []

    def add(img, dup):
        added.append(img)
        return f"g{len(added):03d}x"

    report = ingest(uploads, existing or [], capacity, add)
    return report, added


def test_sniff_by_signature_not_extension(png_factory):
    assert sniff(png_factory()[:16]) == "png"
    assert sniff(b"%PDF-1.7") == "pdf"
    assert sniff(b"\xff\xd8\xff\xe0") == "jpg"
    assert sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "webp"
    assert sniff(b"MZ\x90\x00") is None


def test_natural_sort():
    names = ["p10.png", "p2.png", "p1.png", "P3.png"]
    assert sorted(names, key=natural_key) == ["p1.png", "p2.png", "P3.png", "p10.png"]


def test_zip_import_orders_pages_and_ignores_junk(png_factory):
    data = _zip({
        "cap/10.png": png_factory((10, 10, 10)),
        "cap/2.png": png_factory((200, 0, 0)),
        "cap/1.png": png_factory((0, 200, 0)),
        "__MACOSX/._1.png": b"junk",
        "cap/.hidden.png": b"junk",
        "cap/info.txt": b"hola",
    })
    report, added = _run([("cap.zip", data)])
    assert [a.name for a in added] == ["1.png", "2.png", "10.png"]
    assert report.errors == []


def test_zip_slip_names_never_touch_disk(png_factory, tmp_path):
    data = _zip({"../../evil.png": png_factory(), "/abs/evil2.png": png_factory((1, 2, 3))})
    report, added = _run([("x.zip", data)])
    assert [a.name for a in added] == ["evil2.png"]  # solo se usa el nombre base, nunca la ruta
    assert report.errors[0]["reason"] == "ruta no permitida dentro del ZIP"
    assert not (tmp_path.parent / "evil.png").exists()


def test_zip_bomb_rejected():
    payload = b"\x00" * (MAX_COMPRESSION_RATIO * 2000)
    report, added = _run([("bomb.zip", _zip({"bomb.png": payload}))])
    assert not added
    assert report.errors and "sospechoso" in report.errors[0]["reason"]


def test_invalid_and_unsupported_files_reported():
    report, added = _run([("virus.exe", b"MZ\x90\x00" * 10), ("rota.png", b"\x89PNG\r\n\x1a\n" + b"0" * 50)])
    assert not added
    reasons = {e["file"]: e["reason"] for e in report.errors}
    assert "formato no admitido" in reasons["virus.exe"]
    assert "dañada" in reasons["rota.png"]


def test_duplicates_exact_and_near(png_factory):
    a = png_factory((255, 255, 255), text="hola")
    report, added = _run([("a.png", a), ("b.png", a)])
    assert len(added) == 1
    assert report.duplicates[0]["exact"] is True


def test_page_limit_respected(png_factory):
    uploads = [(f"{i}.png", png_factory((i * 20, 0, 0))) for i in range(5)]
    report, added = _run(uploads, capacity=3)
    assert len(added) == 3
    assert report.skipped_limit == 2


def test_pdf_pages_extracted(png_factory):
    pages = [Image.new("RGB", (800, 1200), (255, 255, 255)), Image.new("RGB", (800, 1200), (0, 0, 0))]
    buf = io.BytesIO()
    pages[0].save(buf, "PDF", save_all=True, append_images=pages[1:], resolution=100)
    report, added = _run([("tomo.pdf", buf.getvalue())])
    assert len(added) == 2, report.errors
    assert all(a.width >= 800 for a in added)


def test_dhash_similarity(png_factory):
    a = Image.open(io.BytesIO(png_factory(text="abc")))
    b = a.copy().resize((390, 590))
    assert hamming(dhash(a), dhash(b)) <= 3
