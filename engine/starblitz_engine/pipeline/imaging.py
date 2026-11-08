"""Lectura/escritura de imágenes compatible con rutas Unicode en Windows."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from ..core.fsutil import atomic_write_bytes


def read_bgr(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"No se pudo leer la imagen {path.name}")
    return img


def read_gray(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f"No se pudo leer la imagen {path.name}")
    return img


def write_png(path: Path, img: np.ndarray, compression: int = 3) -> None:
    ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, compression])
    if not ok:
        raise ValueError("No se pudo codificar la imagen")
    atomic_write_bytes(path, buf.tobytes())


def encode_jpeg(img: np.ndarray, quality: int = 88, max_side: int | None = None) -> bytes:
    if max_side and max(img.shape[:2]) > max_side:
        scale = max_side / max(img.shape[:2])
        img = cv2.resize(img, (int(img.shape[1] * scale), int(img.shape[0] * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("No se pudo codificar la imagen")
    return buf.tobytes()


def annotate_for_llm(img: np.ndarray, boxes: list[tuple[int, int, int, int]], max_side: int = 1280) -> bytes:
    """Página reducida con cada texto numerado en un círculo, para el modelo con visión.

    Una página normal se limita por su lado largo; una tira de webtoon se limita por
    superficie (≈1,2 MP, máximo 4096 px de largo) para que no quede en una franja
    ilegible de pocos píxeles de ancho.
    """
    h, w = img.shape[:2]
    if max(h, w) <= min(h, w) * 1.6:
        scale = min(1.0, max_side / max(h, w))
    else:
        scale = min(1.0, (max_side * max_side * 0.75 / (h * w)) ** 0.5, 4096 / max(h, w))
    small = cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA) if scale < 1 else img.copy()
    r = max(11, int(min(small.shape[:2]) * 0.02))
    for n, (x1, y1, x2, y2) in enumerate(boxes, start=1):
        cx, cy = int(x1 * scale), int(y1 * scale)
        cx, cy = max(r, min(small.shape[1] - r, cx)), max(r, min(small.shape[0] - r, cy))
        cv2.rectangle(small, (int(x1 * scale), int(y1 * scale)), (int(x2 * scale), int(y2 * scale)), (60, 20, 230), 2)
        cv2.circle(small, (cx, cy), r, (60, 20, 230), -1, cv2.LINE_AA)
        label = str(n)
        fs = r / 16
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, fs, 2)
        cv2.putText(small, label, (cx - tw // 2, cy + th // 2), cv2.FONT_HERSHEY_SIMPLEX, fs, (255, 255, 255), 2, cv2.LINE_AA)
    return encode_jpeg(small, 85)
