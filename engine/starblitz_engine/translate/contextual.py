"""Motor de traducción contextual por páginas.

Cada página se traduce con:
- la ficha de la obra (sinopsis, notas de estilo, personajes y glosario),
- el resumen acumulado de lo ocurrido,
- la página anterior ya traducida (continuidad de diálogos),
- la página siguiente en versión original (para resolver ambigüedades),
- la imagen de la página con los textos numerados (quién habla y con qué emoción).
Después, en modo «calidad máxima», un segundo pase de corrección editorial
revisa fidelidad y naturalidad línea por línea.
"""

from __future__ import annotations

import logging
import re
import threading
from dataclasses import dataclass, field

from ..core.settings import TranslationSettings
from ..projects.schema import Character, GlossaryEntry, Page, Project, Region
from .llm import ChatMessage, LLMClient
from .prompts import (
    DEFAULT_PROFILE, HONORIFICS, KIND_LABELS, LANG_NAMES, PROFILES, REVIEW_SCHEMA, REVIEWER_SYSTEM, SUMMARY_NOTE,
    TRANSLATION_SCHEMA, TRANSLATOR_SYSTEM, VARIANTS,
)

log = logging.getLogger(__name__)

REVIEW_FLAGS = {"ambiguous", "ocr_suspect", "wordplay", "refused"}
MAX_AUTO_GLOSSARY = 250
_QUOTES = re.compile(r"^[「『“\"']+|[」』”\"']+$")
_REFUSAL = re.compile(
    r"(\bno puedo (ayudar|traducir|cumplir|continuar|asistir|generar)\b(?= (con|en|a)\b| (esta|ese|este|esa|eso)\b|[.,;!]|$)"
    r"|\blo siento,? (pero )?no (puedo|me es posible) (ayudar|traducir|cumplir|continuar|asistir|generar)\b"
    r"|\bno (me )?es posible (traducir|ayudar con)\b"
    r"|\bcomo (un )?(modelo de lenguaje|asistente de ia|inteligencia artificial)\b"
    r"|\bi['’]?m sorry,? (but )?i (can['’]?t|cannot|am unable to|won['’]?t) (help|assist|translate|comply|continue|provide)\b"
    r"|\bi (can['’]?t|cannot|am unable to) (help|assist|translate|comply|continue) with\b"
    r"|\bas an ai (language )?model\b)", re.I)


@dataclass
class PageTranslation:
    updated: list[Region]
    summary: str
    new_terms: list[GlossaryEntry] = field(default_factory=list)
    characters: list[Character] = field(default_factory=list)
    reviewed: int = 0


