"""Detección de bloques de texto, líneas y máscara de píxeles de texto.

Implementación propia del post-procesado del modelo comic-text-detector
(YOLOv5 para bloques + DBNet para líneas + U-Net para la máscara), ejecutado
con ONNX Runtime. Devuelve bloques agrupados con su orientación y la máscara
de texto a resolución original.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from ..core.onnx import Device, create_session

INPUT_SIZE = 1024
CONF_THRESH = 0.4
NMS_THRESH = 0.35
LINE_BIN_THRESH = 0.3
LINE_SCORE_THRESH = 0.6
UNCLIP_RATIO = 1.5
MASK_THRESH = 0.3


@dataclass
class DetectedBlock:
    bbox: tuple[int, int, int, int]
    lines: list[np.ndarray] = field(default_factory=list)  # polígonos (4, 2) int32
    vertical: bool = False
    confidence: float = 0.0
    lang_hint: str = "unknown"
    line_size: float = 0.0  # tamaño estimado del cuerpo de letra (px)

    @property
    def area(self) -> int:
        x1, y1, x2, y2 = self.bbox
        return max(0, x2 - x1) * max(0, y2 - y1)


class TextDetector:
    LANGS = ("eng", "ja")

    def __init__(self, model_path: Path, device: Device = "auto"):
        self.session = create_session(model_path, device)
        self.input_name = self.session.get_inputs()[0].name
        self.output_names = [o.name for o in self.session.get_outputs()]

    # ------------------------------------------------------------------
    def detect(self, img_bgr: np.ndarray) -> tuple[list[DetectedBlock], np.ndarray]:
        """Detecta el texto de una página.

        Las páginas muy alargadas (tiras de webtoon, dobles páginas panorámicas) se
        analizan por tramos solapados: reducir una tira de 800×12000 a 1024 px dejaría
        el texto en uno o dos píxeles de alto y el modelo no vería nada.
        """
        h, w = img_bgr.shape[:2]
        along_y = h >= w
        spans = tile_spans(max(h, w), min(h, w))
        if len(spans) == 1:
            boxes, confs, classes, lines, prob = self._infer(img_bgr)
        else:
            prob = np.zeros((h, w), np.float32)
            parts: list[tuple[np.ndarray, np.ndarray, np.ndarray, list[np.ndarray]]] = []
            for start, end, own_start, own_end in spans:
                crop = img_bgr[start:end] if along_y else img_bgr[:, start:end]
                b, c, k, ls, p = self._infer(crop)
                window = prob[start:end] if along_y else prob[:, start:end]
                np.maximum(window, p, out=window)
                parts.append(_shift_and_own(b, c, k, ls, start, own_start, own_end, along_y))
            boxes, confs, classes, lines = _merge_parts(parts)

        mask = (prob > MASK_THRESH).astype(np.uint8) * 255
        blocks = _group(boxes, confs, classes, lines, w, h)
        return blocks, mask

    def _infer(self, img_bgr: np.ndarray):
        """Una pasada del modelo: bloques, líneas y probabilidad de texto por píxel."""
        h, w = img_bgr.shape[:2]
        tensor, ratio, (pad_w, pad_h) = _letterbox(img_bgr)
        outputs = dict(zip(self.output_names, self.session.run(None, {self.input_name: tensor})))
        blk, seg, det = _split_outputs(outputs)

        boxes, confs, classes = _yolo_postprocess(blk[0], ratio, w, h)
        lines, _scores = _db_lines(det[0, 0], ratio, w, h)

        valid_h, valid_w = INPUT_SIZE - pad_h, INPUT_SIZE - pad_w
        prob = seg[0, 0, :valid_h, :valid_w]
        prob = cv2.resize(prob.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
        return boxes, confs, classes, lines, prob


# ----------------------------------------------------------------------
# Páginas alargadas: análisis por tramos
# ----------------------------------------------------------------------

TILE_ASPECT = 1.6   # proporción a partir de la cual se trocea (una página de manga ronda 1,4)
TILE_LENGTH = 1.4   # largo de cada tramo respecto al lado corto
TILE_STRIDE = 0.6   # avance entre tramos: 40 % de solape, suficiente para globos grandes


def tile_spans(length: int, short: int) -> list[tuple[int, int, int, int]]:
    """Tramos (inicio, fin, inicio_propio, fin_propio) a lo largo del lado largo.

    Cada detección pertenece al tramo cuya zona propia contiene su centro; las zonas
    propias se reparten por la mitad de cada solape, así nada se cuenta dos veces y
    lo que cae cerca de un corte se toma del tramo que lo ve entero.
    """
    if length <= short * TILE_ASPECT:
        return [(0, length, 0, length)]
    tile = max(1, int(round(short * TILE_LENGTH)))
    stride = max(1, int(tile * TILE_STRIDE))
    starts = list(range(0, length - tile + 1, stride))
    if starts[-1] + tile < length:
        starts.append(length - tile)
    ends = [s + tile for s in starts]
    cuts = [(ends[i] + starts[i + 1]) // 2 for i in range(len(starts) - 1)]
    owns = [0, *cuts], [*cuts, length]
    return [(s, e, a, b) for s, e, a, b in zip(starts, ends, *owns)]


def _shift_and_own(boxes, confs, classes, lines, start, own_start, own_end, along_y):
    """Pasa las detecciones de un tramo a coordenadas de página y se queda con las suyas."""
    axis = 1 if along_y else 0
    boxes = boxes.astype(np.int32).copy()
    if len(boxes):
        boxes[:, [axis, axis + 2]] += start
        centers = (boxes[:, axis] + boxes[:, axis + 2]) / 2
        keep = (centers >= own_start) & (centers < own_end)
        boxes, confs, classes = boxes[keep], confs[keep], classes[keep]
    owned_lines = []
    for poly in lines:
        poly = poly.copy()
        poly[:, axis] += start
        center = poly[:, axis].mean()
        if own_start <= center < own_end:
            owned_lines.append(poly)
    return boxes, confs, classes, owned_lines


def _containment(a: np.ndarray, b: np.ndarray) -> float:
    """Fracción del rectángulo menor que queda dentro del otro."""
    iw = min(a[2], b[2]) - max(a[0], b[0])
    ih = min(a[3], b[3]) - max(a[1], b[1])
    if iw <= 0 or ih <= 0:
        return 0.0
    smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return float(iw * ih) / max(smaller, 1)


def _dedupe_across(rects: list[np.ndarray], part_of: list[int], priority: list[float]) -> list[int]:
    """Índices a conservar: entre tramos distintos, si un rectángulo queda casi entero
    dentro de otro de mayor prioridad, es el mismo texto visto recortado. Dentro de un
    mismo tramo no se toca nada (ya pasó por NMS y puede haber bloques anidados reales)."""
    kept: list[int] = []
    for i in sorted(range(len(rects)), key=lambda k: -priority[k]):
        if all(part_of[j] == part_of[i] or _containment(rects[i], rects[j]) < 0.7 for j in kept):
            kept.append(i)
    return sorted(kept)


def _merge_parts(parts):
    """Une los tramos eliminando duplicados que cruzan un corte."""
    boxes = np.concatenate([p[0] for p in parts]).reshape(-1, 4)
    confs = np.concatenate([p[1] for p in parts])
    classes = np.concatenate([p[2] for p in parts])
    box_part = [i for i, p in enumerate(parts) for _ in range(len(p[0]))]
    keep = _dedupe_across(list(boxes), box_part, list(confs))

    lines = [poly for p in parts for poly in p[3]]
    line_part = [i for i, p in enumerate(parts) for _ in p[3]]
    rects = [np.array(_poly_bbox(poly)) for poly in lines]
    kept_lines = _dedupe_across(rects, line_part, [_line_geometry(poly)[0] for poly in lines])
    return boxes[keep], confs[keep], classes[keep], [lines[i] for i in kept_lines]


# ----------------------------------------------------------------------
# Pre/post-procesado
# ----------------------------------------------------------------------

def _letterbox(img_bgr: np.ndarray) -> tuple[np.ndarray, float, tuple[int, int]]:
    h, w = img_bgr.shape[:2]
    r = min(INPUT_SIZE / h, INPUT_SIZE / w)
    nw, nh = int(round(w * r)), int(round(h * r))
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    if (nw, nh) != (w, h):
        rgb = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_LINEAR if r > 1 else cv2.INTER_AREA)
    pad_w, pad_h = INPUT_SIZE - nw, INPUT_SIZE - nh
    canvas = cv2.copyMakeBorder(rgb, 0, pad_h, 0, pad_w, cv2.BORDER_CONSTANT, value=(0, 0, 0))
    tensor = canvas.transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    return np.ascontiguousarray(tensor), r, (pad_w, pad_h)


def _split_outputs(outputs: dict[str, np.ndarray]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    blk = seg = det = None
    for arr in outputs.values():
        if arr.ndim == 3:
            blk = arr
        elif arr.ndim == 4 and arr.shape[1] == 1:
            seg = arr
        elif arr.ndim == 4 and arr.shape[1] == 2:
            det = arr
    if blk is None or seg is None or det is None:
        raise RuntimeError("El modelo de detección no tiene las salidas esperadas.")
    return blk, seg, det


def _nms(boxes: np.ndarray, scores: np.ndarray, thresh: float) -> list[int]:
    x1, y1, x2, y2 = boxes.T
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.clip(xx2 - xx1, 0, None) * np.clip(yy2 - yy1, 0, None)
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
        order = order[1:][iou <= thresh]
    return keep


def _yolo_postprocess(pred: np.ndarray, ratio: float, w: int, h: int):
    obj = pred[:, 4]
    cls_scores = pred[:, 5:]
    cls = cls_scores.argmax(axis=1)
    conf = obj * cls_scores[np.arange(len(cls)), cls]
    keep = conf > CONF_THRESH
    pred, conf, cls = pred[keep], conf[keep], cls[keep]
    if not len(pred):
        return np.zeros((0, 4), np.int32), np.zeros(0), np.zeros(0, np.int32)
    xy, wh = pred[:, :2], pred[:, 2:4]
    boxes = np.concatenate([xy - wh / 2, xy + wh / 2], axis=1)
    idx = _nms(boxes, conf, NMS_THRESH)
    boxes = boxes[idx] / ratio
    boxes[:, [0, 2]] = boxes[:, [0, 2]].clip(0, w)
    boxes[:, [1, 3]] = boxes[:, [1, 3]].clip(0, h)
    return boxes.astype(np.int32), conf[idx], cls[idx].astype(np.int32)


def _db_lines(prob: np.ndarray, ratio: float, w: int, h: int) -> tuple[list[np.ndarray], list[float]]:
    bitmap = (prob > LINE_BIN_THRESH).astype(np.uint8)
    contours, _ = cv2.findContours(bitmap, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    lines, scores = [], []
    for contour in contours[:2000]:
        if len(contour) < 4:
            continue
        x, y, cw, ch = cv2.boundingRect(contour)
        region = np.zeros((ch, cw), np.uint8)
        cv2.fillPoly(region, [contour - [x, y]], 1)
        score = float(cv2.mean(prob[y:y + ch, x:x + cw], region)[0])
        if score < LINE_SCORE_THRESH:
            continue
        (cx, cy), (rw, rh), angle = cv2.minAreaRect(contour)
        if min(rw, rh) < 2:
            continue
        area, perimeter = rw * rh, 2 * (rw + rh)
        d = area * UNCLIP_RATIO / max(perimeter, 1e-6)
        rect = ((cx, cy), (rw + 2 * d, rh + 2 * d), angle)
        if min(rect[1]) < 5:
            continue
        pts = cv2.boxPoints(rect) / ratio
        pts[:, 0] = pts[:, 0].clip(0, w)
        pts[:, 1] = pts[:, 1].clip(0, h)
        lines.append(_order_points(pts).astype(np.int32))
        scores.append(score)
    return lines, scores


def _order_points(pts: np.ndarray) -> np.ndarray:
    """Ordena tl, tr, br, bl."""
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    return np.array([pts[s.argmin()], pts[d.argmin()], pts[s.argmax()], pts[d.argmax()]], dtype=np.float32)


def _line_geometry(poly: np.ndarray) -> tuple[float, float, bool]:
    """Devuelve (largo, grosor, vertical) de una línea de texto."""
    tl, tr, br, bl = poly.astype(np.float32)
    width = (np.linalg.norm(tr - tl) + np.linalg.norm(br - bl)) / 2
    height = (np.linalg.norm(bl - tl) + np.linalg.norm(br - tr)) / 2
    vertical = height > width * 1.15
    return max(width, height), min(width, height), vertical


def _poly_bbox(poly: np.ndarray) -> tuple[int, int, int, int]:
    x1, y1 = poly.min(axis=0)
    x2, y2 = poly.max(axis=0)
    return int(x1), int(y1), int(x2), int(y2)


def _contains(box, pt, margin: float = 0.0) -> bool:
    x1, y1, x2, y2 = box
    return x1 - margin <= pt[0] <= x2 + margin and y1 - margin <= pt[1] <= y2 + margin


def _cluster_lines(lines: list[np.ndarray]) -> list[list[np.ndarray]]:
    """Une líneas contiguas de un mismo párrafo: misma orientación, cuerpo similar,
    separación pequeña y solapamiento suficiente a lo largo del eje de lectura."""
    n = len(lines)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    info = [(_poly_bbox(p), *_line_geometry(p)) for p in lines]
    for i in range(n):
        bi, _li, ti, vi = info[i]
        for j in range(i + 1, n):
            bj, _lj, tj, vj = info[j]
            if vi != vj or max(ti, tj) > min(ti, tj) * 1.6:
                continue
            thick = (ti + tj) / 2
            if vi:  # columnas verticales: hueco horizontal pequeño y solape vertical
                gap = max(bi[0], bj[0]) - min(bi[2], bj[2])
                overlap = min(bi[3], bj[3]) - max(bi[1], bj[1])
                span = min(bi[3] - bi[1], bj[3] - bj[1])
            else:
                gap = max(bi[1], bj[1]) - min(bi[3], bj[3])
                overlap = min(bi[2], bj[2]) - max(bi[0], bj[0])
                span = min(bi[2] - bi[0], bj[2] - bj[0])
            if gap < thick * 0.8 and overlap > span * 0.3:
                parent[find(i)] = find(j)
    groups: dict[int, list[np.ndarray]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(lines[i])
    return list(groups.values())


def _group(boxes, confs, classes, lines, w: int, h: int) -> list[DetectedBlock]:
    blocks = [
        DetectedBlock(bbox=tuple(int(v) for v in b), confidence=float(c), lang_hint=TextDetector.LANGS[int(k)] if int(k) < 2 else "unknown")
        for b, c, k in zip(boxes, confs, classes)
    ]
    orphans: list[np.ndarray] = []
    for poly in lines:
        center = poly.mean(axis=0)
        candidates = [b for b in blocks if _contains(b.bbox, center, margin=4)]
        if candidates:
            min(candidates, key=lambda b: b.area).lines.append(poly)
        else:
            orphans.append(poly)

    # Las líneas sin bloque (texto fuera de globos, notas) se agrupan en párrafos.
    for group in _cluster_lines(orphans):
        pts = np.concatenate(group, axis=0)
        blocks.append(DetectedBlock(bbox=_poly_bbox(pts), lines=group, confidence=0.0))

    result: list[DetectedBlock] = []
    for b in blocks:
        if b.lines:
            geoms = [_line_geometry(p) for p in b.lines]
            elongated = [g for g in geoms if g[0] > g[1] * 1.5]
            if elongated:
                b.vertical = sum(1 for g in elongated if g[2]) * 2 > len(elongated)
            else:  # solo caracteres sueltos: se decide por la forma del bloque
                bw, bh = b.bbox[2] - b.bbox[0], b.bbox[3] - b.bbox[1]
                b.vertical = bh > bw * 1.2 and b.lang_hint != "eng"
            b.line_size = float(np.median([g[1] for g in geoms]))
            pts = np.concatenate(b.lines, axis=0)
            lx1, ly1, lx2, ly2 = _poly_bbox(pts)
            if b.confidence > 0:
                x1, y1, x2, y2 = b.bbox
                b.bbox = (min(x1, lx1), min(y1, ly1), max(x2, lx2), max(y2, ly2))
            else:
                b.bbox = (lx1, ly1, lx2, ly2)
            # Una sola línea muy corta y de baja confianza suele ser ruido (tramas, onomatopeyas mínimas).
            if b.confidence == 0 and len(b.lines) == 1 and geoms[0][0] < geoms[0][1] * 1.6:
                continue
        else:
            if b.confidence < 0.55:
                continue
            x1, y1, x2, y2 = b.bbox
            b.vertical = (y2 - y1) > (x2 - x1) * 1.4 and b.lang_hint != "eng"
            b.line_size = float(min(x2 - x1, y2 - y1)) / 2
        x1, y1, x2, y2 = b.bbox
        b.bbox = (max(0, x1), max(0, y1), min(w, x2), min(h, y2))
        if b.area >= 64:
            result.append(b)
    return result
