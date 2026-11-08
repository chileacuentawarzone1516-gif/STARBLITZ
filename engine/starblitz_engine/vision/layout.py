"""Viñetas y orden de lectura.

Las viñetas se obtienen del "canal" (gutter): el espacio claro conectado con
los márgenes de la página. El orden de lectura se calcula con cortes XY
recursivos, de derecha a izquierda para manga y de izquierda a derecha para
cómic occidental.
"""

from __future__ import annotations

from typing import Literal, Sequence

import cv2
import numpy as np

Box = tuple[int, int, int, int]
Direction = Literal["rtl", "ltr"]


def detect_panels(img_bgr: np.ndarray, min_area_ratio: float = 0.015) -> list[Box]:
    h, w = img_bgr.shape[:2]
    scale = 1000 / max(h, w) if max(h, w) > 1000 else 1.0
    small = cv2.resize(img_bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else img_bgr
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    sh, sw = gray.shape
    light = (cv2.GaussianBlur(gray, (3, 3), 0) > 215).astype(np.uint8)
    flood = light.copy()
    mask = np.zeros((sh + 2, sw + 2), np.uint8)
    for x in range(0, sw, 4):
        for y in (0, sh - 1):
            if flood[y, x] == 1:
                cv2.floodFill(flood, mask, (x, y), 2)
    for y in range(0, sh, 4):
        for x in (0, sw - 1):
            if flood[y, x] == 1:
                cv2.floodFill(flood, mask, (x, y), 2)
    gutter = (flood == 2).astype(np.uint8)
    content = (1 - gutter).astype(np.uint8)
    n, _labels, stats, _ = cv2.connectedComponentsWithStats(content, connectivity=8)
    panels: list[Box] = []
    for i in range(1, n):
        x, y, cw, ch, area = stats[i]
        if area < min_area_ratio * sh * sw or cw < sw * 0.08 or ch < sh * 0.05:
            continue
        panels.append((int(x / scale), int(y / scale), int((x + cw) / scale), int((y + ch) / scale)))
    # Un único "panel" que ocupa casi toda la página no aporta información.
    if len(panels) == 1:
        x1, y1, x2, y2 = panels[0]
        if (x2 - x1) * (y2 - y1) > 0.85 * h * w:
            return []
    return panels


def xy_cut_order(boxes: Sequence[Box], direction: Direction) -> list[int]:
    """Índices de `boxes` en orden de lectura mediante cortes XY recursivos."""
    idx = list(range(len(boxes)))

    def recurse(items: list[int]) -> list[int]:
        if len(items) <= 1:
            return items
        # 1) corte horizontal (filas), de arriba abajo
        rows = _split(items, boxes, axis=1)
        if len(rows) > 1:
            return [i for group in rows for i in recurse(group)]
        # 2) corte vertical (columnas)
        cols = _split(items, boxes, axis=0)
        if len(cols) > 1:
            if direction == "rtl":
                cols = cols[::-1]
            return [i for group in cols for i in recurse(group)]
        # 3) sin cortes limpios: orden por posición
        sign = -1 if direction == "rtl" else 1
        return sorted(items, key=lambda i: (boxes[i][1] + boxes[i][3], sign * (boxes[i][0] + boxes[i][2])))

    return recurse(idx)


def _split(items: list[int], boxes: Sequence[Box], axis: int) -> list[list[int]]:
    lo, hi = (0, 2) if axis == 0 else (1, 3)
    spans = sorted(items, key=lambda i: boxes[i][lo])
    groups: list[list[int]] = []
    g_start = g_end = 0
    for i in spans:
        start, end = boxes[i][lo], boxes[i][hi]
        if groups:
            overlap = g_end - start
            # Se toleran solapes pequeños (globos o arte que invaden el canal entre viñetas).
            if overlap > 0.25 * min(end - start, g_end - g_start):
                groups[-1].append(i)
                g_end = max(g_end, end)
                continue
        groups.append([i])
        g_start, g_end = start, end
    return groups


def reading_order(blocks: Sequence[Box], panels: Sequence[Box], direction: Direction) -> list[int]:
    """Ordena bloques: primero por viñeta y después dentro de cada viñeta."""
    if not panels:
        return xy_cut_order(blocks, direction)
    regions: list[Box] = list(panels)

    def containing(b: Box) -> int:
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        best, best_area = -1, float("inf")
        for ri, p in enumerate(regions):
            if p[0] <= cx <= p[2] and p[1] <= cy <= p[3]:
                area = (p[2] - p[0]) * (p[3] - p[1])
                if area < best_area:
                    best, best_area = ri, area
        return best

    groups: dict[int, list[int]] = {}
    # Los bloques fuera de cualquier viñeta (texto en el canal, notas del autor) forman
    # pseudo-viñetas; los más grandes primero para que contengan a los pequeños.
    for bi in sorted(range(len(blocks)), key=lambda i: -(blocks[i][2] - blocks[i][0]) * (blocks[i][3] - blocks[i][1])):
        ri = containing(blocks[bi])
        if ri < 0:
            regions.append(blocks[bi])
            ri = len(regions) - 1
        groups.setdefault(ri, []).append(bi)
    region_order = xy_cut_order(regions, direction)
    rank = {p: r for r, p in enumerate(region_order)}
    ordered: list[int] = []
    for pi in sorted(groups, key=lambda p: rank[p]):
        members = groups[pi]
        sub = xy_cut_order([blocks[i] for i in members], direction)
        ordered.extend(members[k] for k in sub)
    return ordered
