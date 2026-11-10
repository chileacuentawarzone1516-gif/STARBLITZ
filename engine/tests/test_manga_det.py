"""Detector EXPERIMENTAL PP-OCRv6 Manga: post-procesado propio (sin modelo) y, si el modelo está disponible, el modelo REAL.

Las pruebas con el modelo real usan páginas SINTÉTICAS dibujadas aquí (texto conocido): comprueban que el modelo carga, que
detecta líneas donde hay texto, que nada del pipeline se rompe y que el valor por defecto sigue siendo el detector de siempre.
La comparación con páginas reales está en docs/EVALUACION-CORPUS-USM.md (no se puede subir el cómic al repositorio).
"""
from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

from starblitz_engine.core.settings import ProcessingSettings
from starblitz_engine.models.registry import get_spec
from starblitz_engine.vision import manga_det as md

MANGA_DET = Path(os.environ.get("STARBLITZ_MANGA_DET", Path.home() / "models" / "manga_det.onnx"))


# --------------------------------------------------------------------------- sin modelo
def test_input_size_long_side_multiple_of_32():
    assert md.LONG_SIDE == 1600
    assert md.input_size(1952, 3000) == (1056, 1600)
    assert md.input_size(3000, 2307) == (1600, 1216)
    w, h = md.input_size(500, 500)
    assert w == h == 1600 and w % 32 == 0


def test_db_lines_scales_polygons_back_to_the_page():
    prob = np.zeros((96, 64), np.float32)
    prob[20:30, 10:50] = 0.9          # una línea horizontal en el mapa
    prob[60:62, 5:6] = 0.9            # ruido diminuto: se descarta
    lines, scores = md.db_lines(prob, sx=2.0, sy=2.0, w=128, h=192)
    assert len(lines) == 1 and scores[0] > 0.8
    x1, y1 = lines[0].min(axis=0)
    x2, y2 = lines[0].max(axis=0)
    # El rectángulo expandido («unclip») cubre la línea escalada ×2 y queda dentro de la página.
    assert x1 <= 20 and y1 <= 40 and x2 >= 98 and y2 >= 58
    assert 0 <= x1 and x2 <= 128 and 0 <= y1 and y2 <= 192


def test_low_score_contours_are_dropped():
    prob = np.zeros((64, 64), np.float32)
    prob[10:20, 10:40] = 0.2   # pasa el umbral de binarización (0,15) pero no el de puntuación (0,25)
    assert md.db_lines(prob, 1, 1, 64, 64) == ([], [])


def test_group_lines_makes_paragraphs_and_keeps_separate_balloons_apart():
    def hline(x1, y1, x2, y2):
        return np.array([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], np.int32)
    lines = [hline(100, 100, 300, 120), hline(110, 124, 290, 144), hline(120, 148, 280, 168),  # párrafo
             hline(600, 600, 760, 620)]                                                       # otro globo
    blocks = md.group_lines(lines, [0.9, 0.8, 0.7, 0.6], 1000, 1000)
    assert sorted(len(b.lines) for b in blocks) == [1, 3]
    big = max(blocks, key=lambda b: len(b.lines))
    assert big.bbox == (100, 100, 300, 168) and not big.vertical and abs(big.confidence - 0.8) < 1e-6
    assert big.lang_hint == "unknown"  # el modelo no clasifica idioma: no se inventa


def test_vertical_columns_are_vertical():
    cols = [np.array([[x, 100], [x + 20, 100], [x + 20, 300], [x, 300]], np.int32) for x in (400, 376, 352)]
    (block,) = md.group_lines(cols, [0.9] * 3, 1000, 1000)
    assert block.vertical and len(block.lines) == 3


def test_line_mask_marks_strokes_not_the_whole_box():
    img = np.full((200, 400, 3), 255, np.uint8)
    cv2.putText(img, "HELLO", (40, 120), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (0, 0, 0), 5)
    poly = np.array([[30, 60], [330, 60], [330, 140], [30, 140]], np.int32)
    mask = md.line_mask(img, [poly])
    ink = (cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) < 128)
    inside = np.zeros_like(ink)
    inside[60:141, 30:331] = True
    covered = (mask > 0) & ink
    assert covered.sum() / ink.sum() > 0.95             # cubre los trazos
    assert (mask > 0).sum() < 0.6 * inside.sum()         # pero no todo el rectángulo
    assert not (mask[:, :25] > 0).any()                  # nada fuera del polígono


def test_line_mask_white_text_on_dark_background():
    img = np.zeros((200, 400, 3), np.uint8)
    cv2.putText(img, "BOOM", (40, 120), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (255, 255, 255), 5)
    poly = np.array([[30, 60], [300, 60], [300, 140], [30, 140]], np.int32)
    mask = md.line_mask(img, [poly])
    ink = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) > 128
    assert ((mask > 0) & ink).sum() / ink.sum() > 0.95


def test_default_detector_is_unchanged_and_model_is_pinned():
    assert ProcessingSettings().detector == "default"
    spec = get_spec("text-detector-manga")
    assert spec and not spec.required and "EXPERIMENTAL" in spec.label
    f = spec.files[0]
    assert "/resolve/v0.3/" in f.urls[0] and f.sha256 == "97c434ae8deaad83513fb132b605d5085a3af8ffac2cb15e2aa096815c206172"
    assert get_spec("text-detector").required  # el de siempre sigue siendo el obligatorio


