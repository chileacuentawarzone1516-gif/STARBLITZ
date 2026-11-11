"""Localización del globo que contiene cada bloque de texto.

Método clásico y determinista: se elimina el texto, se segmenta la zona del
color de fondo que rodea al texto y se toma la componente conexa que lo
contiene. Si queda acotada (no se "derrama" por la viñeta) es un globo:
su interior define el área donde maquetar la traducción y su color de fondo
permite borrar el texto sin tocar el dibujo.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .detector import DetectedBlock


@dataclass
class BubbleInfo:
    polygon: list[list[int]]          # contorno simplificado del interior del globo
    bbox: tuple[int, int, int, int]
    fill: tuple[int, int, int]        # color de fondo (RGB)
    uniform: bool                     # fondo liso: se puede rellenar sin inpainting


def text_ring_stats(img_bgr: np.ndarray, text_mask: np.ndarray, bbox) -> tuple[np.ndarray, float]:
    """Color medio y dispersión del anillo de píxeles alrededor del texto."""
    x1, y1, x2, y2 = bbox
    pad = max(4, int(0.15 * min(x2 - x1, y2 - y1)))
    h, w = text_mask.shape
    sx1, sy1, sx2, sy2 = max(0, x1 - pad), max(0, y1 - pad), min(w, x2 + pad), min(h, y2 + pad)
    sub_mask = text_mask[sy1:sy2, sx1:sx2]
    dil = cv2.dilate(sub_mask, np.ones((5, 5), np.uint8), iterations=2)
    ring = (dil == 0)
    pixels = img_bgr[sy1:sy2, sx1:sx2][ring]
    if len(pixels) < 20:
        pixels = img_bgr[sy1:sy2, sx1:sx2].reshape(-1, 3)
    median = np.median(pixels, axis=0)
    spread = float(np.mean(np.abs(pixels.astype(np.float32) - median)))
    return median, spread


PAPER_MIN_PIXELS = 30
PAPER_MAX_SPREAD = 22.0


def robust_spread(pixels: np.ndarray, median: np.ndarray) -> float:
    """Dispersión robusta: mediana de la mayor desviación por canal respecto a la mediana.

    La media de las desviaciones (lo que se usaba) la inflan los píxeles de antialias de las letras: en un globo blanco con texto
    denso daba 23 > 22 y se descartaba el papel (medido el 2026-11-10 en 93 de 301 globos del capítulo real)."""
    if len(pixels) == 0:
        return 0.0
    return float(np.median(np.abs(pixels.astype(np.float64) - median).max(axis=1)))


def paper_stats(img_bgr: np.ndarray, text_mask: np.ndarray, bbox) -> tuple[np.ndarray, float] | None:
    """Color del «papel» que se ve ENTRE las letras, dentro del propio bloque (sin los trazos ni su borde).

    Es el fondo real sobre el que está escrito el texto. El anillo exterior de `text_ring_stats` falla con los globos
    ajustados al texto (cómic occidental): cruza el contorno del globo y mide el dibujo de alrededor (medido el
    2026-11-09: un globo blanco daba fondo verde con dispersión 108 y el «globo» encontrado era la silueta del texto).
    """
    x1, y1, x2, y2 = bbox
    sub = text_mask[y1:y2, x1:x2]
    if sub.size == 0:
        return None
    dil = cv2.dilate(sub, np.ones((3, 3), np.uint8), iterations=1)
    pixels = img_bgr[y1:y2, x1:x2][dil == 0]
    if len(pixels) < PAPER_MIN_PIXELS:
        return None
    median = np.median(pixels, axis=0)
    return median, robust_spread(pixels, median)


def text_tone(img_bgr: np.ndarray, text_mask: np.ndarray, bbox, bubble: "BubbleInfo | None", ring: np.ndarray) -> float:
    """Luminosidad media (0–255) del fondo sobre el que se rotula: decide si la letra va en blanco o en negro.

    Se usaba siempre el anillo exterior: en los globos llenos de texto cae sobre la viñeta (negra) y la traducción salía en
    BLANCO dentro de un globo blanco, ilegible (12 regiones del capítulo real, 2026-11-10). Orden: papel entre letras si es liso,
    color del globo, anillo."""
    paper = paper_stats(img_bgr, text_mask, bbox)
    if paper is not None and paper[1] < PAPER_MAX_SPREAD:
        return float(np.mean(paper[0]))
    if bubble is not None:
        return float(np.mean(bubble.fill))
    return float(np.mean(ring))


def bubble_background(img_bgr: np.ndarray, text_mask: np.ndarray, bbox) -> tuple[np.ndarray, float]:
    """Fondo para buscar el globo: el papel entre letras si es liso; si no, el anillo alrededor del texto."""
    paper = paper_stats(img_bgr, text_mask, bbox)
    if paper is not None and paper[1] < PAPER_MAX_SPREAD:
        return paper
    return text_ring_stats(img_bgr, text_mask, bbox)


# Búsqueda AMPLIADA: un globo grande con poco texto (una línea, o estilo manga) mide más de 6× su bloque y la búsqueda normal lo
# descarta. Se usa para agrupar líneas sueltas (detector experimental) y, en el pipeline, como segundo intento EXCLUSIVO: solo se
# acepta si el globo no contiene el texto de ninguna otra región (así nunca se toma una viñeta entera con varios textos).
WIDE_WINDOW = 4.0
WIDE_MAX_AREA = 40.0
WIDE_MIN_MARGIN = 2.5  # × el lado mayor del bloque: una línea ancha y baja necesita una ventana alta para ver su globo
GROUP_MIN_MARGIN = 1.0  # al agrupar líneas del detector experimental basta 1× (misma agrupación en el corpus, 38 % más rápido)
TAIL_CORE_COVER = 0.6  # tras cortar la cola, el globo debe seguir cubriendo al menos este tanto del bloque de texto


def point_in_polygon(x: float, y: float, polygon) -> bool:
    """Regla par-impar (la misma cuenta en TypeScript)."""
    inside = False
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def find_bubble_wide(img_bgr: np.ndarray, text_mask: np.ndarray, block: DetectedBlock, margin: float = WIDE_MIN_MARGIN
                     ) -> BubbleInfo | None:
    x1, y1, x2, y2 = block.bbox
    return find_bubble(img_bgr, text_mask, block, window=WIDE_WINDOW, max_area_ratio=WIDE_MAX_AREA,
                       min_margin=int(margin * max(x2 - x1, y2 - y1)))


def find_bubble_exclusive(img_bgr: np.ndarray, text_mask: np.ndarray, block: DetectedBlock,
                          others: list[tuple[float, float]]) -> BubbleInfo | None:
    """Globo del bloque: búsqueda normal y, si falla, la ampliada siempre que no contenga el centro de otro texto."""
    bubble = find_bubble(img_bgr, text_mask, block)
    if bubble is not None:
        return bubble
    wide = find_bubble_wide(img_bgr, text_mask, block)
    if wide is not None and not any(point_in_polygon(cx, cy, wide.polygon) for cx, cy in others):
        return wide
    return None


def find_bubble(img_bgr: np.ndarray, text_mask: np.ndarray, block: DetectedBlock, *, window: float = 1.6,
                max_area_ratio: float = 6.0, min_margin: int = 0) -> BubbleInfo | None:
    """Globo que contiene el bloque. `window` y `max_area_ratio` (búsqueda y tamaño máximo respecto al bloque) solo se amplían para
    agrupar líneas sueltas de un mismo globo (detector experimental); el pipeline usa los valores por defecto."""
    h, w = img_bgr.shape[:2]
    x1, y1, x2, y2 = block.bbox
    bw, bh = x2 - x1, y2 - y1
    if bw < 4 or bh < 4:
        return None
    bg, spread = bubble_background(img_bgr, text_mask, block.bbox)
    uniform = spread < 12.0

    # Ventana de búsqueda acotada: un globo rara vez supera ~3x el bloque de texto.
    mx, my = max(int(bw * window) + 20, min_margin), max(int(bh * window) + 20, min_margin)
    wx1, wy1, wx2, wy2 = max(0, x1 - mx), max(0, y1 - my), min(w, x2 + mx), min(h, y2 + my)
    win = img_bgr[wy1:wy2, wx1:wx2].astype(np.int16)
    tol = 38 if uniform else 26
    similar = (np.abs(win - bg.astype(np.int16)).max(axis=2) <= tol).astype(np.uint8)

    # El propio texto (y un margen) cuenta como fondo para que no parta el globo.
    tm = text_mask[wy1:wy2, wx1:wx2]
    tm = cv2.dilate(tm, np.ones((3, 3), np.uint8), iterations=2)
    inside = np.zeros_like(similar)
    inside[y1 - wy1:y2 - wy1, x1 - wx1:x2 - wx1] = 1
    similar[(tm > 0) & (inside > 0)] = 1
    similar = cv2.morphologyEx(similar, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

    n, labels, stats, _ = cv2.connectedComponentsWithStats(similar, connectivity=4)
    if n <= 1:
        return None
    core = labels[y1 - wy1:y2 - wy1, x1 - wx1:x2 - wx1]
    counts = np.bincount(core.ravel(), minlength=n)
    counts[0] = 0
    label = int(counts.argmax())
    if counts[label] < 0.35 * core.size:
        return None
    cx, cy, cw, ch, area = stats[label]
    ww, wh = wx2 - wx1, wy2 - wy1
    # Si la componente llega al borde de la ventana (salvo que sea el borde de la página),
    # se ha "derramado" por la viñeta: no es un globo cerrado.
    for edge_hit, page_edge in (
        (cx <= 0, wx1 == 0), (cy <= 0, wy1 == 0), (cx + cw >= ww, wx2 == w), (cy + ch >= wh, wy2 == h)
    ):
        if edge_hit and not page_edge:
            return None
    if area > max_area_ratio * bw * bh:
        return None

    comp = (labels == label).astype(np.uint8) * 255
    comp = cv2.morphologyEx(comp, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    # La COLA del globo rompe la prueba de convexidad (un globo lleno de texto con cola daba 0,74 < 0,82 y no se reconocía).
    # Una apertura del tamaño de la letra la corta; solo se usa si lo que queda sigue cubriendo el bloque de texto.
    k = max(5, int(block.line_size * 0.9 + 0.5) | 1)
    opened = cv2.morphologyEx(comp, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    if float(opened[y1 - wy1:y2 - wy1, x1 - wx1:x2 - wx1].mean()) > TAIL_CORE_COVER * 255:
        comp = opened
    contours, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    # Los globos son casi convexos; una forma irregular indica que se coló en el dibujo.
    hull_area = cv2.contourArea(cv2.convexHull(contour))
    if hull_area <= 0 or cv2.contourArea(contour) / hull_area < 0.82:
        return None
    eps = 0.006 * cv2.arcLength(contour, True)
    poly = cv2.approxPolyDP(contour, eps, True).reshape(-1, 2) + [wx1, wy1]
    if len(poly) < 3:
        return None
    px1, py1 = poly.min(axis=0)
    px2, py2 = poly.max(axis=0)
    # El globo CONTIENE su texto. Si no (p. ej. una onomatopeya enorme en un estallido: la apertura deja una forma desplazada),
    # no es su globo: aceptarlo convertía la onomatopeya en «diálogo» y se borraba a medias (2026-11-10).
    slack = max(4.0, block.line_size * 0.25)
    if px1 > x1 + slack or py1 > y1 + slack or px2 < x2 - slack or py2 < y2 - slack:
        return None
    fill = (int(bg[2]), int(bg[1]), int(bg[0]))
    return BubbleInfo(
        polygon=poly.astype(int).tolist(),
        bbox=(int(px1), int(py1), int(px2), int(py2)),
        fill=fill,
        uniform=uniform,
    )
