"""Contrato común de los motores OCR y utilidades de recorte."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import cv2
import numpy as np

from ..detector import DetectedBlock


@dataclass
class OCRResult:
    text: str
    confidence: float
    engine: str


class OCREngine(Protocol):
    id: str

    def recognize(self, img_bgr: np.ndarray, block: DetectedBlock) -> OCRResult: ...


def warp_line(img: np.ndarray, poly: np.ndarray) -> np.ndarray:
    """Endereza el cuadrilátero de una línea de texto a un rectángulo."""
    pts = poly.astype(np.float32)
    w = int(max(np.linalg.norm(pts[0] - pts[1]), np.linalg.norm(pts[2] - pts[3])))
    h = int(max(np.linalg.norm(pts[0] - pts[3]), np.linalg.norm(pts[1] - pts[2])))
    w, h = max(w, 2), max(h, 2)
    dst = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
    m = cv2.getPerspectiveTransform(pts, dst)
    return cv2.warpPerspective(img, m, (w, h), borderMode=cv2.BORDER_REPLICATE, flags=cv2.INTER_CUBIC)


def ordered_lines(block: DetectedBlock, rtl_columns: bool = True) -> list[np.ndarray]:
    """Orden de lectura de las líneas de un bloque.

    Vertical (japonés/chino): columnas de derecha a izquierda.
    Horizontal: de arriba abajo.
    """
    if block.vertical:
        key = (lambda p: -p[:, 0].mean()) if rtl_columns else (lambda p: p[:, 0].mean())
    else:
        key = lambda p: p[:, 1].mean()  # noqa: E731
    return sorted(block.lines, key=key)


def crop_bbox(img: np.ndarray, bbox: tuple[int, int, int, int], pad: int = 0) -> np.ndarray:
    h, w = img.shape[:2]
    x1, y1, x2, y2 = bbox
    return img[max(0, y1 - pad):min(h, y2 + pad), max(0, x1 - pad):min(w, x2 + pad)]
