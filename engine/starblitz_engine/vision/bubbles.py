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


def find_bubble(img_bgr: np.ndarray, text_mask: np.ndarray, block: DetectedBlock) -> BubbleInfo | None:
    h, w = img_bgr.shape[:2]
    x1, y1, x2, y2 = block.bbox
    bw, bh = x2 - x1, y2 - y1
    if bw < 4 or bh < 4:
        return None
    bg, spread = text_ring_stats(img_bgr, text_mask, block.bbox)
    uniform = spread < 12.0

    # Ventana de búsqueda acotada: un globo rara vez supera ~3x el bloque de texto.
    mx, my = int(bw * 1.6) + 20, int(bh * 1.6) + 20
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
    if area > 6 * bw * bh:
        return None

    comp = (labels == label).astype(np.uint8) * 255
    comp = cv2.morphologyEx(comp, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
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
    fill = (int(bg[2]), int(bg[1]), int(bg[0]))
    return BubbleInfo(
        polygon=poly.astype(int).tolist(),
        bbox=(int(px1), int(py1), int(px2), int(py2)),
        fill=fill,
        uniform=uniform,
    )
