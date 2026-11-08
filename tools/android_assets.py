"""Genera iconos (normales, redondos y adaptables) y la pantalla de arranque de Android desde la marca."""
import subprocess, sys, tempfile
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "apps/mobile/android/app/src/main/res"
BRAND = ROOT / "brand"
DENS = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
tmp = Path(tempfile.mkdtemp())

def render(svg, png, w, h):
    subprocess.run([sys.executable, str(ROOT / "tools/render_svg.py"), str(svg), str(png), str(w), str(h)], check=True)

render(BRAND / "starblitz-icon.svg", tmp / "icon.png", 512, 512)
render(BRAND / "starblitz-adaptive-fg.svg", tmp / "fg.png", 432, 432)
render(BRAND / "starblitz-mark.svg", tmp / "mark.png", 512, 512)
icon = Image.open(tmp / "icon.png").convert("RGBA")
fg = Image.open(tmp / "fg.png").convert("RGBA")
mark = Image.open(tmp / "mark.png").convert("RGBA")

for d, k in DENS.items():
    out = RES / f"mipmap-{d}"
    out.mkdir(parents=True, exist_ok=True)
    s = int(48 * k)
    icon.resize((s, s), Image.LANCZOS).save(out / "ic_launcher.png")
    # Icono redondo: recorte circular del icono
    r = icon.resize((s, s), Image.LANCZOS)
    m = Image.new("L", (s, s), 0)
    from PIL import ImageDraw
    ImageDraw.Draw(m).ellipse((0, 0, s - 1, s - 1), fill=255)
    round_icon = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    round_icon.paste(r, (0, 0), m)
    round_icon.save(out / "ic_launcher_round.png")
    fs = int(108 * k)
    fg.resize((fs, fs), Image.LANCZOS).save(out / "ic_launcher_foreground.png")

# Pantallas de arranque (todas las densidades/orientaciones que crea Capacitor)
for folder in RES.glob("drawable*"):
    target = folder / "splash.png"
    if not target.exists():
        continue
    w, h = Image.open(target).size
    bg = Image.new("RGB", (w, h), (6, 8, 24))
    ms = int(min(w, h) * 0.32)
    mk = mark.resize((ms, ms), Image.LANCZOS)
    bg.paste(mk, ((w - ms) // 2, (h - ms) // 2), mk)
    bg.save(target)
print("Recursos Android generados")
