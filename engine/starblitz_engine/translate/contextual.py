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
from . import quality
from .fit import fit_chars, region_fits
from .llm import ChatMessage, InvalidJSONError, LLMClient, salvage_items
from .prompts import (
    DEFAULT_PROFILE, ECHO_NOTE, HONORIFICS, KIND_LABELS, LANG_NAMES, PROFILES, RECOVER_ATTEMPTS, RECOVER_HEADER, RECOVER_MAX_SEGMENTS,
    RECOVER_MAX_TOKENS, RECOVER_NOTE, REPAIR_HEADER, REVIEW_SCHEMA, REVIEWER_SYSTEM, SHORTEN_HEADER, SHORTEN_MAX_RATIO,
    SHORTEN_MIN_KEEP, SUMMARY_NOTE, TRANSLATION_SCHEMA, TRANSLATOR_SYSTEM, VARIANTS,
)

log = logging.getLogger(__name__)

REVIEW_FLAGS = {"ambiguous", "ocr_suspect", "wordplay", "refused", "variant", "name"}
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
    repaired: int = 0  # textos que necesitaron la llamada de reparación (desalineados, inventados, «vosotros», nombres)
    json_invalid: int = 0  # respuestas del modelo que no eran JSON válido ni tras su reintento
    salvaged: int = 0      # textos rescatados de una respuesta rota (completos y con el eco de SU original)
    recovered: int = 0     # textos recuperados pidiéndolos uno a uno tras una respuesta rota
    json_lost: int = 0     # textos que se quedaron sin traducción por respuestas rotas (conservan el original)
    condensed: int = 0     # traducciones sustituidas por una reformulación más corta porque no cabían en su globo