class ContextualTranslator:
    def __init__(self, client: LLMClient, model: str, settings: TranslationSettings):
        self.client = client
        self.model = model
        self.s = settings

    # ------------------------------------------------------------------
    def translate_page(self, project: Project, page: Page, *, prev_page: Page | None, next_page: Page | None,
                       story: list[str], image_jpeg: bytes | None, cancel: threading.Event | None = None) -> PageTranslation:
        # Lo que la persona aprobó o editó a mano nunca se vuelve a traducir (se usa solo como contexto).
        targets = [r for r in page.regions if r.source_text.strip() and r.status not in ("approved", "edited")]
        if not targets:
            return PageTranslation(updated=[], summary=page.summary)
        numbering = {r.id: i + 1 for i, r in enumerate(page.regions)}

        variant_name, variant_rules = VARIANTS[project.target_variant]
        system = TRANSLATOR_SYSTEM.format(
            variant_name=variant_name, variant_rules=variant_rules, honorifics=HONORIFICS[project.honorifics],
            profile_rules=_profile_rules(project),
        )
        user = self._context_block(project, page, prev_page, next_page, story)
        user += "\n\nPÁGINA ACTUAL ({}/{}) — textos en orden de lectura:\n".format(page.index + 1, len(project.page_ids))
        fixed = [r for r in page.regions if r not in targets and r.translation.strip()]
        for r in page.regions:
            if r in targets:
                user += f"[{numbering[r.id]}] ({KIND_LABELS.get(r.kind, r.kind)}, máx. ~{r.max_chars} caracteres) {r.source_text}\n"
        if fixed:
            user += "\nYa traducidos y aprobados por el usuario en esta página (no los cambies, úsalos como contexto):\n"
            for r in fixed:
                user += f"[{numbering[r.id]}] {r.source_text} → {r.translation}\n"
        if image_jpeg:
            user += ("\nSe adjunta la imagen de la página: cada texto está marcado con su número en un círculo. "
                     "Úsala para identificar quién habla, a quién y con qué emoción.\n")
        user += f"\nDevuelve un elemento en «items» por cada número traducible. En «page_summary»: {SUMMARY_NOTE}"

        result = self.client.chat_json(
            [ChatMessage("system", system), ChatMessage("user", user, images=[image_jpeg] if image_jpeg else [])],
            TRANSLATION_SCHEMA, model=self.model, cancel=cancel,
        )
        by_n = {int(it.get("n", -1)): it for it in result.get("items", []) if isinstance(it, dict)}

        drafts: dict[str, dict] = {}
        for r in targets:
            item = by_n.get(numbering[r.id])
            if item:
                drafts[r.id] = item

        reviewed = 0
        if self.s.quality == "max" and drafts:
            reviewed = self._review(project, page, targets, numbering, drafts, user_context=self._context_block(
                project, page, prev_page, None, story, compact=True), cancel=cancel)

        updated: list[Region] = []
        for r in targets:
            item = drafts.get(r.id)
            region = r.model_copy(deep=True)
            if not item or not str(item.get("translation", "")).strip():
                region.flags = sorted(set(region.flags) | {"untranslated"})
                region.status = "review"
                region.note = region.note or "El modelo no devolvió traducción para este texto."
                updated.append(region)
                continue
            text = _clean(str(item.get("final") or item["translation"]))
            if _REFUSAL.search(text) and not _REFUSAL.search(r.source_text):
                # El modelo contestó con una negativa en lugar de traducir: no se guarda como traducción.
                region.translation = ""
                region.flags = sorted(set(region.flags) | {"refused"})
                region.status = "review"
                region.note = ("El modelo se negó a traducir este texto en lugar de traducirlo. Prueba con otro modelo "
                               "en Modelos o escribe la traducción a mano.")
                updated.append(region)
                continue
            flags = {f for f in item.get("flags", []) if isinstance(f, str)}
            confidence = _clamp(item.get("confidence", 0.8))
            region.translation = text
            region.speaker = str(item.get("speaker", ""))[:80]
            region.emotion = str(item.get("emotion", ""))[:60]
            region.note = str(item.get("note", ""))[:500]
            region.review_note = str(item.get("issue", ""))[:300]
            region.ocr_fix = str(item.get("source_fix", ""))[:400] if "ocr_suspect" in flags else ""
            region.confidence = confidence
            if r.max_chars and len(text) > r.max_chars * 1.35:
                flags.add("too_long")
            region.flags = sorted(flags)
            needs_review = confidence < self.s.review_threshold or bool(flags & REVIEW_FLAGS) or "too_long" in flags
            region.status = "review" if needs_review else "translated"
            updated.append(region)

        own_terms = {d.source.lower() for d in self.s.dictionary}  # lo que ya está en el diccionario personal no se vuelve a proponer
        new_terms = [GlossaryEntry(source=str(t.get("source", "")).strip(), target=str(t.get("target", "")).strip(),
                                   note=str(t.get("note", ""))[:200])
                     for t in result.get("new_terms", []) if isinstance(t, dict)]
        characters = []
        for c in result.get("characters", []):
            if isinstance(c, dict) and str(c.get("source", "")).strip():
                gender = c.get("gender") if c.get("gender") in ("m", "f", "n", "?") else "?"
                characters.append(Character(source=str(c["source"]).strip()[:80], target=str(c.get("target", "")).strip()[:80],
                                            gender=gender, speech=str(c.get("speech", ""))[:200]))
        return PageTranslation(updated=updated, summary=str(result.get("page_summary", ""))[:600],
                               new_terms=[t for t in new_terms if t.source and t.target and t.source.lower() not in own_terms],
                               characters=characters,
                               reviewed=reviewed)

    # ------------------------------------------------------------------
    def _review(self, project: Project, page: Page, targets: list[Region], numbering: dict[str, int],
                drafts: dict[str, dict], user_context: str, cancel: threading.Event | None) -> int:
        variant_name, variant_rules = VARIANTS[project.target_variant]
        system = REVIEWER_SYSTEM.format(variant_name=variant_name, variant_rules=variant_rules, profile_rules=_profile_rules(project))
        lines = []
        for r in targets:
            d = drafts.get(r.id)
            if d:
                hint = f" | hablante: {d.get('speaker')}" if d.get("speaker") else ""
                emo = f" | emoción: {d.get('emotion')}" if d.get("emotion") else ""
                lines.append(f"[{numbering[r.id]}] ({KIND_LABELS.get(r.kind, r.kind)}, máx. ~{r.max_chars}{hint}{emo})\n"
                             f"  ORIGINAL: {r.source_text}\n  TRADUCCIÓN: {d.get('translation', '')}")
        user = (user_context + "\n\nREVISA ESTAS LÍNEAS (página {}):\n".format(page.index + 1) + "\n".join(lines)
                + "\n\nDevuelve un elemento por línea con la versión final.")
        try:
            result = self.client.chat_json([ChatMessage("system", system), ChatMessage("user", user)], REVIEW_SCHEMA,
                                           model=self.model, temperature=0.2, cancel=cancel)
        except Exception as exc:  # la corrección es una mejora: si falla se conserva el borrador
            from ..core.errors import CancelledError

            if isinstance(exc, CancelledError):
                raise
            log.warning("Fallo en la revisión editorial de la página %s: %s", page.index + 1, exc)
            return 0
        by_n = {int(it.get("n", -1)): it for it in result.get("items", []) if isinstance(it, dict)}
        changed = 0
        for r in targets:
            d, rev = drafts.get(r.id), by_n.get(numbering[r.id])
            if not d or not rev or not str(rev.get("final", "")).strip():
                continue
            final = _clean(str(rev["final"]))
            if final != _clean(str(d.get("translation", ""))):
                changed += 1
                d["issue"] = str(rev.get("issue", ""))
            d["final"] = final
            # La confianza final es la más prudente de las dos opiniones.
            d["confidence"] = min(_clamp(d.get("confidence", 0.8)), _clamp(rev.get("confidence", 0.8)))
        return changed

    # ------------------------------------------------------------------
    def _context_block(self, project: Project, page: Page, prev_page: Page | None, next_page: Page | None,
                       story: list[str], compact: bool = False) -> str:
        parts = [f"OBRA: {project.name}", f"Idioma original: {LANG_NAMES.get(project.lang, project.lang)}"]
        if project.synopsis.strip():
            parts.append(f"Sinopsis: {project.synopsis.strip()}")
        if project.style_notes.strip():
            parts.append(f"Indicaciones del usuario (obligatorias): {project.style_notes.strip()}")
        if project.characters:
            parts.append("PERSONAJES (original → nombre en español; género; forma de hablar):")
            for c in project.characters[:60]:
                g = {"m": "masc.", "f": "fem.", "n": "neutro"}.get(c.gender, "?")
                parts.append(f"- {c.source} → {c.target or c.source}; {g}; {c.speech or '—'}")
        glossary = self._relevant_glossary(project, page, prev_page, next_page, self.s.dictionary)
        if glossary:
            parts.append("GLOSARIO (obligatorio):")
            parts.extend(f"- {g.source} → {g.target}" + (f" ({g.note})" if g.note else "") for g in glossary)
        if story:
            parts.append("LO OCURRIDO HASTA AHORA:")
            parts.extend(f"- {s}" for s in story[-12:])
        if prev_page and prev_page.regions:
            parts.append(f"PÁGINA ANTERIOR ({prev_page.index + 1}), ya traducida:")
            for r in prev_page.regions[-10:]:
                if r.source_text.strip():
                    who = f"{r.speaker}: " if r.speaker else ""
                    parts.append(f"- {who}{r.source_text} → {r.translation or '(sin traducir)'}")
        if next_page and next_page.regions and not compact:
            parts.append(f"PÁGINA SIGUIENTE ({next_page.index + 1}), solo como contexto, NO la traduzcas:")
            parts.extend(f"- {r.source_text}" for r in next_page.regions[:10] if r.source_text.strip())
        return "\n".join(parts)

    @staticmethod
    def _relevant_glossary(project: Project, page: Page, prev_page: Page | None, next_page: Page | None,
                           dictionary: list[GlossaryEntry] | None = None) -> list[GlossaryEntry]:
        terms = effective_glossary(project, dictionary or [])
        if len(terms) <= 40:
            return terms
        text = " ".join(r.source_text for p in (page, prev_page, next_page) if p for r in p.regions)
        return [g for g in terms if g.locked or g.source in text][:80]


