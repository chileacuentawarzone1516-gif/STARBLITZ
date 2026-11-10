"""Comprobaciones automáticas de cada traducción y descripción de los problemas para la llamada de reparación.

Origen (medido el 2026-11-09 con un capítulo real y Qwen3.5-4B): el traductor asignaba las respuestas solo por número, así que
cuando el modelo se confundía (p. ej. traducía la página SIGUIENTE, que va como contexto) las traducciones caían en globos que
no les correspondían o se inventaban; además aparecía «vosotros» con es-419, nombres propios traducidos («Queens» → «Reyes») y
mayúsculas al azar. Estas reglas son GENERALES (no dependen de ninguna página) y existen igual en `translate/quality.ts`
(los casos de `tools/export_translate_fixtures.py` comprueban que ambos motores dan lo mismo).

Comprobaciones (todas baratas, sin otro modelo):
- `misaligned`: el modelo copia en «src_start» las primeras palabras del original de cada número; si no se parecen, la
  traducción es de otro texto.
- `invented`: la traducción es desproporcionadamente larga para su original (tras «¿QUÉ?» no cabe una frase de 45 letras).
- `variant`: formas de «vosotros» en una traducción a español latinoamericano.
- `name`: un nombre propio conocido (personajes y glosario) está en el original y desaparece de la traducción.
"""

from __future__ import annotations

import re
import unicodedata

ECHO_WORDS = 3
ECHO_WINDOW = 6
ECHO_SIMILARITY = 0.6
INVENTED_RATIO = 2.6
INVENTED_SLACK = 24

# Letras del español escritas a mano (no \w) para que la misma expresión valga en JavaScript, donde \w y \b no ven acentos.
_L = "a-zA-ZáéíóúüñÁÉÍÓÚÜÑ"
VOSOTROS_PATTERN = (
    "(?<![" + _L + "])(?:vosotr[oa]s|vuestr[oa]s?|os"
    "|[" + _L + "]{2,}(?:áis|éis)"   # tenéis, habláis, sabéis («país», «maíz» llevan la tilde en otra vocal)
    "|id|venid|mirad|escuchad|esperad|parad|corred|dejad|callad|tened|haced|decid|salid|subid)"
    "(?![" + _L + "])"
)
_VOSOTROS = re.compile(VOSOTROS_PATTERN, re.I)
# Japonés, chino y coreano: cada carácter cuenta como una «palabra» (no hay espacios) y pesa como CJK_WEIGHT letras latinas.
CJK = "\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af"
CJK_WEIGHT = 3
_WORD = re.compile("[A-Z0-9]+|[" + CJK + "]")
_CJK = re.compile("[" + CJK + "]")
_MARKS = re.compile("[̀-ͯ]")


def fold(text: str) -> str:
    """Mayúsculas sin acentos (para comparar nombres y palabras de forma tolerante)."""
    # NFKD separa los acentos; NFC vuelve a unir lo demás (si no, las sílabas coreanas quedarían en jamos sueltos).
    return unicodedata.normalize("NFC", _MARKS.sub("", unicodedata.normalize("NFKD", text or ""))).upper()


def words(text: str) -> list[str]:
    return _WORD.findall(fold(text))


def similarity(a: str, b: str) -> float:
    """1 − distancia de Levenshtein / longitud mayor (la misma cuenta en TypeScript)."""
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return 1 - prev[-1] / max(len(a), len(b))


def echo_matches(source: str, echo: str) -> bool | None:
    """¿Las palabras copiadas por el modelo son el comienzo de ESTE original? None si no copió nada (no se puede saber)."""
    e = words(echo)[:ECHO_WORDS]
    s = words(source)[:ECHO_WINDOW]
    if not e or not s:
        return None
    hits = sum(1 for w in e if any(similarity(w, x) >= ECHO_SIMILARITY for x in s))
    return hits * 2 >= len(e)


def content_length(text: str) -> int:
    """Letras y cifras (sin signos); cada carácter CJK cuenta como CJK_WEIGHT."""
    return sum(CJK_WEIGHT if _CJK.match(w) else len(w) for w in words(text))


def is_invented(source: str, translation: str) -> bool:
    """Traducción mucho más larga de lo que puede dar su original."""
    return content_length(translation) > content_length(source) * INVENTED_RATIO + INVENTED_SLACK


def has_vosotros(translation: str) -> bool:
    return bool(_VOSOTROS.search(translation or ""))


def lost_names(source: str, translation: str, names: list[tuple[str, str]]) -> list[str]:
    """Nombres conocidos (original → forma en español) presentes en el original y ausentes de la traducción."""
    src, out = " " + " ".join(words(source)) + " ", " " + " ".join(words(translation)) + " "
    lost = []
    for original, target in names:
        o = " ".join(words(original))
        if len(o) < 3 or " " + o + " " not in src:
            continue
        forms = [f for f in (o, " ".join(words(target))) if f]
        if not any(" " + f + " " in out for f in forms):
            lost.append(original)
    return lost


def match_case(source: str, translation: str) -> str:
    """Si el original está rotulado en MAYÚSCULAS (cómic), la traducción también; si no, se deja como venga."""
    letters = [c for c in source if c.isalpha()]
    if len(letters) >= 3 and sum(1 for c in letters if c.isupper()) >= 0.8 * len(letters):
        return translation.upper()
    return translation


def check(source: str, translation: str, echo: str, variant: str, names: list[tuple[str, str]]) -> list[str]:
    """Problemas de una traducción, en orden de gravedad."""
    issues: list[str] = []
    if echo_matches(source, echo) is False:
        issues.append("misaligned")
    if is_invented(source, translation):
        issues.append("invented")
    if variant == "es-419" and has_vosotros(translation):
        issues.append("variant")
    if lost_names(source, translation, names):
        issues.append("name")
    return issues


ISSUE_TEXT = {
    "misaligned": "la traducción anterior no correspondía a ESTE texto; tradúcelo de nuevo, solo este texto",
    "invented": "la traducción anterior añadía contenido que no está en el original; traduce solo lo que dice",
    "variant": "usaba «vosotros» o sus formas (-áis, -éis, os, vuestro); usa «ustedes»",
    "name": "cambió o quitó un nombre propio; cópialo tal cual: {names}",
}

MISSING_TEXT = "no devolviste traducción para este texto"

# Problemas que, si persisten tras la reparación, impiden usar la traducción (se conserva el original en el dibujo).
BLOCKING = ("misaligned", "invented")


def describe(issues: list[str], lost: list[str]) -> str:
    return "; ".join(ISSUE_TEXT[i].replace("{names}", ", ".join(lost)) for i in issues)


def known_names(characters, glossary) -> list[tuple[str, str]]:
    """Pares (original, en español) de personajes y del glosario que parecen nombres propios (empiezan por mayúscula)."""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for item in [*characters, *glossary]:
        src = (getattr(item, "source", "") or "").strip()
        tgt = (getattr(item, "target", "") or "").strip()
        if len(src) < 3 or not src[0].isupper() or src.upper() in seen:
            continue
        seen.add(src.upper())
        out.append((src, tgt or src))
    return out
