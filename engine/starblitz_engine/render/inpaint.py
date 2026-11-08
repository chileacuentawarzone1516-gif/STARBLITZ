"""Borrado del texto original y reconstrucción del fondo.

Estrategia por región, de menor a mayor intervención:
1. Fondo liso (globo blanco o de color plano): se rellena solo la máscara de
   texto con el color del globo y nunca se pinta fuera de su contorno.
2. Fondo con dibujo o trama: LaMa (red de inpainting) sobre un recorte local.
3. Sin LaMa instalado: inpainting clásico de OpenCV como último recurso.
Los píxeles fuera de la máscara de texto no se modifican jamás.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Literal

import cv2
import numpy as np

from ..core.onnx import Device, create_session
from ..models.manager import ModelManager

log = logging.getLogger(__name__)

LAMA_SIZE = 512


@dataclass
class EraseTarget:
    bbox: tuple[int, int, int, int]
    lines: list[np.ndarray]
    line_size: float
    bubble_polygon: list[list[int]] | None
    fill: tuple[int, int, int] | None  # RGB
    uniform: bool


class LamaInpainter:
    def __init__(self, model_path, device: Device):
        self.session = create_session(model_path, device)
        names = [i.name for i in self.session.get_inputs()]
        shapes = [i.shape for i in self.session.get_inputs()]
        # El tensor de máscara tiene un solo canal.
        self.mask_name = next((n for n, s in zip(names, shapes) if len(s) == 4 and s[1] == 1), names[-1])
        self.image_name = next(n for n in names if n != self.mask_name)
        self._lock = threading.Lock()

    def __call__(self, img_rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
        h, w = img_rgb.shape[:2]
        image = cv2.resize(img_rgb, (LAMA_SIZE, LAMA_SIZE), interpolation=cv2.INTER_AREA if max(h, w) > LAMA_SIZE else cv2.INTER_CUBIC)
        m = cv2.resize(mask, (LAMA_SIZE, LAMA_SIZE), interpolation=cv2.INTER_NEAREST)
        image_t = image.astype(np.float32).transpose(2, 0, 1)[None] / 255.0
        mask_t = (m > 0).astype(np.float32)[None, None]
        with self._lock:
            out = self.session.run(None, {self.image_name: image_t, self.mask_name: mask_t})[0][0]
        out = out.transpose(1, 2, 0)
        if out.max() <= 1.5:
            out = out * 255.0
        out = np.clip(out, 0, 255).astype(np.uint8)
        return cv2.resize(out, (w, h), interpolation=cv2.INTER_CUBIC)


class Inpainter:
    def __init__(self, models: ModelManager, device: Device, mode: Literal["auto", "lama", "fast"] = "auto"):
        self._models = models
        self._device = device
        self.mode = mode
        self._lama: LamaInpainter | None = None
        self._lama_lock = threading.Lock()

    @property
    def lama_available(self) -> bool:
        return self.mode != "fast" and self._models.is_installed("lama")

    def _get_lama(self) -> LamaInpainter | None:
        if not self.lama_available:
            return None
        with self._lama_lock:
            if self._lama is None:
                try:
                    self._lama = LamaInpainter(self._models.path("lama", "lama_fp32.onnx"), self._device)
                except Exception as exc:
                    log.error("No se pudo cargar LaMa: %s", exc)
                    return None
            return self._lama

    # ------------------------------------------------------------------
    def erase(self, img_bgr: np.ndarray, text_mask: np.ndarray, targets: list[EraseTarget]) -> np.ndarray:
        out = img_bgr.copy()
        h, w = img_bgr.shape[:2]
        for t in targets:
            region_mask, allowed = _region_mask(text_mask, t, (h, w))
            if not region_mask.any():
                continue
            bg, uniform_ratio, paper = _background(img_bgr, region_mask, allowed, t.bbox)
            if t.uniform or uniform_ratio >= 0.9:
                region_mask = _absorb_residue(img_bgr, region_mask, allowed, bg, t.line_size)
                sel = region_mask > 0
                # Se rellena con muestras reales del papel circundante (mismo grano/ruido del
                # escaneo); un color plano dejaría visible la silueta del texto borrado.
                rng = np.random.default_rng(int(t.bbox[0] * 7919 + t.bbox[1]))
                out[sel] = paper[rng.integers(0, len(paper), int(sel.sum()))]
            else:
                self._inpaint_region(out, region_mask, t.bbox)
        return out

    def _inpaint_region(self, out: np.ndarray, mask: np.ndarray, bbox) -> None:
        h, w = out.shape[:2]
        x1, y1, x2, y2 = bbox
        bw, bh = x2 - x1, y2 - y1
        side = int(max(bw, bh) * 1.6) + 32  # contexto alrededor para que LaMa entienda el dibujo
        cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
        sx1, sy1 = max(0, cx - side // 2), max(0, cy - side // 2)
        sx2, sy2 = min(w, sx1 + side), min(h, sy1 + side)
        sx1, sy1 = max(0, sx2 - side), max(0, sy2 - side)
        crop = out[sy1:sy2, sx1:sx2]
        cmask = mask[sy1:sy2, sx1:sx2]
        if not cmask.any():
            return
        lama = self._get_lama()
        if lama is not None:
            rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
            result = cv2.cvtColor(lama(rgb, cmask), cv2.COLOR_RGB2BGR)
        else:
            radius = max(3, int(min(bw, bh) * 0.03))
            result = cv2.inpaint(crop, cmask, radius, cv2.INPAINT_TELEA)
        sel = cmask > 0
        crop[sel] = result[sel]


def _region_mask(text_mask: np.ndarray, t: EraseTarget, shape) -> tuple[np.ndarray, np.ndarray]:
    """Devuelve (máscara de texto dilatada, zona permitida).

    La zona permitida es el entorno de las líneas de texto (incluye furigana) y,
    si hay globo, su interior: fuera de ella nunca se modifica un píxel.
    """
    h, w = shape
    x1, y1, x2, y2 = t.bbox
    reach = max(4, int(t.line_size * 0.6))
    allowed = np.zeros((h, w), np.uint8)
    if t.lines:
        cv2.fillPoly(allowed, [np.asarray(p, np.int32) for p in t.lines], 255)
        lines_mask = allowed.copy()
        allowed = cv2.dilate(allowed, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * reach + 1, 2 * reach + 1)))
    else:
        lines_mask = None
        allowed[max(0, y1 - reach):min(h, y2 + reach), max(0, x1 - reach):min(w, x2 + reach)] = 255
    if t.bubble_polygon:
        interior = np.zeros((h, w), np.uint8)
        cv2.fillPoly(interior, [np.array(t.bubble_polygon, np.int32)], 255)
        interior = cv2.erode(interior, np.ones((3, 3), np.uint8), iterations=2)
        allowed = cv2.bitwise_and(allowed, interior)

    mask = cv2.bitwise_and(text_mask, allowed)
    area = max(1, (x2 - x1) * (y2 - y1))
    if lines_mask is not None and mask.sum() < 0.05 * 255 * area:
        mask = lines_mask  # la segmentación falló: se usan los polígonos de línea
    k = max(2, int(t.line_size * 0.12))
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1)))
    return cv2.bitwise_and(mask, allowed), allowed


def _background(img: np.ndarray, mask: np.ndarray, allowed: np.ndarray, bbox) -> tuple[np.ndarray, float, np.ndarray]:
    """Color de fondo (mediana), proporción de píxeles del entorno que lo comparten y
    muestras de papel limpio para rellenar conservando la textura."""
    x1, y1, x2, y2 = bbox
    h, w = mask.shape
    pad = 6
    sl = (slice(max(0, y1 - pad), min(h, y2 + pad)), slice(max(0, x1 - pad), min(w, x2 + pad)))
    # Se excluye el halo de antialiasing para que el color de relleno sea el del papel limpio
    # (si fuera algo más oscuro, la silueta del texto borrado quedaría visible).
    near_text = cv2.dilate(mask[sl], np.ones((3, 3), np.uint8), iterations=4)
    ring = (allowed[sl] > 0) & (near_text == 0)
    pixels = img[sl][ring]
    if len(pixels) < 30:
        pixels = img[sl].reshape(-1, 3)
    median = np.median(pixels, axis=0)
    close = np.abs(pixels.astype(np.int16) - median.astype(np.int16)).max(axis=1) <= 30
    paper = pixels[np.abs(pixels.astype(np.int16) - median.astype(np.int16)).max(axis=1) <= 6]
    if len(paper) < 10:
        paper = median.astype(np.uint8)[None]
    return median.astype(np.uint8), float(close.mean()), paper.astype(np.uint8)


def _absorb_residue(img: np.ndarray, mask: np.ndarray, allowed: np.ndarray, fill: np.ndarray,
                    line_size: float) -> np.ndarray:
    """Añade a la máscara los restos de trazo (antialiasing, puntos, furigana) pegados a ella.

    Solo se absorben fragmentos pequeños: un contorno de globo o un trazo de dibujo
    es una estructura larga y conectada, y se conserva intacta.
    """
    diff = np.abs(img.astype(np.int16) - fill.astype(np.int16)).max(axis=2)
    residue = ((diff > 45) & (allowed > 0) & (mask == 0)).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(residue, connectivity=8)
    if n <= 1:
        return mask
    limit = max(6.0, line_size * 1.1)
    grown = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=3)
    touching = np.unique(labels[(grown > 0) & (residue > 0)])
    keep = np.zeros(n, bool)
    for lab in touching:
        if lab and max(stats[lab, cv2.CC_STAT_WIDTH], stats[lab, cv2.CC_STAT_HEIGHT]) <= limit:
            keep[lab] = True
    out = mask.copy()
    out[keep[labels]] = 255
    out = cv2.dilate(out, np.ones((3, 3), np.uint8), iterations=1)
    # Halo claro de antialiasing/JPEG alrededor de los trazos: diferencia pequeña pero visible.
    halo = cv2.dilate(out, np.ones((3, 3), np.uint8), iterations=4)
    out[(halo > 0) & (diff > 3)] = 255
    return cv2.bitwise_and(out, allowed)