def _profile_rules(project: Project) -> str:
    """Instrucción del perfil de traducción del proyecto (los proyectos antiguos usan «natural»)."""
    return PROFILES.get(getattr(project, "translation_profile", DEFAULT_PROFILE), PROFILES[DEFAULT_PROFILE])[2]


def effective_glossary(project: Project, dictionary: list[GlossaryEntry]) -> list[GlossaryEntry]:
    """Glosario del proyecto más el diccionario personal; si un término está en ambos, manda el del proyecto."""
    known = {g.source.lower() for g in project.glossary}
    return [*project.glossary, *(d for d in dictionary if d.source.lower() not in known)]


def merge_memory(project: Project, result: PageTranslation) -> None:
    """Incorpora términos y personajes sugeridos sin pisar lo que el usuario fijó."""
    known_terms = {g.source.lower() for g in project.glossary}
    auto = sum(1 for g in project.glossary if not g.locked)
    for t in result.new_terms:
        if t.source.lower() not in known_terms and auto < MAX_AUTO_GLOSSARY:
            project.glossary.append(t)
            known_terms.add(t.source.lower())
            auto += 1
    by_source = {c.source.lower(): c for c in project.characters}
    for c in result.characters:
        existing = by_source.get(c.source.lower())
        if existing is None:
            if len(project.characters) < 80:
                project.characters.append(c)
                by_source[c.source.lower()] = c
        elif not existing.locked:
            existing.target = existing.target or c.target
            existing.gender = existing.gender if existing.gender != "?" else c.gender
            existing.speech = existing.speech or c.speech


def estimate_max_chars(layout_box: tuple[int, int, int, int], line_size: float, page_height: int, in_bubble: bool) -> int:
    """Caracteres que caben con un cuerpo de letra legible (≈ el del original)."""
    x1, y1, x2, y2 = layout_box
    w, h = max(1, x2 - x1), max(1, y2 - y1)
    font = max(line_size * 0.8, page_height * 0.013, 11.0)
    fill = 0.62 if in_bubble else 0.8  # los globos elípticos aprovechan menos superficie
    per_line = max(1.0, w * 0.9 / (font * 0.55))
    lines = max(1.0, h * 0.9 / (font * 1.15))
    return int(max(6, min(500, per_line * lines * fill)))


def _clean(text: str) -> str:
    text = _QUOTES.sub("", text.strip())
    text = text.replace("...", "…")
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def _clamp(v) -> float:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 0.5
