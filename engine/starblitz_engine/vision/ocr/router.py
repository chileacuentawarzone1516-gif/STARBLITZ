"""Selección del motor OCR según el idioma de origen y los modelos instalados."""

from __future__ import annotations

import logging
import threading

from ...core.onnx import Device
from ...models.manager import ModelManager
from .base import OCREngine

log = logging.getLogger(__name__)

SUPPORTED_SOURCE_LANGS = {
    "ja": "Japonés",
    "en": "Inglés",
    "zh": "Chino simplificado",
    "zh-hant": "Chino tradicional",
    "ko": "Coreano",
    "fr": "Francés",
    "it": "Italiano",
    "pt": "Portugués",
    "de": "Alemán",
}


class OCRRouter:
    """Crea y reutiliza los motores OCR (cargar un modelo cuesta segundos)."""

    def __init__(self, models: ModelManager, device: Device):
        self._models = models
        self._device = device
        self._cache: dict[str, OCREngine] = {}
        self._lock = threading.Lock()

    def engine_for(self, lang: str) -> OCREngine:
        key = "manga-ocr" if lang == "ja" and self._models.is_installed("manga-ocr") else f"ppocr-{lang}"
        with self._lock:
            if key not in self._cache:
                self._cache[key] = self._create(key, lang)
            return self._cache[key]

    def describe(self, lang: str) -> str:
        if lang == "ja" and self._models.is_installed("manga-ocr"):
            return "Manga OCR"
        return "PP-OCR"

    def _create(self, key: str, lang: str) -> OCREngine:
        if key == "manga-ocr":
            from .manga_ocr import MangaOCREngine

            try:
                return MangaOCREngine(self._models.root / "manga-ocr", self._device)
            except Exception as exc:  # modelo dañado: se usa PP-OCR y se informa en el log
                log.error("No se pudo cargar Manga OCR (%s); se usa PP-OCR.", exc)
        from .ppocr import PaddleOCREngine

        return PaddleOCREngine(lang, self._device)

    def reset(self, device: Device | None = None) -> None:
        with self._lock:
            self._cache.clear()
            if device:
                self._device = device
