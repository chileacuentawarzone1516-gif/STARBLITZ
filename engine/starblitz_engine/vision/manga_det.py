"""Detector de texto EXPERIMENTAL: líneas de PP-OCRv6 Manga (`manga_det`, Apache-2.0 declarada).

Qué hace el MODELO: solo un mapa de probabilidad de líneas de texto (cabeza DB). Nada más.
Qué hace ESTE MÓDULO (código propio de STARBLITZ, no del modelo):
  * post-procesado DB (umbral, puntuación por contorno, expansión «unclip») → polígonos de línea;
  * agrupación de líneas en bloques/párrafos (`_cluster_lines`, la misma regla que el detector actual usa
    para el texto fuera de globos);
  * máscara de píxeles de texto: dentro de cada polígono de línea se separan trazos y fondo por Otsu
    (el modelo no da una máscara de trazos como la U-Net de comic-text-detector).
La asociación con globos y el orden de lectura NO cambian: los hace el resto del pipeline (`bubbles.py`,
`layout.py`) igual que con el detector por defecto.

Parámetros de la ficha del modelo (revisión v0.3): `thresh=0.15`,
`box_thresh=0.25`, `unclip_ratio=1.5`; lado largo 1600 (la ficha dice 960: ver LONG_SIDE). Entrada BGR normalizada (ImageNet).
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from ..core.onnx import Device, create_session
from .detector import (DetectedBlock, _cluster_lines, _dedupe_across, _line_geometry, _order_points, _poly_bbox,
                       tile_spans)

# La ficha recomienda 960, pero con la rotulación pequeña de un cómic occidental (dobles páginas de 3000 px) a 960 el modelo no ve
# la mitad de las líneas: medido el 2026-11-09 en una doble página real, 106/208 palabras de referencia a 960 frente a 207/208 a
# 1600, sin perder nada en las demás páginas probadas. A 1600 sigue siendo mucho más ligero que el detector por defecto (1024 con
# tres cabezas). Con manga japonés NO está medido.
LONG_SIDE = 1600
BIN_THRESH = 0.15
BOX_THRESH = 0.25
UNCLIP_RATIO = 1.5
MIN_SIDE = 3          # px del mapa: líneas más finas son ruido
MAX_CONTOURS = 3000
MASK_DILATE = 2       # px de margen alrededor de los trazos (antialias del rotulado original)
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


class MangaLineDetector:
    """Misma interfaz que `TextDetector.detect`: (bloques, máscara uint8 0/255 a resolución original)."""

    kind = "manga-det"

    def __init__(self, model_path: Path, device: Device = "auto"):
        self.session = create_session(model_path, device)
        self.input_name = self.session.get_inputs()[0].name

    def detect(self, img_bgr: np.ndarray) -> tuple[list[DetectedBlock], np.ndarray]:
        h, w = img_bgr.shape[:2]
        along_y = h >= w
        spans = tile_spans(max(h, w), min(h, w))
        if len(spans) == 1:
            lines, scores = self.detect_lines(img_bgr)
        else:  # tiras largas: por tramos, como el detector por defecto (no se reduce la tira entera a 960 px)
            lines, scores, part_of = [], [], []
            axis = 1 if along_y else 0
            for k, (start, end, own_start, own_end) in enumerate(spans):
                crop = img_bgr[start:end] if along_y else img_bgr[:, start:end]
                ls, ss = self.detect_lines(crop)
                for poly, s in zip(ls, ss):
                    poly = poly.copy()
                    poly[:, axis] += start
                    if own_start <= poly[:, axis].mean() < own_end:
                        lines.append(poly)
                        scores.append(s)
                        part_of.append(k)
            keep = _dedupe_across([np.array(_poly_bbox(p)) for p in lines], part_of, scores)
            lines, scores = [lines[i] for i in keep], [scores[i] for i in keep]
        mask = line_mask(img_bgr, lines)
        return merge_by_bubble(img_bgr, mask, group_lines(lines, scores, w, h), w, h), mask

    # ------------------------------------------------------------------
    def probability(self, img_bgr: np.ndarray) -> tuple[np.ndarray, float, float]:
        """Mapa de probabilidad del modelo y factores de escala (ancho, alto) mapa → imagen."""
        h, w = img_bgr.shape[:2]
        rw, rh = input_size(w, h)
        x = cv2.resize(img_bgr, (rw, rh), interpolation=cv2.INTER_AREA if rw < w else cv2.INTER_LINEAR)
        x = (x.astype(np.float32) / 255.0 - MEAN) / STD
        tensor = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
        prob = self.session.run(None, {self.input_name: tensor})[0][0, 0].astype(np.float32)
        return prob, w / rw, h / rh

    def detect_lines(self, img_bgr: np.ndarray) -> tuple[list[np.ndarray], list[float]]:
        prob, sx, sy = self.probability(img_bgr)
        h, w = img_bgr.shape[:2]
        return db_lines(prob, sx, sy, w, h)


def input_size(w: int, h: int) -> tuple[int, int]:
    """Lado largo LONG_SIDE redondeado a múltiplos de 32 (como el ejemplo oficial)."""
    ratio = LONG_SIDE / max(h, w)
    return max(32, int(round(w * ratio / 32) * 32)), max(32, int(round(h * ratio / 32) * 32))


def db_lines(prob: np.ndarray, sx: float, sy: float, w: int, h: int) -> tuple[list[np.ndarray], list[float]]:
    """Post-procesado DB: contornos sobre el umbral, puntuación media y expansión del polígono."""
    bitmap = (prob > BIN_THRESH).astype(np.uint8)
    contours, _ = cv2.findContours(bitmap, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    lines, scores = [], []
    for contour in contours[:MAX_CONTOURS]:
        if len(contour) < 4:
            continue
        x, y, cw, ch = cv2.boundingRect(contour)
        region = np.zeros((ch, cw), np.uint8)
        cv2.fillPoly(region, [contour - [x, y]], 1)
        score = float(cv2.mean(prob[y:y + ch, x:x + cw], region)[0])
        if score < BOX_THRESH:
            continue
        pts = contour.reshape(-1, 2).astype(np.float32)
        area = cv2.contourArea(pts)
        perimeter = cv2.arcLength(pts, True)
        if area <= 0 or perimeter <= 0:
            continue
        (cx, cy), (rw, rh), angle = cv2.minAreaRect(pts)
        d = area * UNCLIP_RATIO / perimeter
        rw, rh = rw + 2 * d, rh + 2 * d
        if min(rw, rh) < MIN_SIDE:
            continue
        box = cv2.boxPoints(((cx, cy), (rw, rh), angle))
        box[:, 0] = (box[:, 0] * sx).clip(0, w)
        box[:, 1] = (box[:, 1] * sy).clip(0, h)
        lines.append(_order_points(box).astype(np.int32))
        scores.append(score)
    return lines, scores


def make_block(group: list[np.ndarray], confidence: float, w: int, h: int) -> DetectedBlock:
    """Bloque a partir de sus líneas: rectángulo, orientación y cuerpo de letra."""
    geoms = [_line_geometry(p) for p in group]
    pts = np.concatenate(group, axis=0)
    x1, y1, x2, y2 = _poly_bbox(pts)
    elongated = [g for g in geoms if g[0] > g[1] * 1.5]
    if elongated:
        vertical = sum(1 for g in elongated if g[2]) * 2 > len(elongated)
    else:
        vertical = (y2 - y1) > (x2 - x1) * 1.2
    return DetectedBlock(bbox=(max(0, x1), max(0, y1), min(w, x2), min(h, y2)), lines=group, vertical=vertical,
                         confidence=confidence, line_size=float(np.median([g[1] for g in geoms])))


def group_lines(lines: list[np.ndarray], scores: list[float], w: int, h: int) -> list[DetectedBlock]:
    """Bloques a partir de líneas (el modelo no detecta bloques ni globos)."""
    score_of = {id(p): s for p, s in zip(lines, scores)}
    blocks: list[DetectedBlock] = []
    for group in _cluster_lines(lines):
        b = make_block(group, float(np.mean([score_of[id(p)] for p in group])), w, h)
        if b.area >= 64:
            blocks.append(b)
    return blocks


# Ruido (números de página, tramas, trazos del dibujo): UNA línea, fuera de globo, mucho más fina que el texto de la página y corta.
# Medido el 2026-11-09: descarta 30 fragmentos de ≤ 3 caracteres y ningún texto más largo (el texto pequeño pero largo se queda).
NOISE_THICKNESS = 0.6
NOISE_MAX_ELONGATION = 4.0


# Coste (medido el 2026-11-09): buscar con la ventana ampliada para CADA bloque costaba ~1,1 s por página. Primero se prueba la
# búsqueda normal (barata), la ampliada solo si falla (margen ≤ 1× el lado mayor), y no se busca el globo de un bloque que ya
# quedó dentro de otro: misma agrupación en el corpus y un 38 % menos de tiempo.


def merge_by_bubble(img_bgr: np.ndarray, mask: np.ndarray, blocks: list[DetectedBlock], w: int, h: int) -> list[DetectedBlock]:
    """Une los bloques que caen dentro del MISMO globo (medido 2026-11-09: el modelo da líneas muy ajustadas y la regla de
    párrafos dejaba cada línea de un globo como un bloque suelto; además un bloque de una línea no encontraba su globo)."""
    from .bubbles import GROUP_MIN_MARGIN, find_bubble, find_bubble_wide, point_in_polygon

    n = len(blocks)
    if n < 2:
        return blocks
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    centers = [((b.bbox[0] + b.bbox[2]) / 2, (b.bbox[1] + b.bbox[3]) / 2) for b in blocks]
    has_bubble = [False] * n
    for i, b in enumerate(blocks):
        if has_bubble[i]:
            continue  # ya está dentro del globo de otro bloque
        bubble = find_bubble(img_bgr, mask, b) or find_bubble_wide(img_bgr, mask, b, GROUP_MIN_MARGIN)
        if bubble is None:
            continue
        has_bubble[i] = True
        for j in range(n):
            if j != i and b.vertical == blocks[j].vertical and point_in_polygon(*centers[j], bubble.polygon):
                parent[find(j)] = find(i)
                has_bubble[j] = True
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    median_line = float(np.median([b.line_size for b in blocks]))
    out: list[DetectedBlock] = []
    for members in sorted(groups.values(), key=lambda m: m[0]):
        if len(members) == 1:
            b = blocks[members[0]]
            long_side = max(b.bbox[2] - b.bbox[0], b.bbox[3] - b.bbox[1])
            if (len(b.lines) == 1 and not has_bubble[members[0]] and b.line_size < NOISE_THICKNESS * median_line
                    and long_side < NOISE_MAX_ELONGATION * b.line_size):
                continue  # ruido: no se convierte en región
            out.append(b)
            continue
        lines = [p for k in members for p in blocks[k].lines]
        weights = [len(blocks[k].lines) for k in members]
        confidence = float(sum(blocks[k].confidence * wk for k, wk in zip(members, weights)) / sum(weights))
        out.append(make_block(lines, confidence, w, h))
    return out


def line_mask(img_bgr: np.ndarray, lines: list[np.ndarray]) -> np.ndarray:
    """Máscara de trazos de texto dentro de cada línea (Otsu local; la clase minoritaria son los trazos)."""
    h, w = img_bgr.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    if not lines:
        return mask
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * MASK_DILATE + 1, 2 * MASK_DILATE + 1))
    for poly in lines:
        x1, y1, x2, y2 = _poly_bbox(poly)
        x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2 + 1), min(h, y2 + 1)
        if x2 - x1 < 2 or y2 - y1 < 2:
            continue
        inside = np.zeros((y2 - y1, x2 - x1), np.uint8)
        cv2.fillPoly(inside, [poly.astype(np.int32) - [x1, y1]], 1)
        crop = gray[y1:y2, x1:x2]
        vals = crop[inside > 0]
        if vals.size < 8 or int(vals.max()) - int(vals.min()) < 24:
            continue  # sin contraste: no hay trazos que separar
        t, _ = cv2.threshold(vals.reshape(-1, 1), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        dark = (crop <= t) & (inside > 0)
        light = (crop > t) & (inside > 0)
        strokes = dark if dark.sum() <= light.sum() else light
        strokes = cv2.dilate(strokes.astype(np.uint8) * 255, kernel)
        strokes[inside == 0] = 0
        np.maximum(mask[y1:y2, x1:x2], strokes, out=mask[y1:y2, x1:x2])
    return mask
