"""Exporta el avance de cada carácter (en «em») de las tipografías de rotulación, medido con FreeType sobre los WOFF2 de la app.

Lo usan los dos motores (Python y TypeScript) para saber, ANTES de rotular, si una traducción cabe en su globo al cuerpo mínimo
legible (`translate/fit.py` y `translate/fit.ts`) y pedir entonces una reformulación más corta. El rotulado final lo sigue
decidiendo el maquetador de las apps con el lienzo (`typeset/layout.ts`); esta medida es la misma tipografía, sin interletraje.

Genera (mismo contenido): engine/starblitz_engine/translate/glyph_metrics.json y apps/mobile/src/engine/translate/glyph_metrics.json
Uso: python tools/export_glyph_metrics.py
"""
import json
from pathlib import Path

from PIL import ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONTS = ROOT / "apps" / "shared" / "src" / "assets" / "fonts"
# Papel tipográfico → archivo (peso normal, como `cssFont` sin negrita). Igual que FONT_ROLES en typeset/fonts.ts.
ROLES = {
    "dialogue": "shantell-sans-latin-500-normal.woff2",
    "narration": "barlow-semi-condensed-latin-500-normal.woff2",
    "shout": "bangers-latin-400-normal.woff2",
    "whisper": "comic-neue-latin-400-normal.woff2",
    "handwritten": "patrick-hand-latin-400-normal.woff2",
    "sfx": "bangers-latin-400-normal.woff2",
}
CHARS = "".join(chr(c) for c in range(32, 127)) + "ÁÉÍÓÚÜÑáéíóúüñ¿¡«»…—–‘’“”·ºª€"
SIZE = 1000
OUTS = [ROOT / "engine" / "starblitz_engine" / "translate" / "glyph_metrics.json",
        ROOT / "apps" / "mobile" / "src" / "engine" / "translate" / "glyph_metrics.json"]


def main() -> None:
    out = {"_note": "Avance por carácter en em (FreeType, sin interletraje). Generado por tools/export_glyph_metrics.py.", "roles": {}}
    for role, file in ROLES.items():
        font = ImageFont.truetype(str(FONTS / file), SIZE)
        adv = {c: round(font.getlength(c) / SIZE, 4) for c in CHARS}
        letters = [adv[c] for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"]
        adv["_default"] = round(sum(letters) / len(letters), 4)  # para caracteres que no están en la tabla
        out["roles"][role] = adv
    text = json.dumps(out, ensure_ascii=False, indent=0, sort_keys=True) + "\n"
    for p in OUTS:
        p.write_text(text, encoding="utf-8")
    print("métricas exportadas:", ", ".join(out["roles"]))


if __name__ == "__main__":
    main()