class ContextualTranslator:
    uses_image = True

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
        user += f"\nDevuelve un elemento en «items» por cada número traducible. {ECHO_NOTE} En «page_summary»: {SUMMARY_NOTE}"

        stats = {"json_invalid": 0, "salvaged": 0, "recovered": 0, "condensed": 0}
        broken = False
        try:
            result = self.client.chat_json(
                [ChatMessage("system", system), ChatMessage("user", user, images=[image_jpeg] if image_jpeg else [])],
                TRANSLATION_SCHEMA, model=self.model, cancel=cancel,
            )
        except InvalidJSONError as exc:
            # Una respuesta ilegible ya no hace fallar la página: se rescatan los textos completos que sí llegaron y el resto
            # se pide uno a uno (`_recover`). Lo que no se consiga conserva el original.
            log.warning("Página %s: respuesta JSON inválida%s; se recupera por textos.", page.index + 1,
                        " (cortada por el tope de tokens)" if exc.truncated else "")
            broken = True
            stats["json_invalid"] += 1
            result = {"items": salvage_items(exc.raws), "new_terms": [], "characters": [], "page_summary": ""}
        by_n = {_item_n(it.get("n")): it for it in result.get("items", []) if isinstance(it, dict)}

        drafts: dict[str, dict] = {}
        for r in targets:
            item = by_n.get(numbering[r.id])
            # De una respuesta rota solo vale un texto con el eco de SU original (la estructura ya no garantiza el orden).
            if item and (not broken or quality.echo_matches(r.source_text, str(item.get("src_start", ""))) is True):
                drafts[r.id] = item
        stats["salvaged"] = len(drafts) if broken else 0

        names = quality.known_names(project.characters, effective_glossary(project, self.s.dictionary))
        compact = self._context_block(project, page, prev_page, None, story, compact=True)
        tried: set[str] = set()
        if broken:
            tried = self._recover(project, page, [r for r in targets if r.id not in drafts], numbering, drafts, names, system,
                                  compact, cancel, stats)
        repaired = self._repair(project, page, [r for r in targets if r.id not in tried], numbering, drafts, names, system,
                                compact, cancel, stats)

        reviewed = 0
        if self.s.quality == "max" and drafts:
            reviewed = self._review(project, page, targets, numbering, drafts, user_context=self._context_block(
                project, page, prev_page, None, story, compact=True), cancel=cancel, stats=stats)
        self._shorten(project, page, targets, numbering, drafts, names, compact, cancel, stats)

        updated: list[Region] = []
        for r in targets:
            item = drafts.get(r.id)
            region = r.model_copy(deep=True)
            if not item or not str(item.get("translation", "")).strip():
                region.flags = sorted(set(region.flags) | {"untranslated"})
                region.status = "review"
                if r.id in tried:
                    region.note = ("El modelo devolvió una respuesta ilegible y este texto no se pudo recuperar: se conserva el "
                                   "original. Vuelve a traducirlo o escríbelo a mano.")
                else:
                    region.note = region.note or "El modelo no devolvió traducción para este texto."
                updated.append(region)
                continue
            text = _clean(str(item.get("final") or item["translation"]))
            issues = quality.check(r.source_text, text, str(item.get("src_start", "")), project.target_variant, names)
            blocking = [i for i in issues if i in quality.BLOCKING]
            if blocking:
                # Ni tras la reparación es la traducción de ESTE texto: no se usa (el original se conserva en el dibujo).
                region.translation = ""
                region.flags = sorted(set(region.flags) | {"untranslated", *blocking})
                region.status = "review"
                region.note = "La traducción del modelo no correspondía a este texto (desalineada o inventada); tradúcelo a mano."
                updated.append(region)
                continue
            text = quality.match_case(r.source_text, text)
            if _REFUSAL.search(text) and not _REFUSAL.search(r.source_text):
                # El modelo contestó con una negativa en lugar de traducir: no se guarda como traducción.
                region.translation = ""
                region.flags = sorted(set(region.flags) | {"refused"})
                region.status = "review"
                region.note = ("El modelo se negó a traducir este texto en lugar de traducirlo. Prueba con otro modelo "
                               "en Modelos o escribe la traducción a mano.")
                updated.append(region)
                continue
            flags = {f for f in item.get("flags", []) if isinstance(f, str)} | set(issues)
            confidence = _clamp(item.get("confidence", 0.8))
            region.translation = text
            region.speaker = str(item.get("speaker", ""))[:80]
            region.emotion = str(item.get("emotion", ""))[:60]
            region.note = str(item.get("note", ""))[:500]
            region.review_note = str(item.get("issue", ""))[:300]
            region.ocr_fix = str(item.get("source_fix", ""))[:400] if "ocr_suspect" in flags else ""
            if item.get("condensed_from"):
                flags.add("condensed")
                full = f"Versión completa (no cabía en el globo): {item['condensed_from']}"
                region.note = (f"{region.note} · {full}" if region.note else full)[:500]
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
        json_lost = sum(1 for r in targets if r.id in tried and r.id not in drafts)
        return PageTranslation(updated=updated, summary=str(result.get("page_summary", ""))[:600],
                               new_terms=[t for t in new_terms if t.source and t.target and t.source.lower() not in own_terms],
                               characters=characters,
                               reviewed=reviewed, repaired=repaired, json_invalid=stats["json_invalid"],
                               salvaged=stats["salvaged"], recovered=stats["recovered"], json_lost=json_lost,
                               condensed=stats["condensed"])

    # ------------------------------------------------------------------
    def _shorten(self, project: Project, page: Page, targets: list[Region], numbering: dict[str, int], drafts: dict[str, dict],
                 names: list[tuple[str, str]], user_context: str, cancel: threading.Event | None, stats: dict[str, int]) -> None:
        """Reformulación breve de las traducciones que no caben en su globo al cuerpo mínimo legible (`fit.region_fits`, con las
        métricas reales de las tipografías).

        Una sola llamada por página. La versión corta solo sustituye a la anterior si CABE, es de verdad más corta, conserva la
        mayor parte del contenido (no es un resumen), no pierde nombres propios y no tiene problemas nuevos (desalineada, inventada,
        «vosotros»). La versión completa queda en la nota del texto y se marca «condensed» para revisarla."""
        long_ones: list[tuple[Region, str, int]] = []
        for r in targets:
            d = drafts.get(r.id)
            if not d:
                continue
            text = _clean(str(d.get("final") or d.get("translation", "")))
            if not text or _REFUSAL.search(text):
                continue
            shown = quality.match_case(r.source_text, text)  # se rotula con las mayúsculas del original
            if not region_fits(r, shown, page.height):
                target = fit_chars(r, shown, page.height)
                # Si cabe menos del mínimo de contenido que se exige, acortarlo sería resumirlo: no se pide (se conserva el original).
                if target >= len(text) * SHORTEN_MIN_KEEP:
                    long_ones.append((r, text, target))
        if not long_ones:
            return
        variant_name, variant_rules = VARIANTS[project.target_variant]
        system = REVIEWER_SYSTEM.format(variant_name=variant_name, variant_rules=variant_rules, profile_rules=_profile_rules(project))
        lines = [f"[{numbering[r.id]}] (máx. ~{target} caracteres; ahora {len(text)})\n  ORIGINAL: {r.source_text}\n"
                 f"  TRADUCCIÓN: {text}" for r, text, target in long_ones]
        user = (user_context + "\n\n" + SHORTEN_HEADER.format(page=page.index + 1) + "\n" + "\n".join(lines)
                + "\n\nDevuelve un elemento por línea con la versión final.")
        try:
            result = self.client.chat_json([ChatMessage("system", system), ChatMessage("user", user)], REVIEW_SCHEMA,
                                           model=self.model, temperature=0.2, cancel=cancel)
        except Exception as exc:  # acortar es una mejora: si falla se conserva la traducción completa
            from ..core.errors import CancelledError

            if isinstance(exc, CancelledError):
                raise
            if isinstance(exc, InvalidJSONError):
                stats["json_invalid"] += 1
            log.warning("Fallo al acortar textos de la página %s: %s", page.index + 1, exc)
            return
        by_n = {_item_n(it.get("n")): it for it in result.get("items", []) if isinstance(it, dict)}
        for r, text, _target in long_ones:
            it = by_n.get(numbering[r.id])
            short = _clean(str(it.get("final", ""))) if it else ""
            if not _acceptable_short(r.source_text, text, short, project.target_variant, names):
                continue
            if not region_fits(r, quality.match_case(r.source_text, short), page.height):
                continue  # más corta pero sigue sin caber: no compensa cambiar el texto
            d = drafts[r.id]
            d["final"] = short
            d["condensed_from"] = text
            stats["condensed"] += 1

    # ------------------------------------------------------------------
    def _recover(self, project: Project, page: Page, missing: list[Region], numbering: dict[str, int], drafts: dict[str, dict],
                 names: list[tuple[str, str]], system: str, user_context: str, cancel: threading.Event | None,
                 stats: dict[str, int]) -> set[str]:
        """Tras una respuesta rota, pide cada texto que faltó por separado (con su número y el eco de su original).

        Cada texto tiene `RECOVER_ATTEMPTS` intentos con un tope de tokens bajo; se acepta solo un elemento con SU número, una
        traducción no vacía y sin problemas que impidan usarla (desalineado, inventado). Devuelve los ids intentados: no vuelven
        a la llamada de reparación (los reintentos están acotados)."""
        tried: set[str] = set()
        for r in missing[:RECOVER_MAX_SEGMENTS]:
            tried.add(r.id)
            n = numbering[r.id]
            user = (user_context + "\n\n" + RECOVER_HEADER.format(page=page.index + 1) + "\n"
                    + f"[{n}] ({KIND_LABELS.get(r.kind, r.kind)}, máx. ~{r.max_chars} caracteres) {r.source_text}\n"
                    + "\n" + RECOVER_NOTE.format(n=n, echo=ECHO_NOTE))
            for _attempt in range(RECOVER_ATTEMPTS):
                try:
                    res = self.client.chat_json([ChatMessage("system", system), ChatMessage("user", user)], TRANSLATION_SCHEMA,
                                                model=self.model, cancel=cancel, max_tokens=RECOVER_MAX_TOKENS)
                    items = [it for it in res.get("items", []) if isinstance(it, dict)]
                except InvalidJSONError as exc:
                    stats["json_invalid"] += 1
                    items = salvage_items(exc.raws)
                item = next((it for it in items if _as_int(it.get("n")) == n), None)
                if item is None or not str(item.get("translation", "")).strip():
                    continue
                issues = quality.check(r.source_text, _clean(str(item["translation"])), str(item.get("src_start", "")),
                                       project.target_variant, names)
                if any(i in quality.BLOCKING for i in issues):
                    continue
                drafts[r.id] = item
                stats["recovered"] += 1
                break
        return tried

    # ------------------------------------------------------------------
    def _repair(self, project: Project, page: Page, targets: list[Region], numbering: dict[str, int], drafts: dict[str, dict],
                names: list[tuple[str, str]], system: str, user_context: str, cancel: threading.Event | None,
                stats: dict[str, int] | None = None) -> int:
        """Una sola llamada para los textos con problemas (sin traducción, desalineados, inventados, «vosotros», nombres).

        La respuesta nueva solo sustituye a la anterior si ya no tiene problemas que impidan usarla. Devuelve cuántos textos
        se pidieron de nuevo."""
        bad: list[tuple[Region, str]] = []
        for r in targets:
            d = drafts.get(r.id)
            if not d or not str(d.get("translation", "")).strip():
                bad.append((r, quality.MISSING_TEXT))
                continue
            text = _clean(str(d["translation"]))
            issues = quality.check(r.source_text, text, str(d.get("src_start", "")), project.target_variant, names)
            if issues:
                bad.append((r, quality.describe(issues, quality.lost_names(r.source_text, text, names))))
        if not bad:
            return 0
        user = user_context + "\n\n" + REPAIR_HEADER.format(page=page.index + 1) + "\n"
        for r, problem in bad:
            user += f"[{numbering[r.id]}] ({KIND_LABELS.get(r.kind, r.kind)}, máx. ~{r.max_chars} caracteres) {r.source_text}\n"
            user += f"  Problema: {problem}\n"
        user += f"\nDevuelve un elemento en «items» por cada número de esta lista. {ECHO_NOTE} En «page_summary» deja una cadena vacía."
        strict = False
        try:
            result = self.client.chat_json([ChatMessage("system", system), ChatMessage("user", user)], TRANSLATION_SCHEMA,
                                           model=self.model, cancel=cancel)
        except InvalidJSONError as exc:  # respuesta rota: se aprovecha lo completo que traiga el eco de SU original
            if stats is not None:
                stats["json_invalid"] += 1
            result, strict = {"items": salvage_items(exc.raws)}, True
        except Exception as exc:  # la reparación es una mejora: si falla, deciden las comprobaciones finales
            from ..core.errors import CancelledError

            if isinstance(exc, CancelledError):
                raise
            log.warning("Fallo en la reparación de la página %s: %s", page.index + 1, exc)
            return len(bad)
        by_n = {_item_n(it.get("n")): it for it in result.get("items", []) if isinstance(it, dict)}
        for r, _problem in bad:
            it = by_n.get(numbering[r.id])
            if not it or not str(it.get("translation", "")).strip():
                continue
            if strict and quality.echo_matches(r.source_text, str(it.get("src_start", ""))) is not True:
                continue
            text = _clean(str(it["translation"]))
            again = quality.check(r.source_text, text, str(it.get("src_start", "")), project.target_variant, names)
            if not any(i in quality.BLOCKING for i in again):
                drafts[r.id] = it
        return len(bad)

    # ------------------------------------------------------------------
    def _review(self, project: Project, page: Page, targets: list[Region], numbering: dict[str, int],
                drafts: dict[str, dict], user_context: str, cancel: threading.Event | None,
                stats: dict[str, int] | None = None) -> int:
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
            if isinstance(exc, InvalidJSONError) and stats is not None:
                stats["json_invalid"] += 1
            log.warning("Fallo en la revisión editorial de la página %s: %s", page.index + 1, exc)
            return 0
        by_n = {_item_n(it.get("n")): it for it in result.get("items", []) if isinstance(it, dict)}
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
    # EXACTAMENTE el cuerpo mínimo del maquetador (`sizeBounds` en `typeset/render.ts`): hasta el 75 % del cuerpo original, nunca
    # por debajo del 0,5 % de la página ni por encima del 0,8 %. Antes se tomaba el MAYOR de los dos (un cuerpo más grande que el
    # mínimo real), así que la capacidad salía corta y la reformulación breve se habría pedido de más (2026-11-10).
    fixed = max(8.0, page_height * 0.0072)  # = fit.MIN_FONT_CAP
    relative = line_size * 0.75 if line_size > 0 else fixed
    font = max(8.0, page_height * 0.005, min(fixed, relative))
    fill = 0.62 if in_bubble else 0.8  # los globos elípticos aprovechan menos superficie
    per_line = max(1.0, w * 0.9 / (font * 0.55))
    lines = max(1.0, h * 0.9 / (font * 1.15))
    return int(max(6, min(500, per_line * lines * fill)))


