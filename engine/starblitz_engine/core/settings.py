"""Ajustes globales persistentes del motor."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError as PydanticValidationError, field_validator

from ..projects.schema import GlossaryEntry, TranslationProfile
from .errors import ValidationError
from .fsutil import atomic_write_json, read_json

TargetVariant = Literal["es-419", "es-ES"]
MAX_DICTIONARY = 500


class LLMSettings(BaseModel):
    # builtin: llama.cpp integrado (por defecto) · ollama / openai: servidor externo ya instalado por el usuario
    provider: Literal["builtin", "ollama", "openai"] = "builtin"
    base_url: str = "http://127.0.0.1:11434"  # solo para servidores externos
    model: str = ""  # builtin: id del modelo instalado; vacío = el recomendado para el equipo
    temperature: float = Field(0.3, ge=0.0, le=1.5)
    context_window: int = Field(12288, ge=2048, le=262144)
    use_vision: bool = True
    timeout_s: int = Field(600, ge=30, le=3600)
    idle_unload_minutes: int = Field(10, ge=0, le=240)  # 0 = mantener cargado
    api_key: str = ""    # servidores externos que lo exijan; nunca se devuelve en claro
    hf_token: str = ""   # opcional, solo para repositorios restringidos de Hugging Face; nunca se devuelve en claro

    @field_validator("base_url")
    @classmethod
    def _strip_slash(cls, v: str) -> str:
        v = v.strip().rstrip("/")
        if not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("La URL debe empezar por http:// o https://")
        return v


class TranslationSettings(BaseModel):
    target_variant: TargetVariant = "es-419"
    quality: Literal["auto", "balanced", "max"] = "auto"  # auto: según el perfil del dispositivo
    honorifics: Literal["adapt", "keep"] = "adapt"
    sfx: Literal["keep", "note"] = "keep"
    review_threshold: float = Field(0.72, ge=0.0, le=1.0)
    profile: TranslationProfile = "natural"  # perfil de traducción de los proyectos nuevos
    # Diccionario personal: términos que se aplican en TODOS los proyectos (el glosario de cada proyecto manda si coincide).
    dictionary: list[GlossaryEntry] = Field(default_factory=list, max_length=MAX_DICTIONARY)

    @field_validator("dictionary")
    @classmethod
    def _clean_dictionary(cls, entries: list[GlossaryEntry]) -> list[GlossaryEntry]:
        seen: set[str] = set()
        out: list[GlossaryEntry] = []
        for e in entries:
            source, target = e.source.strip()[:200], e.target.strip()[:200]
            if not source or not target or source.lower() in seen:
                continue
            seen.add(source.lower())
            out.append(GlossaryEntry(source=source, target=target, note=e.note.strip()[:300], locked=True))
        return out


class ProcessingSettings(BaseModel):
    device: Literal["auto", "gpu", "cpu"] = "auto"
    max_pages: int = Field(50, ge=1, le=1000)
    inpaint: Literal["auto", "lama", "fast"] = "auto"
    profile: Literal["auto", "low", "mid", "high", "pc-gpu"] = "auto"  # perfil de rendimiento (auto = según el equipo)
    # EXPERIMENTAL: «manga-det» usa el detector ligero PP-OCRv6 Manga (si está instalado). Por defecto, el de siempre.
    detector: Literal["default", "manga-det"] = "default"


class Settings(BaseModel):
    llm: LLMSettings = LLMSettings()
    translation: TranslationSettings = TranslationSettings()
    processing: ProcessingSettings = ProcessingSettings()

    def public_dict(self) -> dict[str, Any]:
        data = self.model_dump()
        for secret in ("api_key", "hf_token"):
            data["llm"][secret] = "••••" if getattr(self.llm, secret) else ""
        return data


def _deep_merge(base: dict, patch: dict) -> dict:
    out = dict(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


class SettingsStore:
    def __init__(self, path: Path):
        self._path = path
        self._lock = threading.Lock()
        raw = read_json(path, default={}) or {}
        try:
            self._settings = Settings.model_validate(raw)
        except PydanticValidationError:
            # Ajustes corruptos o de una versión incompatible: se vuelve a los valores por defecto.
            self._settings = Settings()
        self._save()

    @property
    def value(self) -> Settings:
        return self._settings

    def update(self, patch: dict[str, Any]) -> Settings:
        with self._lock:
            patch = dict(patch)
            llm_patch = patch.get("llm")
            if isinstance(llm_patch, dict):
                for secret in ("api_key", "hf_token"):
                    if llm_patch.get(secret) == "••••":
                        llm_patch.pop(secret)  # el cliente reenvió el valor enmascarado
            merged = _deep_merge(self._settings.model_dump(), patch)
            try:
                self._settings = Settings.model_validate(merged)
            except PydanticValidationError as exc:
                first = exc.errors()[0]
                field = ".".join(str(p) for p in first.get("loc", ()))
                raise ValidationError("invalid_settings", f"Ajuste no válido ({field}): {first.get('msg')}") from exc
            self._save()
            return self._settings

    def _save(self) -> None:
        atomic_write_json(self._path, self._settings.model_dump())
