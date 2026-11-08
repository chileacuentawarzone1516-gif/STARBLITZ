"""Traducción «en texto plano» por lotes de página para modelos de traducción dedicados (PLaMo 3 Translate, Hy-MT2…).

Equivalente exacto de `apps/mobile/src/engine/translate/plain.ts`. El traductor contextual pide un JSON con muchos campos por texto
(≈ 1 100 tokens de SALIDA por página de 3–4 globos frente a ≈ 100 pidiendo solo la traducción: ver docs/ARQUITECTURA-TRADUCCION.md).
Aquí se envía el texto de los globos de la página en UNA llamada y se recupera solo la traducción.

No se sacrifica fidelidad: se mantiene el contexto (glosario obligatorio y últimos diálogos ya traducidos), no se omite nada (lo que
falte se vuelve a pedir uno a uno y, si sigue sin traducción, queda marcado, nunca vacío) y una negativa del modelo no se guarda
como traducción. A cambio no aprende personajes/términos nuevos ni rellena hablante/emoción, y no usa la imagen.
"""

from __future__ import annotations

import logging
import re
import threading
from dataclasses import dataclass

from ..core.errors import CancelledError
from ..core.settings import TranslationSettings
from ..projects.schema import Page, Project, Region
from .contextual import _REFUSAL, REVIEW_FLAGS, PageTranslation, _clean, effective_glossary
from .llm import ChatMessage, LLMClient

log = logging.getLogger(__name__)

EN_NAMES = {"ja": "Japanese", "ko": "Korean", "zh": "Chinese", "en": "English", "es": "Spanish", "fr": "French",
            "de": "German", "it": "Italian", "pt": "Portuguese", "ru": "Russian"}
ES_NAMES = {"ja": "japonés", "ko": "coreano", "zh": "chino", "en": "inglés", "es": "español", "fr": "francés",
            "de": "alemán", "it": "italiano", "pt": "portugués", "ru": "ruso"}
PLAMO_SOURCES = {"ja", "ko", "zh", "en", "fr", "de", "it", "pt", "ru"}
_CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯]")
_ONLY_SYMBOLS = re.compile(r"^[\W_\s…]*$", re.U)

GENERIC_SYSTEM = (
    "Eres un traductor profesional de manga, manhwa y cómics al español. Traduce de forma FIEL y COMPLETA: sin omitir, sin añadir, "
    "sin resumir, sin explicar y sin suavizar. Conserva el tono, los insultos, la vulgaridad, el contenido sexual y la violencia tal "
    "cual aparecen en el original; no los censures ni los edulcores. Mantén los nombres propios y respeta el glosario si se da. "
    "Devuelve únicamente la traducción.")


def mt_family(text: str) -> str:
    """Familia de modelo a partir de su identificador, repositorio o archivo: «plamo», «hymt» o «generic»."""
    if re.search(r"plamo[-_ ]?3[-_ ]?translate", text, re.I):
        return "plamo"
    if re.search(r"hy[-_ ]?mt", text, re.I):
        return "hymt"
    return "generic"


def is_dedicated_mt(text: str) -> bool:
    return mt_family(text) != "generic"


@dataclass
class Pair:
    source: str
    target: str


@dataclass
class PlainRequest:
    messages: list[ChatMessage]
    extra: dict
    max_tokens: int


def _numbered(texts: list[str]) -> str:
    return "\n".join(f"[{i + 1}] {t}" for i, t in enumerate(texts))


def _max_tokens(texts: list[str]) -> int:
    return min(2048, 96 + sum(max(24, len(t) * 3) for t in texts))


