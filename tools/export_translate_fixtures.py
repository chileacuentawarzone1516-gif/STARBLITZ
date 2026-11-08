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
from starblitz_engine.translate.contextual import (  # noqa: E402
    _REFUSAL, ContextualTranslator, PageTranslation, estimate_max_chars, merge_memory,
)
from starblitz_engine.translate.llm import ChatMessage, LLMClient, parse_json  # noqa: E402
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

    def _chat(self, messages, schema, *, model, temperature, cancel=None):
        self.calls.append({
            "messages": [{"role": m.role, "content": m.content, "images": len(m.images)} for m in messages],
            "schema": "translation" if "new_terms" in schema["properties"] else "review",
            "temperature": temperature, "model": model,
        })
        return self.script.pop(0)


def region(i: int, text: str, **kw) -> Region:
    return Region(id=f"r{i}", order=i, bbox=(0, 0, 10, 10), layout_box=(0, 0, 10, 10), source_text=text,
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
                   "new_terms": [t.model_dump(mode="json") for t in result.new_terms],
                   "characters": [c.model_dump(mode="json") for c in result.characters]},
        "merged": {"glossary": [g.model_dump(mode="json") for g in proj.glossary],
                   "characters": [c.model_dump(mode="json") for c in proj.characters]},
    }


def j(**kw) -> str:
    return json.dumps(kw, ensure_ascii=False)


def item(n: int, tr: str, **kw) -> dict:
    return {"n": n, "translation": tr, "speaker": kw.get("speaker", "Asami"), "emotion": kw.get("emotion", "neutral"),
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
    ], new_terms=[], characters=[], page_summary="")]
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
    return cases


def main() -> None:
    prompts = {
        "lang_names": P.LANG_NAMES, "variants": {k: list(v) for k, v in P.VARIANTS.items()}, "honorifics": P.HONORIFICS,
        "kind_labels": P.KIND_LABELS, "translator_system": P.TRANSLATOR_SYSTEM, "reviewer_system": P.REVIEWER_SYSTEM,
        "profiles": {k: list(v) for k, v in P.PROFILES.items()}, "summary_note": P.SUMMARY_NOTE, "flag_enum": P.FLAG_ENUM, "translation_schema": P.TRANSLATION_SCHEMA,
        "review_schema": P.REVIEW_SCHEMA, "refusal_pattern": _REFUSAL.pattern,
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
        "parse_json": [{"raw": r, "out": _try_parse(r)} for r in (
            '{"a": 1}', '```json\n{"a": 2}\n```', '<think>pensando {x}</think>\n{"a": 3}', 'texto antes {"a": 4} texto después',
            '[1, 2]', 'sin json', '{"a": ', '')],
    }
    OUT_CASES.parent.mkdir(parents=True, exist_ok=True)
    OUT_CASES.write_text(json.dumps({"cases": build_cases(), **extra}, ensure_ascii=False) + "\n", encoding="utf-8")
    print("prompts y casos exportados")


def _try_parse(raw: str):
    try:
        return {"ok": parse_json(raw)}
    except ValueError:
        return {"error": True}


if __name__ == "__main__":
    main()
