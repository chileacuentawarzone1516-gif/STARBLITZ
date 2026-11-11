"""Exporta a JSON lo que el motor de Android (TypeScript) debe reproducir idéntico al de Python.

Genera dos archivos:
  - apps/mobile/src/engine/translate/prompts.json      textos, variantes y esquemas del traductor (única fuente: translate/prompts.py)
  - apps/mobile/test/fixtures/translate_cases.json     casos calculados por Python: mensajes exactos enviados al modelo y
                                                        resultado (regiones, glosario, personajes) para cada escenario
Ejecútalo tras cambiar los prompts o la lógica del traductor:  python tools/export_translate_fixtures.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from starblitz_engine.core.settings import TranslationSettings  # noqa: E402
from starblitz_engine.projects.schema import Character, GlossaryEntry, Page, Project, Region  # noqa: E402
from starblitz_engine.translate import prompts as P  # noqa: E402
from starblitz_engine.translate import quality as Q  # noqa: E402
from starblitz_engine.translate.contextual import (  # noqa: E402
    _REFUSAL, ContextualTranslator, PageTranslation, estimate_max_chars, merge_memory,
)
from starblitz_engine.translate.llm import ChatMessage, LLMClient, parse_json, salvage_items  # noqa: E402
from starblitz_engine.translate import fit as F  # noqa: E402
from starblitz_engine.core.settings import LLMSettings  # noqa: E402

OUT_PROMPTS = ROOT / "apps" / "mobile" / "src" / "engine" / "translate" / "prompts.json"
OUT_PROFILES = ROOT / "apps" / "shared" / "src" / "translation-profiles.json"
OUT_CASES = ROOT / "apps" / "mobile" / "test" / "fixtures" / "translate_cases.json"


class Scripted(LLMClient):
    """Cliente que devuelve respuestas guionizadas y registra lo que recibe."""

    def __init__(self, script: list[str]):
        super().__init__(LLMSettings())
        self.script = list(script)
        self.calls: list[dict] = []

    def _chat(self, messages, schema, *, model, temperature, cancel=None, max_tokens=None):
        self.calls.append({
            "messages": [{"role": m.role, "content": m.content, "images": len(m.images)} for m in messages],
            "schema": "translation" if "new_terms" in schema["properties"] else "review",
            "temperature": temperature, "model": model, "max_tokens": max_tokens,
        })
        step = self.script.pop(0) if self.script else ""  # guion agotado: respuesta vacía, igual que el doble de TypeScript
        if isinstance(step, dict):  # {"raw": ..., "finish": "length"}: respuesta cortada por el tope de tokens
            self.last_finish = step.get("finish", "stop")
            return step["raw"]
        self.last_finish = "stop"
        return step


def region(i: int, text: str, **kw) -> Region:
    return Region(id=f"r{i}", order=i, bbox=(0, 0, 10, 10), layout_box=kw.pop("layout_box", (0, 0, 10, 10)), source_text=text,
                  max_chars=kw.pop("max_chars", 40), **kw)


def page(pid: str, index: int, regions: list[Region], summary: str = "") -> Page:
    return Page(id=pid, index=index, filename=f"{pid}.jpg", ext="jpg", width=800, height=1200, sha1="x", dhash="0" * 16,
                regions=regions, summary=summary)


def project(**kw) -> Project:
    base = dict(id="p-test", name="Ramen de Asami", source_lang="ja", page_ids=["g1", "g2", "g3"], synopsis="Una chica sola en la ciudad.",
                style_notes="Tono cómico.", characters=[Character(source="麻美", target="Asami", gender="f", speech="informal")],
                glossary=[GlossaryEntry(source="ラーメン", target="ramen", note="", locked=True),
                          GlossaryEntry(source="豚骨", target="tonkotsu", note="caldo de cerdo")])
    base.update(kw)
    return Project(**base)


def dump_region(r: Region) -> dict:
    d = r.model_dump(mode="json")
    d.pop("updated", None)
    return d


def run_case(name: str, proj: Project, pg: Page, prev: Page | None, nxt: Page | None, story: list[str], image: bool,
             script: list[str], quality: str = "balanced", review_threshold: float = 0.72,
             dictionary: list[GlossaryEntry] | None = None) -> dict:
    client = Scripted(script)
    dictionary = dictionary or []
    tr = ContextualTranslator(client, "modelo-prueba", TranslationSettings(quality=quality, review_threshold=review_threshold, dictionary=dictionary))
    result = tr.translate_page(proj, pg, prev_page=prev, next_page=nxt, story=story, image_jpeg=b"jpeg" if image else None)
    memory_before = proj.model_copy(deep=True)
    merge_memory(proj, result)
    return {
        "name": name,
        "input": {"project": memory_before.model_dump(mode="json"), "page": pg.model_dump(mode="json"),
                  "prev": prev.model_dump(mode="json") if prev else None, "next": nxt.model_dump(mode="json") if nxt else None,
                  "story": story, "image": image, "script": script,
                  "settings": {"quality": quality, "review_threshold": review_threshold,
                               "dictionary": [d.model_dump(mode="json") for d in dictionary]}},
        "calls": client.calls,
        "result": {"updated": [dump_region(r) for r in result.updated], "summary": result.summary, "reviewed": result.reviewed,
                   "repaired": result.repaired, "json_invalid": result.json_invalid, "salvaged": result.salvaged,
                   "recovered": result.recovered, "json_lost": result.json_lost, "condensed": result.condensed,
                   "new_terms": [t.model_dump(mode="json") for t in result.new_terms],
                   "characters": [c.model_dump(mode="json") for c in result.characters]},
        "merged": {"glossary": [g.model_dump(mode="json") for g in proj.glossary],
                   "characters": [c.model_dump(mode="json") for c in proj.characters]},
    }


def j(**kw) -> str:
    return json.dumps(kw, ensure_ascii=False)


def item(n: int, tr: str, **kw) -> dict:
    return {"n": n, "src_start": kw.get("src", ""), "translation": tr, "speaker": kw.get("speaker", "Asami"), "emotion": kw.get("emotion", "neutral"),
            "confidence": kw.get("confidence", 0.9), "flags": kw.get("flags", []), "note": kw.get("note", ""),
            "source_fix": kw.get("source_fix", "")}


def build_cases() -> list[dict]:
    cases = []
    prev = page("g1", 0, [region(1, "ただいま", speaker="Asami", translation="Ya llegué"), region(2, "おかえり", translation="Bienvenida", speaker="Madre")], "Asami vuelve a casa.")
    nxt = page("g3", 2, [region(1, "手紙？"), region(2, "…………")])

    # 1) Caso general: tipos distintos, un texto vacío, uno aprobado por la persona, comillas, puntos suspensivos y marcas.
    cur = page("g2", 1, [
        region(1, "働き者の母親を持つと", kind="dialogue"),
        region(2, "またパチンコやろうかな", kind="thought", max_chars=20),
        region(3, "ドン！", kind="sfx", max_chars=8),
        region(4, "  ", kind="dialogue"),
        region(5, "実家からの手紙…？", kind="narration"),
        region(6, "あ麻美さんそれ", kind="dialogue", translation="Ah, Asami, eso", status="approved"),
    ])
    script = [j(items=[
        item(1, "「Cuando tu madre trabaja tanto...   la hija no sabe hacer nada」", confidence=0.95),
        item(2, "Quizá vuelva al pachinko", confidence=0.5, flags=["idiom"]),
        item(3, "¡PUM!", confidence=0.9, flags=["wordplay"]),
        item(5, "Una carta de casa…", confidence=0.88, flags=["ocr_suspect"], source_fix="実家からの手紙？"),
    ], new_terms=[{"source": "パチンコ", "target": "pachinko", "note": "juego de azar"},
                  {"source": "ラーメン", "target": "ramen", "note": ""}],
        characters=[{"source": "麻美", "target": "Asami", "gender": "?", "speech": "ignorada"},
                    {"source": "母", "target": "Mamá", "gender": "f", "speech": "cariñosa"},
                    {"source": "", "target": "x", "gender": "m", "speech": ""}],
        page_summary="Asami piensa en su madre y recibe una carta.")]
    cases.append(run_case("general", project(), cur, prev, nxt, ["p.1: Asami llega a su piso.", "p.2: Cocina sola."], True, script))

    # 2) Calidad máxima: segundo pase de corrección que cambia una línea y baja la confianza.
    cur = page("g2", 1, [region(1, "ラーメンが食べたい", kind="dialogue"), region(2, "お母さん…", kind="thought")])
    script = [
        j(items=[item(1, "Quiero comer ramen", confidence=0.9), item(2, "Madre…", confidence=0.85)], new_terms=[], characters=[], page_summary="Asami extraña a su madre."),
        j(items=[{"n": 1, "final": "Se me antoja un ramen", "issue": "naturalidad", "confidence": 0.7}, {"n": 2, "final": "Madre…", "issue": "", "confidence": 0.95}]),
    ]
    cases.append(run_case("revision-editorial", project(), cur, prev, nxt, [], False, script, quality="max"))

    # 3) La revisión falla (JSON inválido dos veces): se conserva el borrador.
    script = [
        j(items=[item(1, "Quiero comer ramen"), item(2, "Madre…")], new_terms=[], characters=[], page_summary="x"),
        "esto no es json", "tampoco {",
    ]
    try:
        cases.append(run_case("revision-falla", project(), cur, prev, nxt, [], False, script, quality="max"))
    except Exception:  # noqa: BLE001  (la reparación también falla: en Python se propaga como ValueError)
        pass

    # 4) El modelo responde con una negativa; texto demasiado largo; elemento ausente; elementos con n repetido.
    cur = page("g2", 1, [region(1, "ひどいことを言う", max_chars=10), region(2, "これは長い文章です", max_chars=10),
                         region(3, "返事がない", max_chars=10), region(4, "ほんとう？", max_chars=10)])
    script = [j(items=[
        item(1, "Lo siento, pero no puedo ayudar con eso."),
        item(2, "Esta es una frase bastante larga para el globo", confidence=0.95),
        item(4, "¿De verdad?", confidence="alta"),
    ], new_terms=[], characters=[], page_summary=""),
        # Reparación del elemento ausente (3): esta vez el modelo tampoco lo devuelve → queda «sin traducir».
        j(items=[item(1, "Lo siento, pero no puedo ayudar con eso.")], new_terms=[], characters=[], page_summary="")]
    cases.append(run_case("negativa-largo-ausente", project(), cur, None, None, [], False, script))

    # 5) JSON mal formado la primera vez: se reintenta con instrucciones de reparación.
    cur = page("g2", 1, [region(1, "こんにちは")])
    script = ["```json\n{\"items\": [", j(items=[item(1, "Hola")], new_terms=[], characters=[], page_summary="Saludo.")]
    cases.append(run_case("reparacion-json", project(), cur, None, None, [], False, script))

    # 6) Glosario grande: solo se envían los términos bloqueados o presentes en las páginas.
    big = [GlossaryEntry(source=f"語{i}", target=f"termino{i}", locked=(i % 17 == 0)) for i in range(60)]
    cur = page("g2", 1, [region(1, "これは語5と語40です")])
    nxt2 = page("g3", 2, [region(1, "語7")])
    script = [j(items=[item(1, "Esto es termino5 y termino40")], new_terms=[], characters=[], page_summary="Glosario.")]
    cases.append(run_case("glosario-grande", project(glossary=big, characters=[]), cur, None, nxt2, [], False, script))

    # 7) Nada que traducir: no se llama al modelo.
    cur = page("g2", 1, [region(1, ""), region(2, "   ", translation="x", status="approved")], summary="resumen previo")
    cases.append(run_case("sin-textos", project(), cur, prev, nxt, [], False, []))

    # 8) Opciones del proyecto: español de España, honoríficos conservados.
    cur = page("g2", 1, [region(1, "田中さん、ありがとう")])
    script = [j(items=[item(1, "Tanaka-san, gracias", flags=["honorific"])], new_terms=[], characters=[], page_summary="Agradece.")]
    cases.append(run_case("espana-honorificos", project(target_variant="es-ES", honorifics="keep", source_lang="auto", detected_lang="ja"),
                          cur, None, None, [], False, script))

    # 9) Perfil «fiel» y diccionario personal: el término del proyecto manda sobre el del diccionario, el diccionario añade lo
    #    que falta (siempre obligatorio) y no se vuelve a proponer como término nuevo.
    cur = page("g2", 1, [region(1, "先輩、ラーメンを食べましょう")])
    dictionary = [GlossaryEntry(source="先輩", target="sempai", note="se deja así"), GlossaryEntry(source="ラーメン", target="fideos ramen")]
    script = [j(items=[item(1, "Sempai, comamos ramen")],
                new_terms=[{"source": "先輩", "target": "senpai", "note": ""}, {"source": "食べましょう", "target": "comamos", "note": ""}],
                characters=[], page_summary="Invita a comer.")]
    cases.append(run_case("perfil-fiel-diccionario", project(translation_profile="fiel"), cur, None, None, [], False, script, dictionary=dictionary))

    # 10) Perfil «adaptación narrativa» con revisión editorial (el corrector recibe también el perfil).
    cur = page("g2", 1, [region(1, "ラーメンが食べたい", kind="dialogue")])
    script = [j(items=[item(1, "Se me antoja un ramen", confidence=0.9)], new_terms=[], characters=[], page_summary="Antojo."),
              j(items=[{"n": 1, "final": "Se me antoja un ramen", "issue": "", "confidence": 0.9}])]
    cases.append(run_case("perfil-adaptacion-revision", project(translation_profile="adaptacion"), cur, None, None, [], False, script, quality="max"))

    # Controles de calidad y llamada de reparación (2026-11-09): cómic occidental en MAYÚSCULAS.
    en = dict(source_lang="en", characters=[Character(source="Mary Jane", target="Mary Jane", gender="f")], glossary=[], synopsis="", style_notes="")
    nxt_en = page("g3", 2, [region(1, "PETER? PETER? WHAT DID WE SAY ABOUT READING AT THE TABLE?")])
    cur = page("g2", 1, [region(1, "PARKER HOME, QUEENS", kind="narration"), region(2, "WHAT?", kind="dialogue"),
                         region(3, "ISN'T THAT MARY JANE OVER THERE?", kind="dialogue"), region(4, "DO YOU GUYS HAVE PRACTICE?", kind="dialogue"),
                         region(5, "SEE YOU LATER", kind="dialogue")])
    first = j(items=[
        item(1, "¿Peter? ¿Peter? ¿Qué dijimos sobre leer en la mesa?", src="PETER? PETER? WHAT"),   # traduce la página SIGUIENTE
        item(2, "Eso debería mantenerla ocupada durante horas y horas, ya lo verás.", src="WHAT"),       # inventa
        item(3, "¿No es esa María-Jane de ahí?", src="ISN'T THAT MARY"),                             # cambia el nombre
        item(4, "¿No tenéis práctica?", src="DO YOU GUYS"),                                           # vosotros en es-419
    ], new_terms=[], characters=[], page_summary="Casa de Parker.")                                   # el 5 falta
    repair = j(items=[
        item(1, "Casa de los Parker, Queens", src="PARKER HOME, QUEENS"),
        item(2, "Eso debería mantenerla ocupada durante horas y horas, ya lo verás.", src="WHAT"),       # sigue inventando → sin traducción
        item(3, "¿No es esa Mary Jane de ahí?", src="ISN'T THAT MARY"),
        item(4, "¿No tienen práctica?", src="DO YOU GUYS"),
        item(5, "Nos vemos luego", src="SEE YOU LATER"),
    ], new_terms=[], characters=[], page_summary="")
    cases.append(run_case("reparacion-calidad", project(**en), cur, None, nxt_en, [], False, [first, repair]))
    # Sin problemas: una sola llamada, y la traducción sale en MAYÚSCULAS como el original.
    cur = page("g2", 1, [region(1, "UNCLE BEN? WHAT ARE YOU DOING HERE?", kind="dialogue"), region(2, "Based on the original story", kind="narration")])
    ok = j(items=[item(1, "¿Tío Ben? ¿Qué haces aquí?", src="UNCLE BEN WHAT"), item(2, "Basado en la historia original", src="Based on the")],
           new_terms=[], characters=[], page_summary="Peter ve a su tío.")
    cases.append(run_case("sin-reparacion-mayusculas", project(**en), cur, None, None, [], False, [ok]))

    # Recuperación ante JSON inválido (2026-11-10). La respuesta de la página se CORTA por el tope de tokens (no se reintenta
    # igual): se rescata el 1 (eco correcto), se descarta el 2 (eco de otro texto) y se piden uno a uno el 2, el 3 y el 4.
    cur = page("g2", 1, [region(1, "UNCLE BEN? WHAT ARE YOU DOING HERE?"), region(2, "I THOUGHT YOU WERE AT WORK"),
                         region(3, "SHE SAID NO"), region(4, "ABOUT TIME")])
    cut = ('{"items": [' + json.dumps(item(1, "¿Tío Ben? ¿Qué haces aquí?", src="UNCLE BEN WHAT"), ensure_ascii=False) + ", "
           + json.dumps(item(2, "Dijo que no", src="SHE SAID NO"), ensure_ascii=False)
           + ', {"n": 3, "src_start": "SHE SAID", "translation": "Dijo que no, no, no, no, no, no')
    cut4 = '```json\n{"items": [' + json.dumps(item(4, "Ya era hora", src="ABOUT TIME"), ensure_ascii=False) + ', {"n": 4, "src_st'
    script = [
        {"raw": cut, "finish": "length"},
        j(items=[item(2, "Creí que estabas en el trabajo", src="I THOUGHT YOU")], new_terms=[], characters=[], page_summary=""),
        "esto no es json", "tampoco {",                                        # el 3: ilegible dos veces (con su reintento)
        j(items=[item(99, "Dijo que no", src="SHE SAID NO")], new_terms=[], characters=[], page_summary=""),  # número ajeno
        {"raw": cut4, "finish": "length"},                                     # el 4: cortada, pero el elemento llegó entero
    ]
    cases.append(run_case("json-invalido-recuperacion", project(**en), cur, None, None, [], False, script))
    # Ilegible dos veces y sin nada que rescatar: el único texto se recupera solo, al primer intento.
    cur = page("g2", 1, [region(1, "SEE YOU LATER")])
    script = ["{\"items\": [ {\"n\": 1, \"src", "{\"items\": nada",
              j(items=[item(1, "Nos vemos luego", src="SEE YOU LATER")], new_terms=[], characters=[], page_summary="")]
    cases.append(run_case("json-invalido-sin-rescate", project(**en), cur, None, None, [], False, script))

    # Reformulación breve (2026-11-10): tres textos que no caben. El 1 se acorta bien; el 2 «acortado» pierde un nombre; el 3 se
    # queda en casi nada (resumen). Solo se acepta el 1; la versión completa queda en la nota.
    cur = page("g2", 1, [region(1, "I DON'T CARE WHO YOU THINK YOU ARE", max_chars=24, layout_box=(0, 0, 120, 14), line_size=12.8),
                         region(2, "ISN'T THAT MARY JANE OVER THERE?", max_chars=20),
                         region(3, "THE CIGARETTE COMPANIES WERE PUTTING ADDICTIVE LEVELS OF NICOTINE", max_chars=30),
                         region(4, "OK", max_chars=10)])
    first = j(items=[item(1, "No me importa quién crees que eres", src="I DON'T CARE"),
                     item(2, "¿No es esa Mary Jane de allá?", src="ISN'T THAT MARY"),
                     item(3, "Las compañías tabacaleras estaban poniendo niveles adictivos de nicotina", src="THE CIGARETTE COMPANIES"),
                     item(4, "Vale", src="OK")], new_terms=[], characters=[], page_summary="Una discusión.")
    short = j(items=[{"n": 1, "final": "Me da igual quién te crees", "issue": "sinónimos", "confidence": 0.8},
                     {"n": 2, "final": "¿Es ella, allá?", "issue": "", "confidence": 0.8},
                     {"n": 3, "final": "Tabaco adictivo", "issue": "", "confidence": 0.8}])
    cases.append(run_case("acortar-no-cabe", project(**en), cur, None, None, [], False, [first, short]))
    return cases


QUALITY_CASES = [('HE PARKER HOME FOREST HILLS', '¿Peter? ¿Qué dijimos?', 'PETER? PETER?', 'es-419', []), ('WHAT?', 'Eso debería mantenerla ocupada durante horas.', 'WHAT', 'es-419', []), ("DON'T YOU PUNKS HAVE PRACTICE?", '¿NO TENÉIS PRÁCTICAS? ¡ID A JUGAR!', "DON'T YOU PUNKS", 'es-419', []), ("DON'T YOU PUNKS HAVE PRACTICE?", '¿NO TENÉIS PRÁCTICAS?', "DON'T YOU", 'es-ES', []), ("ISN'T THAT MARY JANE?", '¿NO ES ESA MARÍA-JANE?', "ISN'T THAT", 'es-419', [['Mary Jane', 'Mary Jane']]), ('P.S. 163 QUEENS DISTRICT', 'P.S. 163, DISTRITO DE QUEENS', 'P.S. 163', 'es-419', [['Queens', 'Queens']]), ('TWC TIMES! HA HA!', '¡DOS VECES! ¡JA, JA!', 'TWO TIMES', 'es-419', []), ('すまん、田中！', '¡Lo siento, Tanaka! No volverá a pasar.', 'すまん', 'es-419', [['田中', 'Tanaka']]), ('すまん、田中！', '¡Lo siento!', '先輩', 'es-419', [['田中', 'Tanaka']]), ('미안해, 민지야', 'Lo siento, Min-ji', '', 'es-419', []), ('Based on the story', 'Basado en la historia', 'Based on', 'es-419', []), ('No me gusta este país', 'No me gusta este país y tengo sed', 'No me', 'es-419', []), ('', '', '', 'es-419', []), ('UH-HUH.', '¡¡¡¡¡¡', 'UH-HUH', 'es-419', []), ('--DROP DEAD RIGHT?', '—¡¡¡¡¡¡', 'DROP DEAD', 'es-419', []), ('WELL- DUH', 'PUES… —¡¡¡¡', 'WELL DUH', 'es-419', []), ('NO!!!', '¡¡¡NO!!!', 'NO', 'es-419', []), ('...', '…', '', 'es-419', []), ('WHAT?', '¿QUÉ', 'WHAT', 'es-419', []), ('YOU SEE, MY FATHER WAS WORKING', 'VEIS, MI PADRE ESTABA TRABAJANDO', 'YOU SEE MY', 'es-419', []), ('THE STAGE', 'EL DAIS', 'THE STAGE', 'es-ES', []), ('MAKE SURE IT\'S DONE', 'ASEGÚRATE DE QUE', 'MAKE SURE', 'es-419', []), ('IF I SEE FIT TO--', 'SI LO CONSIDERO OPORTUNO, PARA…', 'IF I SEE', 'es-419', []), ('AFTER YOU-', 'DESPUÉS DE—', 'AFTER YOU', 'es-419', []), ('AFTER YOU', 'DESPUÉS DE…', 'AFTER YOU', 'es-419', []), ('WHAT A DOG', 'QUÉ PERRO', 'WHAT A', 'es-419', []), ('I WANT TO STUDY HIM AND', 'QUIERO ESTUDIARLO Y', 'I WANT', 'es-419', []), ('SPINF.OS', 'SPINF.OS', 'SPINF', 'es-419', [])]


def main() -> None:
    prompts = {
        "lang_names": P.LANG_NAMES, "variants": {k: list(v) for k, v in P.VARIANTS.items()}, "honorifics": P.HONORIFICS,
        "kind_labels": P.KIND_LABELS, "translator_system": P.TRANSLATOR_SYSTEM, "reviewer_system": P.REVIEWER_SYSTEM,
        "profiles": {k: list(v) for k, v in P.PROFILES.items()}, "summary_note": P.SUMMARY_NOTE, "flag_enum": P.FLAG_ENUM, "translation_schema": P.TRANSLATION_SCHEMA,
        "review_schema": P.REVIEW_SCHEMA, "refusal_pattern": _REFUSAL.pattern,
        "echo_note": P.ECHO_NOTE, "repair_header": P.REPAIR_HEADER,
        "recover_header": P.RECOVER_HEADER, "recover_note": P.RECOVER_NOTE,
        "recover": {"max_segments": P.RECOVER_MAX_SEGMENTS, "attempts": P.RECOVER_ATTEMPTS, "max_tokens": P.RECOVER_MAX_TOKENS},
        "shorten_header": P.SHORTEN_HEADER, "shorten": {"min_keep": P.SHORTEN_MIN_KEEP, "max_ratio": P.SHORTEN_MAX_RATIO},
        "quality": {"echo_words": Q.ECHO_WORDS, "echo_window": Q.ECHO_WINDOW, "echo_similarity": Q.ECHO_SIMILARITY,
                    "invented_ratio": Q.INVENTED_RATIO, "invented_slack": Q.INVENTED_SLACK, "cjk": Q.CJK, "cjk_weight": Q.CJK_WEIGHT,
                    "vosotros_pattern": Q.VOSOTROS_PATTERN, "issue_text": Q.ISSUE_TEXT, "missing_text": Q.MISSING_TEXT,
                    "blocking": list(Q.BLOCKING), "dangling": list(Q.DANGLING), "source_dangling": list(Q.SOURCE_DANGLING), "last_word_pattern": Q._LAST_WORD.pattern,
                    "cut_end_pattern": Q._CUT_END.pattern},
    }
    # Lo que necesitan las interfaces (PC y móvil) para mostrar los perfiles: nombre y descripción, sin las instrucciones del modelo.
    OUT_PROFILES.write_text(json.dumps({"default": P.DEFAULT_PROFILE, "profiles": [{"id": k, "label": v[0], "description": v[1]} for k, v in P.PROFILES.items()]},
                                       ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    OUT_PROMPTS.parent.mkdir(parents=True, exist_ok=True)
    OUT_PROMPTS.write_text(json.dumps(prompts, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    refusals = ["No puedo ayudar con eso", "Lo siento, pero no puedo traducir esto.", "Como modelo de lenguaje, no debo", "I'm sorry, but I can't help",
                "No puedo creerlo", "No puedo ayudarte, amigo", "Hola, ¿qué tal?", "As an AI language model", "no es posible traducir", "No puedo ayudar."]
    extra = {
        "refusal": [{"text": t, "match": bool(_REFUSAL.search(t))} for t in refusals],
        "estimate": [{"box": list(b), "line": ls, "h": ph, "bubble": ib, "out": estimate_max_chars(b, ls, ph, ib)}
                     for b in ((0, 0, 100, 200), (10, 20, 300, 120), (0, 0, 40, 40), (5, 5, 900, 700), (0, 0, 1, 1))
                     for ls in (0.0, 12.0, 30.5, 80.0) for ph in (800, 1200, 2400) for ib in (True, False)],
        "quality": [{"source": src, "translation": tr, "echo": echo, "variant": var, "names": names,
                     "issues": Q.check(src, tr, echo, var, [tuple(n) for n in names]), "case": Q.match_case(src, tr),
                     "length": [Q.content_length(src), Q.content_length(tr)], "echo_ok": Q.echo_matches(src, echo),
                     "lost": Q.lost_names(src, tr, [tuple(n) for n in names])}
                    for src, tr, echo, var, names in QUALITY_CASES],
        "fit": _fit_cases(),
        "salvage": [{"raws": raws, "out": salvage_items(raws)} for raws in (
            ['{"items": [{"n": 1, "src_start": "A", "translation": "x"}, {"n": 2, "src_start": "B", "translation": "y \\" }'],
            ['<think>…</think>```json\n{"items": [{"n": 1.0, "src_start": "A", "translation": "{x}"}, {"n": true, "translation": "z"}]}'],
            ['{"items": [{"n": 3, "translation": 5}, {"n": "4", "translation": "s"}, {"n": 5, "translation": "ok", "src_start": "C"}',
             '{"items": [{"n": 5, "translation": "otra", "src_start": "C"}, {"n": 6, "translation": "seis", "src_start": "D"}]}'],
            ['sin items', '{"page_summary": "x"}', '', '{"items": {"n": 1}}'],
        )],
        "parse_json": [{"raw": r, "out": _try_parse(r)} for r in (
            '{"a": 1}', '```json\n{"a": 2}\n```', '<think>pensando {x}</think>\n{"a": 3}', 'texto antes {"a": 4} texto después',
            '[1, 2]', 'sin json', '{"a": ', '')],
    }
    OUT_CASES.parent.mkdir(parents=True, exist_ok=True)
    OUT_CASES.write_text(json.dumps({"cases": build_cases(), **extra}, ensure_ascii=False) + "\n", encoding="utf-8")
    print("prompts y casos exportados")


def _fit_cases() -> list[dict]:
    """Encaje con métricas reales: globos elípticos, cajas sin globo, tipografías y textos de longitud creciente."""
    import math

    def ellipse(cx, cy, rx, ry, n=24):
        return [[int(cx + rx * math.cos(2 * math.pi * k / n)), int(cy + ry * math.sin(2 * math.pi * k / n))] for k in range(n)]

    texts = ["¡SÍ!", "NO ME IMPORTA QUIÉN CREES QUE ERES", "¿QUÉ? ¿ESTÁS ENAMORADO DE ÉL, HARRY?",
             "LAS COMPAÑÍAS TABACALERAS ESTABAN AÑADIENDO NIVELES ADICTIVOS DE NICOTINA A LOS CIGARRILLOS",
             "Hola\nque tal", "SUPERCALIFRAGILISTICOEXPIALIDOSO", ""]
    out = []
    for (cx, cy, rx, ry) in ((300, 300, 90, 60), (500, 400, 160, 90), (200, 200, 60, 70)):
        poly = ellipse(cx, cy, rx, ry)
        box = [cx - int(rx * 0.9), cy - int(ry * 0.85), cx + int(rx * 0.9), cy + int(ry * 0.85)]
        for t in texts:
            for role, ls in (("dialogue", 28.0), ("narration", 0.0), ("shout", 40.0)):
                inp = {"layoutBox": box, "polygon": poly, "lineSize": ls, "pageHeight": 3000, "role": role, "lineHeight": 1.12,
                       "uppercase": role == "shout"}
                out.append({"text": t, "input": inp, "fits": F.fits(t, layout_box=tuple(box), polygon=poly, line_size=ls,
                                                                    page_height=3000, role=role, line_height=1.12,
                                                                    uppercase=role == "shout")})
    for t in texts:
        box = [10, 10, 260, 90]
        out.append({"text": t, "input": {"layoutBox": box, "polygon": None, "lineSize": 20.0, "pageHeight": 1200, "role": "whisper",
                                         "lineHeight": 1.3, "uppercase": False},
                    "fits": F.fits(t, layout_box=tuple(box), polygon=None, line_size=20.0, page_height=1200, role="whisper",
                                   line_height=1.3)})
    return out


def _try_parse(raw: str):
    try:
        return {"ok": parse_json(raw)}
    except ValueError:
        return {"error": True}


if __name__ == "__main__":
    main()
