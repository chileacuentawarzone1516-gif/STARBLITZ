"""Genera la identidad visual de STARBLITZ (SVG vectorial + PNG/ICO).

El logotipo es original: una «S» itálica de trazo angular (rayo) dentro de un
rombo de neón, con un destello de cuatro puntas. La palabra STARBLITZ se
convierte a trazados para que el SVG no dependa de fuentes instaladas.
"""

from __future__ import annotations

import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

OUT = Path(sys.argv[1])
FONT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

SKEW = 0.2


def s_path(cx=256.0, cy=256.0, scale=1.0) -> str:
    pts = [(196, 136), (352, 136), (328, 176), (216, 176), (216, 236), (316, 236), (336, 256), (336, 356),
           (316, 376), (160, 376), (184, 336), (296, 336), (296, 276), (196, 276), (176, 256), (176, 156)]
    out = []
    for x, y in pts:
        x2 = (x - 256) * scale + (256 - y) * SKEW * scale + cx
        y2 = (y - 256) * scale + cy
        out.append(f"{x2:.1f},{y2:.1f}")
    return "M" + " L".join(out) + " Z"


def star_path(cx: float, cy: float, r: float) -> str:
    return (f"M{cx:.1f},{cy - r:.1f} Q{cx:.1f},{cy:.1f} {cx + r:.1f},{cy:.1f} Q{cx:.1f},{cy:.1f} {cx:.1f},{cy + r:.1f} "
            f"Q{cx:.1f},{cy:.1f} {cx - r:.1f},{cy:.1f} Q{cx:.1f},{cy:.1f} {cx:.1f},{cy - r:.1f} Z")


def diamond_path(cx: float, cy: float, r: float, corner: float) -> str:
    """Rombo con esquinas redondeadas."""
    pts = [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]
    d = []
    for i, (x, y) in enumerate(pts):
        px, py = pts[i - 1]
        nx, ny = pts[(i + 1) % 4]
        def toward(ax, ay, bx, by, dist):
            vx, vy = bx - ax, by - ay
            ln = (vx * vx + vy * vy) ** 0.5
            return ax + vx / ln * dist, ay + vy / ln * dist
        sx, sy = toward(x, y, px, py, corner)
        ex, ey = toward(x, y, nx, ny, corner)
        d.append(("M" if i == 0 else "L") + f"{sx:.1f},{sy:.1f} Q{x:.1f},{y:.1f} {ex:.1f},{ey:.1f}")
    return " ".join(d) + " Z"


DEFS = """
  <linearGradient id="sbRing" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#38bdf8"/><stop offset=".45" stop-color="#3b6cff"/><stop offset="1" stop-color="#a855f7"/>
  </linearGradient>
  <linearGradient id="sbS" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#e0f2ff"/><stop offset=".35" stop-color="#60a5fa"/><stop offset=".75" stop-color="#6d5dfc"/><stop offset="1" stop-color="#c084fc"/>
  </linearGradient>
  <radialGradient id="sbBg" cx=".5" cy=".38" r=".75">
    <stop offset="0" stop-color="#1b2160"/><stop offset=".55" stop-color="#0b0e2e"/><stop offset="1" stop-color="#05061a"/>
  </radialGradient>
  <filter id="sbGlow" x="-40%" y="-40%" width="180%" height="180%">
    <feGaussianBlur stdDeviation="10" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="sbSoft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
"""


def mark(cx=256, cy=256, scale=1.0, glow=True) -> str:
    ring = diamond_path(cx, cy, 214 * scale, 46 * scale)
    g = ' filter="url(#sbGlow)"' if glow else ""
    return f"""
  <path d="{ring}" fill="none" stroke="url(#sbRing)" stroke-width="{22 * scale:.1f}" stroke-linejoin="round"{g}/>
  <path d="{s_path(cx, cy + 6 * scale, 0.98 * scale)}" fill="url(#sbS)"{g}/>
  <path d="{star_path(cx + 118 * scale, cy - 128 * scale, 44 * scale)}" fill="#a78bfa" filter="url(#sbSoft)" opacity=".9"/>
  <path d="{star_path(cx + 118 * scale, cy - 128 * scale, 38 * scale)}" fill="#ffffff"/>"""


def wordmark(text: str, x: float, y: float, height: float) -> tuple[str, float]:
    font = TTFont(FONT)
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    upm = font["head"].unitsPerEm
    cap = font["OS/2"].sCapHeight or upm * 0.7
    s = height / cap
    paths, pen_x = [], 0.0
    for ch in text:
        gname = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        # Escala, invierte el eje Y y aplica la itálica de marca.
        tp = TransformPen(pen, (s, 0, -s * SKEW * 0.9, -s, x + pen_x, y))
        gs[gname].draw(tp)
        paths.append(pen.getCommands())
        pen_x += gs[gname].width * s + height * 0.06
    return " ".join(paths), pen_x


def write(name: str, body: str, w: int, h: int, bg: str = "") -> None:
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}"><defs>{DEFS}</defs>{bg}{body}\n</svg>\n'
    (OUT / name).write_text(svg, encoding="utf-8")


# Marca sola (fondo transparente)
write("starblitz-mark.svg", mark(), 512, 512)
# Icono de aplicación (fondo redondeado)
write("starblitz-icon.svg", mark(256, 256, 0.86), 512, 512,
      bg='<rect width="512" height="512" rx="112" fill="url(#sbBg)"/><rect x="6" y="6" width="500" height="500" rx="106" fill="none" stroke="#3b6cff" stroke-opacity=".35" stroke-width="2"/>')
# Primer plano del icono adaptable de Android (zona segura 66 %)
write("starblitz-adaptive-fg.svg", mark(256, 256, 0.6), 512, 512)
# Logotipo horizontal
word, ww = wordmark("STARBLITZ", 300, 196, 84)
write("starblitz-logo.svg", mark(128, 128, 0.5) + f'\n  <path d="{word}" fill="url(#sbS)"/>', int(300 + ww + 20), 256)
# Logotipo vertical con lema (pantalla de carga)
word2, ww2 = wordmark("STARBLITZ", 0, 0, 58)
tx = (720 - ww2) / 2
word2, _ = wordmark("STARBLITZ", tx, 552, 58)
write("starblitz-splash.svg", mark(360, 250, 0.82) + f'\n  <path d="{word2}" fill="url(#sbS)" filter="url(#sbGlow)"/>'
      '\n  <text x="360" y="622" text-anchor="middle" font-family="Segoe UI, Inter, Roboto, sans-serif" font-size="26" fill="#a5b4fc" letter-spacing="2">Traduce · Disfruta · Lee sin límites</text>',
      720, 680, bg='<rect width="720" height="680" fill="url(#sbBg)"/>')
print("ok")
