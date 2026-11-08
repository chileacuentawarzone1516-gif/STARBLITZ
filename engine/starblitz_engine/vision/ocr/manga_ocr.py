"""Manga OCR (kha-white) exportado a ONNX: ViT encoder + decoder BERT de caracteres.

Reconoce el bloque completo (varias columnas verticales a la vez), que es como
fue entrenado. Decodificación por haz (beam search) con las mismas reglas que
el modelo original: num_beams=4, no_repeat_ngram_size=3, length_penalty=2.0.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from pathlib import Path

import cv2
import numpy as np

from ...core.onnx import Device, create_session
from ..detector import DetectedBlock
from .base import OCRResult, crop_bbox

log = logging.getLogger(__name__)

IMAGE_SIZE = 224


class MangaOCREngine:
    id = "manga-ocr"

    def __init__(self, model_dir: Path, device: Device = "auto", num_beams: int = 4):
        self.encoder = create_session(model_dir / "encoder_model.onnx", device)
        self.decoder = create_session(model_dir / "decoder_model.onnx", device)
        self.vocab = _load_vocab(model_dir / "vocab.txt")
        gen = json.loads((model_dir / "generation_config.json").read_text(encoding="utf-8"))
        self.start_id = int(gen.get("decoder_start_token_id", 2))
        self.eos_id = int(gen.get("eos_token_id", 3))
        self.pad_id = int(gen.get("pad_token_id", 0))
        self.max_length = min(int(gen.get("max_length", 300)), 300)
        self.no_repeat = int(gen.get("no_repeat_ngram_size", 3))
        self.length_penalty = float(gen.get("length_penalty", 2.0))
        self.num_beams = num_beams
        self._special = {self.start_id, self.eos_id, self.pad_id, 1, 4}
        self._enc_in = self.encoder.get_inputs()[0].name
        dec_inputs = {i.name for i in self.decoder.get_inputs()}
        self._dec_ids = "input_ids" if "input_ids" in dec_inputs else next(n for n in dec_inputs if "ids" in n)
        self._dec_hidden = next(n for n in dec_inputs if "hidden" in n)
        self._dec_mask = next((n for n in dec_inputs if "attention_mask" in n), None)
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    def recognize(self, img_bgr: np.ndarray, block: DetectedBlock) -> OCRResult:
        crop = crop_bbox(img_bgr, block.bbox, pad=max(2, int(block.line_size * 0.15)))
        if crop.size == 0:
            return OCRResult("", 0.0, self.id)
        pixel_values = _preprocess(crop)
        with self._lock:
            hidden = self.encoder.run(None, {self._enc_in: pixel_values})[0]
            tokens, score = self._beam_search(hidden)
        text = _post_process(self._decode(tokens))
        return OCRResult(text, float(np.clip(np.exp(score), 0.0, 1.0)), self.id)

    # ------------------------------------------------------------------
    def _logits(self, sequences: np.ndarray, hidden: np.ndarray) -> np.ndarray:
        feeds = {self._dec_ids: sequences.astype(np.int64), self._dec_hidden: np.repeat(hidden, len(sequences), axis=0)}
        if self._dec_mask:
            feeds[self._dec_mask] = np.ones(hidden.shape[:2], dtype=np.int64).repeat(len(sequences), axis=0)
        logits = self.decoder.run(None, feeds)[0]
        return logits[:, -1, :]

    def _beam_search(self, hidden: np.ndarray) -> tuple[list[int], float]:
        beams: list[tuple[list[int], float]] = [([self.start_id], 0.0)]
        finished: list[tuple[list[int], float]] = []
        for _step in range(self.max_length - 1):
            seqs = np.array([b[0] for b in beams])
            logits = self._logits(seqs, hidden)
            logp = logits - logits.max(axis=1, keepdims=True)
            logp = logp - np.log(np.exp(logp).sum(axis=1, keepdims=True))
            candidates: list[tuple[list[int], float]] = []
            for (seq, score), row in zip(beams, logp):
                row = row.copy()
                for banned in _banned_tokens(seq, self.no_repeat):
                    row[banned] = -np.inf
                k = min(len(row) - 1, self.num_beams * 2)
                top = np.argpartition(-row, k)[:k]
                for tok in top:
                    if np.isfinite(row[tok]):
                        candidates.append((seq + [int(tok)], score + float(row[tok])))
            candidates.sort(key=lambda c: c[1], reverse=True)
            beams = []
            for seq, score in candidates:
                if seq[-1] == self.eos_id:
                    length = len(seq) - 1
                    finished.append((seq, score / (length ** self.length_penalty)))
                else:
                    beams.append((seq, score))
                if len(beams) == self.num_beams:
                    break
            if not beams or (len(finished) >= self.num_beams and
                             max(f[1] for f in finished) > beams[0][1] / (len(beams[0][0]) ** self.length_penalty)):
                break
        if not finished:
            finished = [(seq, score / (len(seq) ** self.length_penalty)) for seq, score in beams]
        best_seq, best_score = max(finished, key=lambda f: f[1])
        # Confianza aproximada: log-probabilidad media por token.
        avg = best_score * (len(best_seq) ** self.length_penalty) / max(1, len(best_seq) - 1)
        return best_seq, avg

    def _decode(self, tokens: list[int]) -> str:
        out = []
        for t in tokens:
            if t in self._special or t >= len(self.vocab):
                continue
            piece = self.vocab[t]
            out.append(piece[2:] if piece.startswith("##") else piece)
        return "".join(out)


def _banned_tokens(seq: list[int], n: int) -> list[int]:
    if n <= 0 or len(seq) < n:
        return []
    prefix = tuple(seq[-(n - 1):]) if n > 1 else ()
    banned = []
    for i in range(len(seq) - n + 1):
        if tuple(seq[i:i + n - 1]) == prefix:
            banned.append(seq[i + n - 1])
    return banned


def _load_vocab(path: Path) -> list[str]:
    vocab = path.read_text(encoding="utf-8").splitlines()
    if len(vocab) < 1000:
        raise RuntimeError("El vocabulario de Manga OCR está incompleto. Vuelve a descargar el modelo.")
    return vocab


def _preprocess(crop_bgr: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    rgb = cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB)
    resized = cv2.resize(rgb, (IMAGE_SIZE, IMAGE_SIZE), interpolation=cv2.INTER_LINEAR)
    arr = resized.astype(np.float32) / 255.0
    arr = (arr - 0.5) / 0.5
    return arr.transpose(2, 0, 1)[None]


def _post_process(text: str) -> str:
    """Mismo post-procesado que manga-ocr: sin espacios, puntos suspensivos y ancho completo."""
    text = "".join(text.split())
    text = text.replace("…", "...")
    text = re.sub("[・.]{2,}", lambda m: (m.end() - m.start()) * ".", text)
    return "".join(_h2z(c) for c in text)


def _h2z(c: str) -> str:
    code = ord(c)
    if 0x21 <= code <= 0x7E:
        return chr(code + 0xFEE0)
    return c
