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
- `incomplete`: la traducción acaba en una palabra que no puede cerrar una frase («de», «que», «con»…) y el original NO está
  cortado (no acaba en guion ni puntos suspensivos). Medido el 2026-11-10: «MAKE SURE IT'S DONE» → «ASEGÚRATE DE QUE», y una
  reformulación breve aceptó «DESPUÉS DE—» por «Después de usted—». No bloquea: pide reparación y, si sigue, queda en revisión.
- `garbled`: la traducción no tiene ninguna letra aunque el original sí, o abre «¡»/«¿» sin cerrarlos (medido el 2026-11-10:
  Qwen3.5-4B devolvió «¡¡¡¡¡¡» para «UH-HUH.» y «—¡¡¡¡¡¡» para «DROP DEAD, RIGHT?» y se rotularon).
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
    "|veis|sois|vais|dais"            # monosílabos sin tilde (medido el 2026-11-10: «VEIS, MI PADRE…» pasó el control)
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


# Palabras que no pueden cerrar una frase en español (artículos, preposiciones, conjunciones, posesivos átonos).
DANGLING = ("de", "del", "a", "al", "que", "con", "en", "el", "la", "los", "las", "un", "una", "y", "e", "o", "u", "por", "para",
            "su", "sus", "mi", "mis", "tu", "tus", "sin", "sobre", "entre", "hacia", "hasta", "desde", "como", "pero", "ni")
# El original también puede quedar abierto (continúa en el globo siguiente): «I WANT TO STUDY HIM AND».
SOURCE_DANGLING = ("and", "or", "but", "the", "a", "an", "of", "to", "with", "for", "in", "on", "at", "that", "so", "because",
                   "if", "than", "as", "my", "your", "his", "her", "our", "their")
_LAST_WORD = re.compile("([" + _L + "]+)[^" + _L + "0-9]*$")
_CUT_END = re.compile(r"(?:-|—|–|\.\.|…)\s*[\u0022'»”]*\s*$")  # \u0022 = comillas (válido también en JavaScript con /u)


def ends_dangling(text: str, words=DANGLING) -> bool:
    """¿Acaba el texto en una de esas palabras (sin contar signos)?"""
    m = _LAST_WORD.search(text or "")
    return bool(m) and m.group(1).lower() in words


def is_incomplete(source: str, translation: str) -> bool:
    """La traducción acaba en una palabra funcional y el original no está abierto (guion, puntos suspensivos o conjunción)."""
    if not ends_dangling(translation):
        return False
    src = (source or "").strip()
    return not (_CUT_END.search(src) or ends_dangling(src, SOURCE_DANGLING))


def is_garbled(source: str, translation: str) -> bool:
    """Sin letras cuando el original las tiene, o «¡»/«¿» de apertura de más (sin su cierre)."""
    t = translation or ""
    if content_length(source) >= 2 and content_length(t) == 0:
        return True
    return t.count("¡") > t.count("!") + 1 or t.count("¿") > t.count("?") + 1


def check(source: str, translation: str, echo: str, variant: str, names: list[tuple[str, str]]) -> list[str]:
    """Problemas de una traducción, en orden de gravedad."""
    issues: list[str] = []
    if echo_matches(source, echo) is False:
        issues.append("misaligned")
    if is_invented(source, translation):
        issues.append("invented")
    if is_garbled(source, translation):
        issues.append("garbled")
    if is_incomplete(source, translation):
        issues.append("incomplete")
    # Si el original ya contiene esa forma, es texto copiado (rótulo «SPINF.OS»), no una elección de la traducción.
    if variant == "es-419" and has_vosotros(translation) and not has_vosotros(source):
        issues.append("variant")
    if lost_names(source, translation, names):
        issues.append("name")
    return issues


ISSUE_TEXT = {
    "misaligned": "la traducción anterior no correspondía a ESTE texto; tradúcelo de nuevo, solo este texto",
    "invented": "la traducción anterior añadía contenido que no está en el original; traduce solo lo que dice",
    "variant": "usaba «vosotros» o sus formas (-áis, -éis, os, vuestro); usa «ustedes»",
    "name": "cambió o quitó un nombre propio; cópialo tal cual: {names}",
    "garbled": "la traducción anterior no era texto legible (solo signos repetidos); traduce lo que dice el original",
    "incomplete": "la traducción anterior quedó cortada a media frase; tradúcela completa",
}

MISSING_TEXT = "no devolviste traducción para este texto"

# Problemas que, si persisten tras la reparación, impiden usar la traducción (se conserva el original en el dibujo).
BLOCKING = ("misaligned", "invented", "garbled")


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