# --------------------------------------------------------------------------- con el modelo real
@pytest.fixture(scope="module")
def manga_det():
    if not MANGA_DET.is_file():
        pytest.skip("sin el modelo manga_det.onnx (STARBLITZ_MANGA_DET)")
    return md.MangaLineDetector(MANGA_DET, "cpu")


def _page(lines: list[str], size=(800, 1100), vertical=False) -> np.ndarray:
    img = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default(size=34)
    except TypeError:  # Pillow antiguo
        font = ImageFont.load_default()
    d.ellipse((80, 80, 720, 520), outline="black", width=5, fill="white")
    y = 210
    for t in lines:
        d.text((170, y), t, fill="black", font=font)
        y += 48
    d.rectangle((60, 640, 740, 1040), outline="black", width=4)
    d.text((120, 760), "NARRATION BOX TEXT", fill="black", font=font)
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def test_real_model_detects_lines_on_a_synthetic_page(manga_det):
    img = _page(["WHAT ARE YOU DOING", "HERE, PETER?", "GET TO CLASS!"])
    blocks, mask = manga_det.detect(img)
    lines = [p for b in blocks for p in b.lines]
    assert len(lines) >= 4, f"esperaba ≥4 líneas, hay {len(lines)}"
    # Cada línea escrita queda cubierta por alguna detección.
    for y in (210, 258, 306, 760):
        assert any(p[:, 1].min() <= y + 17 <= p[:, 1].max() for p in lines), f"línea en y={y} sin detectar"
    assert mask.shape == img.shape[:2] and mask.dtype == np.uint8 and set(np.unique(mask)) <= {0, 255}
    assert 0 < (mask > 0).mean() < 0.1


# Antes era un fallo esperado (2026-11-09): las líneas sueltas de un globo no se agrupaban. Lo resuelve `merge_by_bubble`.
def test_real_model_groups_a_three_line_balloon_into_one_block(manga_det):
    blocks, _ = manga_det.detect(_page(["WHAT ARE YOU DOING", "HERE, PETER?", "GET TO CLASS!"]))
    assert any(len(b.lines) >= 3 for b in blocks)


def test_real_model_tiles_long_strips(manga_det):
    strip = np.full((6000, 700, 3), 255, np.uint8)
    for y in (300, 2900, 5600):
        cv2.putText(strip, "HELLO THERE", (60, y), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 0), 4)
    blocks, _ = manga_det.detect(strip)
    ys = sorted(int(np.mean([p[:, 1].mean() for p in b.lines])) for b in blocks)
    for y in (300, 2900, 5600):
        assert any(abs(c - (y - 20)) < 60 for c in ys), f"texto en y={y} sin detectar: {ys}"


def test_pipeline_accepts_the_experimental_detector(manga_det, tmp_path):
    """Análisis completo de una página con el detector experimental: regiones, OCR, globos y máscara sin errores."""
    from starblitz_engine.api.context import Services
    from starblitz_engine.core.paths import DataPaths
    from starblitz_engine.projects.schema import Project

    paths = DataPaths(tmp_path).ensure()
    dst = paths.models / "text-detector-manga" / "manga_det.onnx"
    dst.parent.mkdir(parents=True)
    dst.write_bytes(MANGA_DET.read_bytes())
    svc = Services.build(paths, token="t")
    svc.settings.update({"processing": {"device": "cpu", "detector": "manga-det"}})
    svc.processor.refresh_settings()
    assert isinstance(svc.processor.detector(), md.MangaLineDetector)
    project = Project(id=svc.store.new_project_id(), name="p", source_lang="en")
    svc.store.create(project)
    ok, png = cv2.imencode(".png", _page(["WHAT ARE YOU DOING", "HERE, PETER?"]))
    page = svc.store.add_page(project, png.tobytes(), "png", "p1.png", 800, 1100, "x", "0", None)
    project = svc.store.get(project.id)
    page = svc.processor.analyze_page(project, svc.store.get_page(project.id, page.id))
    assert page.status == "analyzed" and page.regions
    assert any("PETER" in r.source_text.upper() for r in page.regions)  # OCR real (PP-OCR) sobre lo detectado
    assert all(r.layout_box for r in page.regions)                  # cada región tiene dónde rotular
    assert any(r.bubble for r in page.regions)                       # el globo de dos líneas se agrupa y se asocia
    svc.shutdown()


@pytest.mark.xfail(strict=True, reason="LIMITACIÓN CONOCIDA: un globo con UNA sola línea de texto (o dos líneas separadas por otro "
                   "globo) es más de 6× el bloque y `find_bubble` lo descarta con sus límites normales; pasa igual con el "
                   "detector por defecto. La agrupación por globo sí lo ve (búsqueda ampliada), pero el pipeline no la usa.")
def test_known_limitation_single_lines_do_not_find_their_balloon(manga_det):
    from starblitz_engine.vision.bubbles import find_bubble

    img = _page(["WHAT ARE YOU DOING?"])
    blocks, mask = manga_det.detect(img)
    assert any(find_bubble(img, mask, b) for b in blocks if b.bbox[1] < 520)
