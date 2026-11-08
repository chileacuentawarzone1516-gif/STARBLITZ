"""Detección automática del idioma original (japonés o inglés) a partir de la propia página.

El detector de texto clasifica cada bloque como japonés o inglés; eso se combina con la orientación
(el texto japonés de manga es casi siempre vertical) y se confirma leyendo unas líneas con el OCR:
la escritura (kana/kanji frente a letras latinas) no miente.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass

from .detector import DetectedBlock


@dataclass(frozen=True)
class ScriptCounts:
    kana: int = 0
    han: int = 0
    hangul: int = 0
    latin: int = 0

    @property
    def letters(self) -> int:
        return self.kana + self.han + self.hangul + self.latin


def script_counts(text: str) -> ScriptCounts:
    kana = han = hangul = latin = 0
    for ch in text:
        if not ch.isalpha():
            continue
        code = ord(ch)
        if 0x3040 <= code <= 0x30FF or 0xFF66 <= code <= 0xFF9F:
            kana += 1
        elif 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
            han += 1
        elif 0xAC00 <= code <= 0xD7AF or 0x1100 <= code <= 0x11FF:
            hangul += 1
        elif unicodedata.name(ch, "").startswith("LATIN"):
            latin += 1
    return ScriptCounts(kana, han, hangul, latin)


def guess_from_blocks(blocks: Iterable[DetectedBlock]) -> tuple[str | None, float]:
    """(idioma, confianza 0–1) según el detector; ``None`` si no hay texto suficiente."""
    ja = en = 0.0
    n = 0
    for b in blocks:
        weight = float(b.area) ** 0.5 * max(b.confidence, 0.2)
        if b.lang_hint == "ja":
            ja += weight
        elif b.lang_hint == "eng":
            en += weight
        if b.vertical:
            ja += weight * 0.5
        n += 1
    total = ja + en
    if n < 2 or total <= 0:
        return None, 0.0
    return ("ja", ja / total) if ja >= en else ("en", en / total)


def guess_from_text(texts: Iterable[str]) -> str | None:
    """Idioma según la escritura del texto reconocido; ``None`` si no concluyente."""
    k = h = hg = la = 0
    for t in texts:
        c = script_counts(t)
        k, h, hg, la = k + c.kana, h + c.han, hg + c.hangul, la + c.latin
    letters = k + h + hg + la
    if letters < 6:
        return None
    if (k + h) / letters >= 0.5 and k > 0:
        return "ja"
    if la / letters >= 0.7:
        return "en"
    return None


def direction_for(lang: str) -> str:
    return "rtl" if lang in ("ja", "zh", "zh-hant") else "ltr"


__all__ = ["script_counts", "guess_from_blocks", "guess_from_text", "direction_for", "ScriptCounts"]
