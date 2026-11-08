"""Formato de proyecto STARBLITZ (versión 1).

Es el mismo formato que usan la app de escritorio y la móvil
(`apps/shared/src/types.ts`). Las páginas se guardan en archivos propios para
que editar un globo no reescriba todo el proyecto.
"""

from __future__ import annotations

import time
from typing import Literal

from pydantic import BaseModel, Field, field_validator

FORMAT_VERSION = 1

TranslationProfile = Literal["natural", "fiel", "coloquial", "formal", "adaptacion"]
RegionKind = Literal["dialogue", "thought", "narration", "sfx", "other"]
RegionStatus = Literal["pending", "translated", "review", "approved", "edited"]
PageStatus = Literal["imported", "analyzed", "translated", "cleaned", "error"]
Direction = Literal["rtl", "ltr"]
AUTO_LANG = "auto"

FLAG_LABELS = {
    "idiom": "Expresión idiomática",
    "wordplay": "Juego de palabras",
    "sarcasm": "Sarcasmo o ironía",
    "honorific": "Honorífico",
    "cultural": "Referencia cultural",
    "ambiguous": "Ambiguo",
    "ocr_suspect": "Posible error de OCR",
    "too_long": "Texto largo para el globo",
    "untranslated": "Sin traducir",
    "refused": "El modelo se negó a traducir",
}

_HEX = "0123456789abcdefABCDEF"


def now() -> float:
    return round(time.time(), 3)


class Bubble(BaseModel):
    polygon: list[list[int]]
    bbox: tuple[int, int, int, int]
    fill: tuple[int, int, int]
    uniform: bool


class TextStyle(BaseModel):
    font: Literal["dialogue", "narration", "shout", "whisper", "handwritten", "sfx"] = "dialogue"
    size: float | None = Field(None, ge=4, le=400)  # None = ajuste automático
    align: Literal["center", "left", "right"] = "center"
    color: str = "#111111"
    stroke_color: str = "#ffffff"
    stroke_width: float = Field(0.0, ge=0, le=40)
    bold: bool = False
    italic: bool = False
    uppercase: bool = False
    line_height: float = Field(1.12, ge=0.7, le=2.5)
    letter_spacing: float = Field(0.0, ge=-5, le=30)
    rotation: float = Field(0.0, ge=-90, le=90)

    @field_validator("color", "stroke_color")
    @classmethod
    def _hex(cls, v: str) -> str:
        if len(v) not in (4, 7) or v[0] != "#" or any(c not in _HEX for c in v[1:]):
            raise ValueError("Color no válido (usa #rrggbb)")
        return v.lower()


class Region(BaseModel):
    id: str
    order: int
    kind: RegionKind = "dialogue"
    bbox: tuple[int, int, int, int]
    lines: list[list[list[int]]] = []
    vertical: bool = False
    line_size: float = 0.0
    bubble: Bubble | None = None
    layout_box: tuple[int, int, int, int]
    source_text: str = ""
    ocr_confidence: float = 0.0
    ocr_engine: str = ""
    ocr_fix: str = ""
    translation: str = ""
    speaker: str = ""
    emotion: str = ""
    confidence: float | None = None
    flags: list[str] = []
    note: str = ""
    review_note: str = ""
    status: RegionStatus = "pending"
    erase: bool = True
    render: bool = True
    max_chars: int = 0
    style: TextStyle = TextStyle()
    updated: float = Field(default_factory=now)


class Page(BaseModel):
    id: str
    index: int
    filename: str
    ext: str
    width: int
    height: int
    sha1: str
    dhash: str
    duplicate_of: str | None = None
    status: PageStatus = "imported"
    approved: bool = False
    regions: list[Region] = []
    panels: list[tuple[int, int, int, int]] = []
    ocr_engine: str = ""
    summary: str = ""
    error: str = ""
    has_clean: bool = False
    updated: float = Field(default_factory=now)


class Character(BaseModel):
    source: str
    target: str
    gender: Literal["m", "f", "n", "?"] = "?"
    speech: str = ""
    locked: bool = False  # definido o confirmado por el usuario: la IA no lo cambia


class GlossaryEntry(BaseModel):
    source: str
    target: str
    note: str = ""
    locked: bool = False


class Project(BaseModel):
    format: int = FORMAT_VERSION
    id: str
    name: str = Field(min_length=1, max_length=120)
    created: float = Field(default_factory=now)
    updated: float = Field(default_factory=now)
    source_lang: str = "ja"            # código de idioma o "auto" (se detecta al procesar)
    detected_lang: str = ""            # idioma detectado cuando source_lang == "auto"
    target_variant: Literal["es-419", "es-ES"] = "es-419"
    reading_direction: Direction = "rtl"
    direction_auto: bool = False       # el sentido de lectura se deduce del idioma detectado
    honorifics: Literal["adapt", "keep"] = "adapt"
    sfx: Literal["keep", "note"] = "keep"
    translation_profile: TranslationProfile = "natural"  # criterio de traducción (perfil)
    synopsis: str = Field("", max_length=4000)
    style_notes: str = Field("", max_length=2000)
    page_ids: list[str] = []
    characters: list[Character] = []
    glossary: list[GlossaryEntry] = []
    cover_page_id: str | None = None
    last_job: dict | None = None

    @property
    def lang(self) -> str:
        """Idioma efectivo del original: el elegido o, en modo automático, el detectado (japonés mientras no se sepa)."""
        if self.source_lang != AUTO_LANG:
            return self.source_lang
        return self.detected_lang or "ja"


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    source_lang: str = AUTO_LANG
    target_variant: Literal["es-419", "es-ES"] | None = None
    reading_direction: Direction | None = None
    honorifics: Literal["adapt", "keep"] | None = None
    translation_profile: TranslationProfile | None = None
    synopsis: str = Field("", max_length=4000)


class ProjectUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    source_lang: str | None = None
    target_variant: Literal["es-419", "es-ES"] | None = None
    reading_direction: Direction | None = None
    honorifics: Literal["adapt", "keep"] | None = None
    sfx: Literal["keep", "note"] | None = None
    translation_profile: TranslationProfile | None = None
    synopsis: str | None = Field(None, max_length=4000)
    style_notes: str | None = Field(None, max_length=2000)
    characters: list[Character] | None = None
    glossary: list[GlossaryEntry] | None = None


class RegionUpdate(BaseModel):
    """Campos editables desde el editor (el resto los calcula el motor)."""

    kind: RegionKind | None = None
    source_text: str | None = Field(None, max_length=4000)
    translation: str | None = Field(None, max_length=4000)
    speaker: str | None = Field(None, max_length=120)
    status: RegionStatus | None = None
    erase: bool | None = None
    render: bool | None = None
    layout_box: tuple[int, int, int, int] | None = None
    bbox: tuple[int, int, int, int] | None = None
    order: int | None = None
    style: TextStyle | None = None
    flags: list[str] | None = None