def build_plain_request(family: str, *, lang: str, texts: list[str], glossary: list[Pair], history: list[Pair], batch: bool,
                        variant: str = "es-419") -> PlainRequest:
    """Petición con el formato nativo de cada familia."""
    max_tokens = _max_tokens(texts)
    if family == "plamo":
        kw: dict = {"target_lang": "es"}
        if lang in PLAMO_SOURCES:
            kw["source_lang"] = lang
        if glossary:
            kw["glossary"] = [{"source": g.source, "target": g.target} for g in glossary]
        messages: list[ChatMessage] = []
        for h in history:
            messages += [ChatMessage("user", h.source), ChatMessage("assistant", h.target)]
        messages.append(ChatMessage("user", "\n".join(texts)))
        return PlainRequest(messages, {"chat_template_kwargs": kw, "stop": ["<|plamo:tag|>", "<|plamo:bos|>"]}, max_tokens)
    if family == "hymt":
        name = EN_NAMES.get(lang, lang)
        terms = ("Reference the following translations:\n" + "\n".join(f"{g.source} translates to {g.target}" for g in glossary) + "\n"
                 if glossary else "")
        if batch:
            user = (f"{terms}Translate each of the following numbered lines from {name} into Spanish. Keep the same [n] numbering, "
                    "one translation per line, and do not merge, skip or add lines. Do not soften or censor any word. "
                    "Only output the translated result without any additional explanation:\n\n" + _numbered(texts))
        else:
            user = (f"{terms}Translate the following text into Spanish. Note that you should only output the translated result "
                    f"without any additional explanation:\n\n{texts[0]}")
        return PlainRequest([ChatMessage("user", user)], {}, max_tokens)
    system = GENERIC_SYSTEM + (" Usa español de España." if variant == "es-ES" else " Usa español latino neutro.")
    if glossary:
        system += "\nGlosario obligatorio (usa exactamente estas traducciones):\n" + "\n".join(f"{g.source} => {g.target}" for g in glossary)
    origin = ES_NAMES.get(lang, lang)
    user = (f"Traduce del {origin} al español. Mantén la numeración [n], una línea por texto, sin unir, omitir ni añadir líneas:\n\n"
            f"{_numbered(texts)}" if batch else f"Traduce del {origin} al español:\n\n{texts[0]}")
    return PlainRequest([ChatMessage("system", system), ChatMessage("user", user)],
                        {"chat_template_kwargs": {"enable_thinking": False}}, max_tokens)


def parse_plain(family: str, content: str, n: int, batch: bool) -> list[str]:
    """Reparte la respuesta en `n` traducciones alineadas; lo que no se pueda asignar queda vacío (nunca se inventa)."""
    text = re.sub(r"<think>.*?</think>", "", content or "", flags=re.S).strip()
    if not batch or n == 1:
        return [text]
    if family == "plamo":
        lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
        return lines if len(lines) == n else [""] * n
    got: dict[int, str] = {}
    for line in text.split("\n"):
        m = re.match(r"^\s*\[?(\d+)[\]\.\):]\s*(.*)$", line)
        if m:
            got[int(m.group(1))] = m.group(2).strip()
    return [got.get(k + 1, "") for k in range(n)]


