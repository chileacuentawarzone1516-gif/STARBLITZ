import io
import os
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

TESTDATA = Path(os.environ.get("STARBLITZ_TESTDATA", Path(__file__).resolve().parent / "data"))
DETECTOR = Path(os.environ.get("STARBLITZ_DETECTOR", Path.home() / "models" / "comictextdetector.pt.onnx"))


def make_png(color=(255, 255, 255), size=(400, 600), text: str | None = None) -> bytes:
    img = Image.new("RGB", size, color)
    if text:
        d = ImageDraw.Draw(img)
        d.ellipse((60, 60, 340, 260), outline=(0, 0, 0), width=4, fill=(255, 255, 255))
        d.text((120, 140), text, fill=(0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def png_factory():
    return make_png


@pytest.fixture
def detector_path() -> Path:
    if not DETECTOR.is_file():
        pytest.skip("sin modelo de detección (STARBLITZ_DETECTOR)")
    return DETECTOR


@pytest.fixture(scope="session")
def fake_hf_server():
    """Hugging Face simulado en un puerto libre; las pruebas lo seleccionan con HF_ENDPOINT."""
    import socket

    import fake_hf

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = fake_hf.serve(port)
    yield fake_hf, f"http://127.0.0.1:{port}"
    server.should_exit = True


@pytest.fixture
def hf_endpoint(fake_hf_server, monkeypatch):
    mod, url = fake_hf_server
    monkeypatch.setenv("HF_ENDPOINT", url)
    mod.STATE["fail_once"].clear()
    mod.STATE["corrupt"].clear()
    mod.STATE["requests"].clear()
    return mod, url


def make_fake_llama_dir(directory: Path) -> Path:
    """Carpeta con un ``llama-server`` ejecutable que lanza el servidor simulado."""
    import stat

    directory.mkdir(parents=True, exist_ok=True)
    body = (f"import sys\nsys.path.insert(0, {str(Path(__file__).resolve().parent)!r})\n"
            "import fake_llama_server\nfake_llama_server.main()\n")
    if sys.platform == "win32":
        # Windows no ejecuta scripts con «#!»: se arma un .exe real con el lanzador de consola de distlib (el mismo
        # que usa pip para los «console_scripts»): lanzador + línea «#!» con el intérprete + ZIP con __main__.py.
        import zipfile

        from pip._vendor import distlib

        launcher = (Path(distlib.__file__).parent / "t64.exe").read_bytes()
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as zf:
            zf.writestr("__main__.py", body)
        shebang = f'#!"{sys.executable}"\n'.encode()
        (directory / "llama-server.exe").write_bytes(launcher + shebang + archive.getvalue())
        return directory
    exe = directory / "llama-server"
    exe.write_text(f"#!{sys.executable}\n{body}", encoding="utf-8")
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)
    return directory


@pytest.fixture
def fake_llama_dir(tmp_path, monkeypatch):
    log = tmp_path / "llama-requests.jsonl"
    monkeypatch.setenv("FAKE_LLAMA_LOG", str(log))
    monkeypatch.delenv("FAKE_LLAMA_REJECT", raising=False)
    monkeypatch.delenv("FAKE_LLAMA_CHUNK_DELAY", raising=False)
    return make_fake_llama_dir(tmp_path / "llama"), log


def read_llama_log(log: Path) -> list[dict]:
    import json

    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]


def make_english_page() -> bytes:
    """Página de cómic sintética en inglés (globos con texto en mayúsculas) que el detector real reconoce."""
    from PIL import ImageFont

    font_path = next((p for p in ("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
                                  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf") if Path(p).exists()), None)
    font = ImageFont.truetype(font_path, 34) if font_path else ImageFont.load_default()
    img = Image.new("RGB", (1170, 1654), (255, 255, 255))
    d = ImageDraw.Draw(img)

    def bubble(x, y, w, h, lines):
        d.ellipse((x, y, x + w, y + h), outline=(0, 0, 0), width=5, fill=(255, 255, 255))
        ty = y + h / 2 - len(lines) * 22
        for line in lines:
            d.text((x + w / 2 - d.textlength(line, font=font) / 2, ty), line, fill=(0, 0, 0), font=font)
            ty += 44

    d.rectangle((60, 60, 1110, 760), outline=(0, 0, 0), width=6)
    d.rectangle((60, 800, 1110, 1590), outline=(0, 0, 0), width=6)
    d.ellipse((200, 200, 420, 420), fill=(120, 120, 120))
    d.rectangle((300, 900, 800, 1300), fill=(60, 60, 90))
    bubble(500, 100, 520, 260, ["WHAT ARE YOU", "DOING HERE?!"])
    bubble(120, 520, 560, 240, ["I TOLD YOU NOT", "TO COME BACK."])
    bubble(600, 1250, 480, 260, ["YOU'RE LATE AGAIN,", "IDIOT!"])
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def split_page(path: Path) -> list[bytes]:
    """Tres páginas distintas (no duplicadas) a partir de una real: completa, mitad izquierda y mitad derecha."""
    img = Image.open(path).convert("RGB")
    w, h = img.size
    out = []
    for box in ((0, 0, w, h), (0, 0, w // 2, h), (w // 2, 0, w, h)):
        buf = io.BytesIO()
        img.crop(box).save(buf, "JPEG", quality=92)
        out.append(buf.getvalue())
    return out
