"""OCR multilingüe PP-OCR (PaddleOCR) ejecutado con ONNX Runtime vía RapidOCR.

PP-OCRv6 (incluido en el paquete, sin descarga) cubre chino, inglés, japonés
y la mayoría de idiomas latinos. El coreano usa PP-OCRv5, que RapidOCR
descarga automáticamente la primera vez.
"""

from __future__ import annotations

import logging
import re
import threading

import numpy as np

from ...core.onnx import Device
from ..detector import DetectedBlock
from .base import OCRResult, crop_bbox, ordered_lines, warp_line

log = logging.getLogger(__name__)

_LANG_MAP = {
    "ja": ("PP-OCRv6", "japan", "small"),
    "zh": ("PP-OCRv6", "ch", "small"),
    "zh-hant": ("PP-OCRv6", "chinese_cht", "small"),
    "ko": ("PP-OCRv5", "korean", "mobile"),
}
_CJK = {"ja", "zh", "zh-hant", "ko"}


class PaddleOCREngine:
    def __init__(self, lang: str, device: Device = "auto"):
        import onnxruntime as ort
        from rapidocr import RapidOCR  # importación diferida: es pesada
        from rapidocr.utils.typings import LangRec, ModelType, OCRVersion

        version, lang_type, model_type = _LANG_MAP.get(lang, ("PP-OCRv6", "en", "small"))
        self.id = f"ppocr-{lang_type}"
        self.lang = lang
        providers = set(ort.get_available_providers())
        params = {
            "Global.log_level": "error",
            "Rec.ocr_version": OCRVersion(version),
            "Rec.lang_type": LangRec(lang_type),
            "Rec.model_type": ModelType(model_type),
            "EngineConfig.onnxruntime.use_cuda": device != "cpu" and "CUDAExecutionProvider" in providers,
            "EngineConfig.onnxruntime.use_dml": device != "cpu" and "DmlExecutionProvider" in providers
            and "CUDAExecutionProvider" not in providers,
        }
        self._engine = RapidOCR(params=params)
        self._rec = self._engine._load_rec_model()
        self._lock = threading.Lock()

    def recognize(self, img_bgr: np.ndarray, block: DetectedBlock) -> OCRResult:
        from rapidocr.ch_ppocr_rec.typings import TextRecInput

        crops: list[np.ndarray] = []
        lines = ordered_lines(block) if block.lines else []
        if lines:
            for poly in lines:
                crop = warp_line(img_bgr, poly)
                if crop.shape[0] >= crop.shape[1] * 1.5:
                    crop = np.rot90(crop)  # convención de PaddleOCR para columnas verticales
                crops.append(np.ascontiguousarray(crop))
        else:
            crop = crop_bbox(img_bgr, block.bbox, pad=2)
            if block.vertical:
                crop = np.ascontiguousarray(np.rot90(crop))
            crops.append(crop)

        with self._lock:
            out = self._rec(TextRecInput(img=crops))
        texts = [t.strip() for t in (out.txts or ()) ]
        scores = list(out.scores or [])
        pairs = [(t, s) for t, s in zip(texts, scores) if t]
        if not pairs:
            return OCRResult("", 0.0, self.id)
        text = _join(pairs, cjk=self.lang in _CJK)
        weights = [len(t) for t, _ in pairs]
        conf = float(np.average([s for _, s in pairs], weights=weights))
        return OCRResult(text, conf, self.id)


def _join(pairs: list[tuple[str, float]], cjk: bool) -> str:
    if cjk:
        return "".join(t for t, _ in pairs)
    out = ""
    for t, _ in pairs:
        if out.endswith("-") and len(out) > 1 and out[-2].isalpha() and t[:1].islower():
            out = out[:-1] + t  # palabra partida con guion al final de línea
        else:
            out = f"{out} {t}" if out else t
    return re.sub(r"\s+", " ", out).strip()