class PlainTranslator:
    uses_image = False

    def __init__(self, client: LLMClient, model: str, family: str, settings: TranslationSettings):
        self.client = client
        self.model = model
        self.family = family
        self.s = settings
        self.stats = {"llm_calls": 0}

    def _ask(self, *, lang: str, texts: list[str], glossary: list[Pair], history: list[Pair], batch: bool, variant: str,
             cancel: threading.Event | None) -> list[str]:
        req = build_plain_request(self.family, lang=lang, texts=texts, glossary=glossary, history=history, batch=batch, variant=variant)
        if cancel and cancel.is_set():
            raise CancelledError()
        self.stats["llm_calls"] += 1
        content = self.client.chat_plain(req.messages, model=self.model, temperature=0.0, max_tokens=req.max_tokens, extra=req.extra,
                                         cancel=cancel)
        return parse_plain(self.family, content, len(texts), batch)

    def translate_page(self, project: Project, page: Page, *, prev_page: Page | None, next_page: Page | None,
                       story: list[str], image_jpeg: bytes | None, cancel: threading.Event | None = None) -> PageTranslation:
        # Lo que la persona aprobó o editó a mano nunca se vuelve a traducir (mismo criterio que el traductor contextual).
        targets = [r for r in page.regions if r.source_text.strip() and r.status not in ("approved", "edited")]
        if not targets:
            return PageTranslation(updated=[], summary=page.summary)
        lang = project.lang
        texts = [r.source_text for r in targets]
        glossary = self._relevant_glossary(project, texts, prev_page)
        history = self._history(prev_page)
        common = {"lang": lang, "glossary": glossary, "history": history, "variant": project.target_variant, "cancel": cancel}
        try:
            outs = self._ask(texts=texts, batch=len(texts) > 1, **common)
        except CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — un fallo del lote no debe perder la página: se reintenta texto a texto
            log.warning("Fallo al traducir la página %d por lotes; se reintenta texto a texto: %s", page.index + 1, exc)
            outs = [""] * len(texts)
        retried: set[int] = set()
        for k, text in enumerate(texts):
            if outs[k].strip() and not (_REFUSAL.search(outs[k]) and not _REFUSAL.search(text)):
                continue
            try:
                outs[k] = self._ask(texts=[text], batch=False, **common)[0]
            except CancelledError:
                raise
            except Exception:  # noqa: BLE001
                outs[k] = ""
            retried.add(k)
        return PageTranslation(updated=[self._to_region(r, outs[k], k in retried) for k, r in enumerate(targets)], summary="")

    def _to_region(self, r: Region, out: str, retried: bool) -> Region:
        region = r.model_copy(deep=True)
        text = _clean(out)
        if not text:
            region.flags = sorted(set(region.flags) | {"untranslated"})
            region.status = "review"
            region.note = region.note or "El modelo no devolvió traducción para este texto."
            return region
        if _REFUSAL.search(text) and not _REFUSAL.search(r.source_text):
            region.translation = ""
            region.flags = sorted(set(region.flags) | {"refused"})
            region.status = "review"
            region.note = ("El modelo se negó a traducir este texto en lugar de traducirlo. Prueba con otro modelo "
                           "en Modelos o escribe la traducción a mano.")
            return region
        flags: set[str] = set()
        confidence = 0.75 if retried else 0.8
        if _CJK.search(text) and not _ONLY_SYMBOLS.match(r.source_text):
            flags.add("ambiguous")
            confidence = 0.5
            region.review_note = "La traducción contiene caracteres del idioma original: revísala."
        if r.max_chars and len(text) > r.max_chars * 1.35:
            flags.add("too_long")
        region.translation = text
        region.speaker = ""
        region.emotion = ""
        region.note = ""
        region.confidence = confidence
        region.flags = sorted(flags)
        region.status = "review" if (confidence < self.s.review_threshold or flags & REVIEW_FLAGS or "too_long" in flags) else "translated"
        return region

    def _relevant_glossary(self, project: Project, texts: list[str], prev_page: Page | None) -> list[Pair]:
        haystack = " ".join([*texts, *(r.source_text for r in (prev_page.regions if prev_page else []))])
        out: list[Pair] = []
        seen: set[str] = set()

        def add(source: str, target: str) -> None:
            s, t = source.strip(), target.strip()
            if s and t and s not in seen and s in haystack:
                seen.add(s)
                out.append(Pair(s, t))

        for g in effective_glossary(project, self.s.dictionary):
            add(g.source, g.target)
        for c in project.characters:
            if c.target:
                add(c.source, c.target)
        return out[:40]

    @staticmethod
    def _history(prev_page: Page | None) -> list[Pair]:
        if not prev_page:
            return []
        ok = [r for r in prev_page.regions if r.source_text.strip() and r.translation.strip()
              and not ({"refused", "untranslated"} & set(r.flags))]
        return [Pair(r.source_text, r.translation) for r in ok[-4:]]


def make_translator(client: LLMClient, model: str, settings: TranslationSettings, library=None):
    """Traductor adecuado al modelo: de texto plano para los dedicados; el contextual (JSON) para el resto."""
    from .contextual import ContextualTranslator

    info = None
    if library is not None:
        try:
            info = next((m for m in library.installed() if m.id == model), None)
        except Exception:  # noqa: BLE001
            info = None
    family = mt_family(" ".join([model, getattr(info, "repo", "") or "", *(getattr(info, "files", None) or [])]))
    if family != "generic":
        return PlainTranslator(client, model, family, settings)
    return ContextualTranslator(client, model, settings)
