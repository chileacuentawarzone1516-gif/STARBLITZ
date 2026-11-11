"""¿Cabe una traducción en su globo al cuerpo mínimo legible? Con las métricas REALES de las tipografías de rotulación.

Port del núcleo del maquetador de las apps (`apps/shared/src/typeset/layout.ts`): anchura de cada línea según el polígono del
globo (el tramo más estrecho de la línea), margen interior contra el contorno, ajuste de palabras y número de líneas que caben.
Se evalúa solo al cuerpo MÍNIMO de `sizeBounds` (si no cabe ahí, no cabe a ningún tamaño) y se prueban las mismas alternativas que
el maquetador: tipografía propia y condensada, margen normal y el estrecho de último recurso. No parte palabras con guion (el
maquetador sí puede): la respuesta es prudente, nunca dice «cabe» de algo que no cabría.

Sirve para decidir cuándo pedir una reformulación breve y para aceptarla solo si entonces cabe. El rotulado final sigue siendo
el del lienzo de las apps. Misma lógica en `apps/mobile/src/engine/translate/fit.ts` (casos de paridad).
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

_METRICS = json.loads((Path(__file__).with_name("glyph_metrics.json")).read_text(encoding="utf-8"))["roles"]

CONDENSED_ROLE = "narration"
# Tope fijo del cuerpo mínimo (igual que `MIN_FONT_CAP` en render.ts): 0,72 % de la página (21,6 px en 3 000): el 10 % de la letra de diálogo del propio capítulo de prueba mide ≤ 22 px, así que sigue dentro de lo que el original ya usa; con 0,8 % no cabían «¿POR QUÉ?», «¿SEÑOR?»… (2026-11-10).
MIN_FONT_CAP = 0.0072
BUBBLE_PADDING = 0.28        # igual que `layoutRegion` (render.ts)
TIGHT_BUBBLE_PADDING = 0.14  # último intento en un globo (render.ts)
FREE_PADDING = 0.15          # sin globo


def min_font_size(line_size: float, page_height: int) -> float:
    """Cuerpo mínimo de `sizeBounds`: hasta el 75 % del original, entre el 0,5 % y el 0,8 % de la página."""
    fixed = max(8.0, page_height * MIN_FONT_CAP)
    relative = line_size * 0.75 if line_size > 0 else fixed
    return max(8.0, page_height * 0.005, min(fixed, relative))


def text_width(text: str, size: float, role: str) -> float:
    adv = _METRICS.get(role) or _METRICS["dialogue"]
    default = adv["_default"]
    return sum(adv.get(c, default) for c in text) * size


def _span(polygon, y: float) -> tuple[float, float] | None:
    """Tramo horizontal más ancho del polígono a la altura `y` (igual que `polygonSpan`)."""
    xs = []
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if (y1 <= y < y2) or (y2 <= y < y1):
            xs.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
    if len(xs) < 2:
        return None
    xs.sort()
    best = None
    for i in range(0, len(xs) - 1, 2):
        if best is None or xs[i + 1] - xs[i] > best[1] - best[0]:
            best = (xs[i], xs[i + 1])
    return best


def _widths(box, polygon, size: float, line_height: float, count: int, pad_em: float, pad_box: bool) -> list[float]:
    x1, y1, x2, y2 = box
    lh = size * line_height
    top = y1 + (y2 - y1 - lh * count) / 2
    pad = size * pad_em
    out = []
    for i in range(count):
        line_top = top + i * lh
        left, right = x1 + (pad if pad_box else 0), x2 - (pad if pad_box else 0)
        if polygon and len(polygon) >= 3:
            spans = [s for s in (_span(polygon, line_top + lh * 0.15), _span(polygon, line_top + lh * 0.85),
                                 _span(polygon, line_top + lh / 2)) if s]
            if spans:
                left = max(left, max(s[0] for s in spans) + pad)
                right = min(right, min(s[1] for s in spans) - pad)
            else:
                right = left
        out.append(max(0.0, right - left))
    return out


def _wrap(paragraphs: list[list[str]], size: float, role: str, widths: list[float]) -> list[str] | None:
    space = text_width(" ", size, role)
    lines: list[str] = []
    li = 0
    for words in paragraphs:
        cur, cur_w = "", 0.0
        for word in words:
            w = text_width(word, size, role)
            limit = widths[min(li, len(widths) - 1)]
            cand = cur_w + space + w if cur else w
            if cand <= limit:
                cur, cur_w = (f"{cur} {word}" if cur else word), cand
                continue
            if cur:
                lines.append(cur)
                li += 1
            if w > widths[min(li, len(widths) - 1)]:
                return None  # la palabra no cabe entera en la línea (sin partirla)
            cur, cur_w = word, w
        if cur:
            lines.append(cur)
            li += 1
    return lines


def _fits_at(text: str, box, polygon, size: float, line_height: float, role: str, pad_em: float, pad_box: bool) -> bool:
    paragraphs = [p.split(" ") for p in text.split("\n")]
    paragraphs = [[w for w in p if w] for p in paragraphs]
    _, y1, _, y2 = box
    lh = size * line_height
    max_lines = max(1, math.floor((y2 - y1) / lh + 1e-6))
    count = min(max_lines, max(1, len(paragraphs)))
    for _ in range(6):
        lines = _wrap(paragraphs, size, role, _widths(box, polygon, size, line_height, count, pad_em, pad_box))
        if lines is None:
            return False
        if len(lines) == count:
            return True
        if len(lines) > max_lines:
            return False
        count = len(lines)
    return False


def normalize(text: str, uppercase: bool = False) -> str:
    t = re.sub(r" *\n *", "\n", re.sub(r"[ \t]+", " ", text.replace("\r", ""))).strip()
    return t.upper() if uppercase else t


def fits(text: str, *, layout_box, polygon, line_size: float, page_height: int, role: str = "dialogue",
         line_height: float = 1.12, uppercase: bool = False) -> bool:
    """¿Cabe `text` al cuerpo mínimo con alguna de las alternativas del maquetador?"""
    t = normalize(text, uppercase)
    if not t:
        return True
    size = min_font_size(line_size, page_height)
    roles = [role] if role == CONDENSED_ROLE else [role, CONDENSED_ROLE]
    pads = [(BUBBLE_PADDING, False), (TIGHT_BUBBLE_PADDING, False)] if polygon else [(FREE_PADDING, True)]
    return any(_fits_at(t, layout_box, polygon, size, line_height, r, p, pb) for p, pb in pads for r in roles)


def fit_chars(region, text: str, page_height: int) -> int:
    """Caracteres del comienzo más largo de `text` (cortado entre palabras) que cabe: el objetivo de la reformulación."""
    words = normalize(text).split(" ")
    best = 0
    for k in range(1, len(words) + 1):
        prefix = " ".join(words[:k])
        if not region_fits(region, prefix, page_height):
            break
        best = len(prefix)
    return best


def region_fits(region, text: str, page_height: int) -> bool:
    """`fits` con los datos de una región del proyecto (caja, globo, cuerpo original y estilo)."""
    s = region.style
    return fits(text, layout_box=tuple(region.layout_box), polygon=region.bubble.polygon if region.bubble else None,
                line_size=region.line_size, page_height=page_height, role=s.font, line_height=s.line_height,
                uppercase=s.uppercase)