def _clean(text: str) -> str:
    text = _QUOTES.sub("", text.strip())
    text = text.replace("...", "…")
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def _acceptable_short(source: str, text: str, short: str, variant: str, names: list[tuple[str, str]]) -> bool:
    """¿La reformulación corta puede sustituir a la traducción? Más corta, sin perder la mayor parte del contenido, sin perder
    nombres y sin problemas nuevos. Lo que no se pueda comprobar automáticamente (matices) lo revisa la persona (nota)."""
    if not short or _REFUSAL.search(short) or len(short) > len(text) * SHORTEN_MAX_RATIO:
        return False
    if quality.content_length(short) < quality.content_length(text) * SHORTEN_MIN_KEEP:
        return False
    if quality.ends_dangling(short) and not quality.ends_dangling(text):
        return False  # «Después de usted—» → «Después de—»: pierde el sentido aunque conserve letras
    before = set(quality.check(source, text, "", variant, names))
    after = set(quality.check(source, short, "", variant, names))
    return not (after - before)


def _as_int(v) -> int | None:
    """Número de texto de un elemento: entero (o real sin decimales); cualquier otra cosa no vale."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")) or v != int(v):
        return None
    return int(v)


def _item_n(v) -> int | None:
    """Número de un elemento de la respuesta. Antes ``int(it.get("n", -1))``: un ``null`` tumbaba la página entera y un
    ``2.7`` llevaba la traducción al globo 2. Se aceptan enteros, reales sin decimales y cifras entre comillas."""
    if isinstance(v, str) and re.fullmatch(r"\s*[0-9]+\s*", v):
        return int(v.strip())
    return _as_int(v)


def _clamp(v) -> float:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 0.5
