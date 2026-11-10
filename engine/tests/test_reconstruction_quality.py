"""Correcciones generales del 2026-11-09 (capítulo real): globos ajustados al texto, cajas de rotulado solapadas y
comprobaciones de traducción. Sin modelos: imágenes y regiones construidas aquí."""
from __future__ import annotations

import cv2
import numpy as np

from starblitz_engine.pipeline.processor import separate_layouts
from starblitz_engine.projects.schema import Region
from starblitz_engine.translate import quality as Q
from starblitz_engine.vision.bubbles import find_bubble, paper_stats
from starblitz_engine.vision.detector import DetectedBlock


def _region(rid, bbox, layout, bubble=False):
    from starblitz_engine.projects.schema import Bubble
    b = Bubble(polygon=[[0, 0], [1, 0], [1, 1]], bbox=layout, fill=(255, 255, 255), uniform=True) if bubble else None
    return Region(id=rid, order=0, bbox=bbox, layout_box=layout, source_text="X", max_chars=10, line_size=20, bubble=b)


def test_overlapping_layouts_are_split_at_the_midline_between_texts():
    a = _region("a", (100, 100, 200, 160), (60, 60, 320, 220), bubble=True)
    b = _region("b", (300, 110, 380, 150), (240, 70, 450, 200), bubble=True)
    assert separate_layouts([a, b], 1200) == 2
    cut = (200 + 300) // 2
    assert a.layout_box[2] == cut and b.layout_box[0] == cut               # se cortan en la línea media entre textos
    assert a.layout_box[0] == 60 and b.layout_box[2] == 450                 # el resto de la caja no cambia
    assert a.max_chars > 0 and b.max_chars > 0                              # el límite de caracteres se recalcula


def test_layout_never_shrinks_below_its_own_text_and_overlapping_texts_are_left_alone():
    a = _region("a", (100, 100, 200, 300), (90, 90, 400, 320))
    b = _region("b", (210, 100, 260, 300), (150, 90, 300, 320))
    separate_layouts([a, b], 1200)
    assert a.layout_box[2] >= a.bbox[2] and b.layout_box[0] <= b.bbox[0]
    c = _region("c", (100, 100, 200, 200), (90, 90, 210, 210))
    d = _region("d", (150, 150, 250, 250), (140, 140, 260, 260))
    assert separate_layouts([c, d], 1200) == 0 and c.layout_box == (90, 90, 210, 210)


def test_stacked_texts_are_split_horizontally():
    a = _region("a", (100, 100, 300, 140), (80, 80, 320, 260))
    b = _region("b", (110, 200, 290, 240), (80, 160, 320, 300))
    separate_layouts([a, b], 1200)
    assert a.layout_box[3] == b.layout_box[1] == (140 + 200) // 2


def _tight_balloon_on_artwork():
    """Globo blanco ajustado al texto sobre un fondo con dibujo (verde con trama), como en el cómic occidental."""
    img = np.zeros((600, 800, 3), np.uint8)
    img[:] = (60, 170, 90)
    for x in range(0, 800, 7):
        cv2.line(img, (x, 0), (x - 300, 600), (30, 90, 40), 2)
    cv2.ellipse(img, (400, 300), (150, 95), 0, 0, 360, (255, 255, 255), -1)
    cv2.ellipse(img, (400, 300), (150, 95), 0, 0, 360, (0, 0, 0), 4)
    mask = np.zeros((600, 800), np.uint8)
    for k, y in enumerate((250, 290, 330)):
        cv2.putText(img, "GIVE IT TO ME"[: 13 - k * 2], (290, y), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 3)
        cv2.putText(mask, "GIVE IT TO ME"[: 13 - k * 2], (290, y), cv2.FONT_HERSHEY_SIMPLEX, 1.0, 255, 7)
    return img, mask


def test_paper_between_letters_gives_the_real_balloon_colour():
    img, mask = _tight_balloon_on_artwork()
    ys, xs = np.nonzero(mask)
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
    median, spread = paper_stats(img, mask, bbox)
    assert median.min() > 240 and spread < 22


def test_tight_balloon_is_found_whole_not_as_the_text_silhouette():
    img, mask = _tight_balloon_on_artwork()
    ys, xs = np.nonzero(mask)
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
    bubble = find_bubble(img, mask, DetectedBlock(bbox=bbox, line_size=30))
    assert bubble is not None
    bx1, by1, bx2, by2 = bubble.bbox
    assert (bx2 - bx1) * (by2 - by1) > 1.3 * (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])  # el globo, más grande que el texto
    assert bubble.fill[0] > 240 and bubble.uniform


def test_quality_checks_are_general():
    assert Q.check("WHAT?", "Eso debería mantenerla ocupada durante horas.", "WHAT", "es-419", []) == ["invented"]
    assert Q.check("HE PARKER HOME", "¿Peter? ¿Qué dijimos?", "PETER? PETER?", "es-419", []) == ["misaligned"]
    assert Q.check("DO YOU GUYS HAVE PRACTICE?", "¿No tenéis práctica?", "DO YOU GUYS", "es-419", []) == ["variant"]
    assert Q.check("DO YOU GUYS HAVE PRACTICE?", "¿No tenéis práctica?", "DO YOU GUYS", "es-ES", []) == []
    assert Q.check("ISN'T THAT MARY JANE?", "¿No es María-Jane?", "ISN'T THAT", "es-419", [("Mary Jane", "Mary Jane")]) == ["name"]
    assert Q.check("すまん、田中！", "¡Lo siento, Tanaka!", "すまん", "es-419", [("田中", "Tanaka")]) == []
    assert Q.match_case("WHAT ARE YOU DOING?", "¿Qué haces?") == "¿QUÉ HACES?"
    assert not Q.has_vosotros("Tengo sed en este país")
