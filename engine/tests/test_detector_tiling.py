"""Análisis por tramos de páginas alargadas (webtoon) en el detector."""

from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np
import pytest

from starblitz_engine.vision import detector as det
from starblitz_engine.vision.detector import TextDetector, tile_spans


def test_regular_pages_are_not_tiled():
    assert tile_spans(1400, 1000) == [(0, 1400, 0, 1400)]
    assert tile_spans(1000, 1000) == [(0, 1000, 0, 1000)]


def test_spans_cover_strip_with_overlap_and_disjoint_ownership():
    length, short = 12000, 800
    spans = tile_spans(length, short)
    assert len(spans) > 1
    assert spans[0][0] == 0 and spans[-1][1] == length
    for (s1, e1, _a1, b1), (s2, _e2, a2, _b2) in zip(spans, spans[1:]):
        assert s2 < e1, "los tramos deben solaparse"
        assert e1 - s2 >= short * 0.5, "el solape debe cubrir un globo grande"
        assert b1 == a2, "las zonas propias se tocan sin huecos ni solapes"
    assert spans[0][2] == 0 and spans[-1][3] == length
    for s, e, a, b in spans:
        assert e - s == int(round(short * det.TILE_LENGTH))
        assert s <= a < b <= e


class _FakeDetector(TextDetector):
    """Sustituye el modelo por un detector de rectángulos negros: permite comprobar
    las coordenadas, la propiedad de cada tramo y la eliminación de duplicados."""

    def __init__(self):  # noqa: D401 - sin sesión ONNX
        self.calls = 0

    def _infer(self, img):
        self.calls += 1
        h, w = img.shape[:2]
        dark = (cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) < 128).astype(np.uint8)
        n, _labels, stats, _ = cv2.connectedComponentsWithStats(dark)
        boxes, lines = [], []
        for i in range(1, n):
            x, y, bw, bh, _area = stats[i]
            boxes.append((x, y, x + bw, y + bh))
            lines.append(np.array([[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]], np.int32))
        arr = np.array(boxes, np.int32).reshape(-1, 4)
        return arr, np.full(len(arr), 0.9), np.ones(len(arr), np.int32), lines, dark.astype(np.float32)


def test_strip_detections_are_mapped_once_each():
    w, h = 800, 9000
    img = np.full((h, w, 3), 255, np.uint8)
    # Un bloque en cada zona, incluidos dos que caen justo sobre los cortes.
    spans = tile_spans(h, w)
    ys = [300, spans[0][3] - 60, 4200, spans[-2][3] - 40, 8700]
    for y in ys:
        cv2.rectangle(img, (200, y), (420, y + 120), (0, 0, 0), -1)
    fake = _FakeDetector()
    blocks, mask = fake.detect(img)
    assert fake.calls == len(spans) > 1
    got = sorted(b.bbox[1] for b in blocks)
    assert len(got) == len(ys), got
    for y, gy in zip(sorted(ys), got):
        assert abs(gy - y) <= 1
    for b in blocks:
        assert b.bbox[3] - b.bbox[1] >= 119, "ningún bloque debe quedar recortado por un corte"
    assert mask.shape == (h, w) and mask[ys[2] + 60, 300] == 255


@pytest.mark.skipif(not (Path(os.environ.get("STARBLITZ_TESTDATA", "")) / "ja_page1.jpg").is_file(),
                    reason="sin página de prueba")
def test_real_model_on_webtoon_strip(detector_path):
    """Una página repetida tres veces en vertical (tira tipo webtoon): cada copia
    debe detectarse igual que la página suelta, aunque los cortes caigan en mitad de globos.
    `ja_page1.jpg` puede ser una doble página (apaisada: se usa la mitad derecha) o una página suelta."""
    image = cv2.imread(str(Path(os.environ["STARBLITZ_TESTDATA"]) / "ja_page1.jpg"))
    page = np.ascontiguousarray(image[:, image.shape[1] // 2:] if image.shape[1] > image.shape[0] else image)
    h = page.shape[0]
    model = TextDetector(detector_path, device="cpu")
    single, _ = model.detect(page)
    strip = np.vstack([page, page, page])
    assert len(tile_spans(strip.shape[0], strip.shape[1])) > 1
    stacked, mask = model.detect(strip)
    assert mask.shape == strip.shape[:2]

    def iou(a, b):
        iw = min(a[2], b[2]) - max(a[0], b[0])
        ih = min(a[3], b[3]) - max(a[1], b[1])
        if iw <= 0 or ih <= 0:
            return 0.0
        inter = iw * ih
        return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)

    # Los bloques de baja confianza (< 0,9) aparecen o desaparecen con un 1 % de cambio de escala (el modelo no es
    # invariante); lo que sí debe cumplirse es que todo texto claro se encuentre una sola vez en cada copia, sin
    # recortes ni duplicados en los cortes, y que el conjunto global se parezca al de la página suelta.
    sure = [b.bbox for b in single if b.confidence >= 0.9]
    assert len(sure) >= 3, "la página de prueba debe tener al menos 3 bloques de texto detectados con seguridad"
    ref = [b.bbox for b in single]
    for copy in range(3):
        mine = [b.bbox for b in stacked if copy * h <= (b.bbox[1] + b.bbox[3]) / 2 < (copy + 1) * h]
        shifted = [(x1, y1 - copy * h, x2, y2 - copy * h) for x1, y1, x2, y2 in mine]
        for r in sure:
            hits = sum(1 for s in shifted if iou(r, s) > 0.5)
            assert hits == 1, (copy, r, hits)
        matched = sum(1 for r in ref if any(iou(r, s) > 0.5 for s in shifted))
        assert matched >= 0.75 * len(ref), (copy, matched, len(ref))
        assert abs(len(mine) - len(ref)) <= 3, (copy, len(mine), len(ref))
