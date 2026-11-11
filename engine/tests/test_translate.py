import json

from starblitz_engine.core.settings import LLMSettings, TranslationSettings
from starblitz_engine.projects.schema import Character, GlossaryEntry, Page, Project, Region
from starblitz_engine.translate.contextual import ContextualTranslator, estimate_max_chars, merge_memory
from starblitz_engine.translate.llm import LLMClient, parse_json


class ScriptedClient(LLMClient):
    def __init__(self, responses):
        super().__init__(LLMSettings())
        self.responses = list(responses)
        self.calls = []

    def _chat(self, messages, schema, *, model, temperature, cancel=None, max_tokens=None):
        self.calls.append({"messages": messages, "schema": schema, "temperature": temperature, "max_tokens": max_tokens})
        r = self.responses.pop(0)
        if isinstance(r, dict) and "raw" in r:  # respuesta con motivo de fin (p. ej. «length» = cortada por el tope)
            self.last_finish = r.get("finish", "stop")
            return r["raw"]
        self.last_finish = "stop"
        return r

    def health(self):
        return {"ok": True}


def _page(texts, statuses=None):
    regions = []
    for i, t in enumerate(texts):
        regions.append(Region(id=f"r{i}", order=i, bbox=(0, 0, 100, 100), layout_box=(0, 0, 100, 100), source_text=t,
                              max_chars=40, status=(statuses or {}).get(i, "pending"),
                              translation="(fijado)" if (statuses or {}).get(i) == "approved" else ""))
    return Page(id="page-1", index=0, filename="1.png", ext="png", width=800, height=1200, sha1="", dhash="0", regions=regions)


def _project():
    return Project(id="proj-1", name="Prueba", source_lang="ja", page_ids=["page-1"],
                   characters=[Character(source="麻美", target="Asami", gender="f", speech="informal", locked=True)],
                   glossary=[GlossaryEntry(source="ラーメン", target="ramen", locked=True)])


def test_parse_json_tolerates_think_and_fences():
    assert parse_json('<think>x</think>```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json('texto {"a": [1]} fin') == {"a": [1]}


def test_translation_with_review_and_flags():
    draft = {"items": [
        {"n": 1, "translation": "¿Una carta de casa…?", "speaker": "Asami", "emotion": "sorpresa", "confidence": 0.92,
         "flags": [], "note": "", "source_fix": ""},
        {"n": 2, "translation": "Mejor busco otro curro", "speaker": "Asami", "emotion": "desgana", "confidence": 0.6,
         "flags": ["ambiguous"], "note": "Puede ser ironía", "source_fix": ""},
    ], "new_terms": [{"source": "パチンコ", "target": "pachinko", "note": ""}],
        "characters": [{"source": "健", "target": "Ken", "gender": "m", "speech": "tímido"}],
        "page_summary": "Asami recibe una carta."}
    review = {"items": [
        {"n": 1, "final": "¿Una carta de casa…?", "issue": "", "confidence": 0.95},
        {"n": 2, "final": "Mejor busco otro trabajo", "issue": "regionalismo", "confidence": 0.8},
    ]}
    client = ScriptedClient([json.dumps(draft, ensure_ascii=False), json.dumps(review, ensure_ascii=False)])
    tr = ContextualTranslator(client, "qwen3.5:9b", TranslationSettings(quality="max"))
    project = _project()
    result = tr.translate_page(project, _page(["実家からの手紙…？", "またパチンコやろうかな"]), prev_page=None,
                               next_page=None, story=["p.0: Inicio"], image_jpeg=b"\xff\xd8fake")
    by_id = {r.id: r for r in result.updated}
    assert by_id["r0"].translation == "¿Una carta de casa…?" and by_id["r0"].status == "translated"
    assert by_id["r1"].translation == "Mejor busco otro trabajo"
    assert by_id["r1"].status == "review" and "ambiguous" in by_id["r1"].flags
    assert by_id["r1"].confidence == 0.6  # se conserva la opinión más prudente
    assert result.reviewed == 1

    system, user = client.calls[0]["messages"]
    assert "latinoamericano" in system.content and "vosotros" in system.content
    assert "麻美 → Asami" in user.content and "ラーメン → ramen" in user.content
    assert "p.0: Inicio" in user.content and user.images  # contexto e imagen
    assert client.calls[1]["temperature"] == 0.2

    merge_memory(project, result)
    assert any(g.source == "パチンコ" for g in project.glossary)
    assert any(c.source == "健" for c in project.characters)


def test_user_approved_lines_are_not_retranslated():
    draft = {"items": [{"n": 2, "translation": "Hola", "speaker": "", "emotion": "", "confidence": 0.9, "flags": [],
                        "note": "", "source_fix": ""}], "new_terms": [], "characters": [], "page_summary": ""}
    client = ScriptedClient([json.dumps(draft)])
    tr = ContextualTranslator(client, "m", TranslationSettings(quality="balanced"))
    result = tr.translate_page(_project(), _page(["一", "二"], statuses={0: "approved"}), prev_page=None, next_page=None,
                               story=[], image_jpeg=None)
    assert [r.id for r in result.updated] == ["r1"]
    user = client.calls[0]["messages"][1].content
    assert "(fijado)" in user and len(client.calls) == 1


def test_missing_item_marked_for_review():
    draft = {"items": [], "new_terms": [], "characters": [], "page_summary": ""}
    tr = ContextualTranslator(ScriptedClient([json.dumps(draft)]), "m", TranslationSettings(quality="balanced"))
    result = tr.translate_page(_project(), _page(["一"]), prev_page=None, next_page=None, story=[], image_jpeg=None)
    assert result.updated[0].status == "review" and "untranslated" in result.updated[0].flags


def test_locked_memory_not_overwritten():
    project = _project()
    from starblitz_engine.translate.contextual import PageTranslation

    merge_memory(project, PageTranslation(updated=[], summary="", characters=[Character(source="麻美", target="Mami")]))
    assert project.characters[0].target == "Asami"


def test_max_chars_scales_with_area():
    small = estimate_max_chars((0, 0, 80, 120), 20, 1600, True)
    big = estimate_max_chars((0, 0, 300, 400), 20, 1600, True)
    assert 6 <= small < big


def _single_item(translation: str) -> str:
    return json.dumps({"items": [{"n": 1, "translation": translation, "speaker": "", "emotion": "", "confidence": 0.9,
                                  "flags": [], "note": "", "source_fix": ""}],
                       "new_terms": [], "characters": [], "page_summary": "x"}, ensure_ascii=False)


def test_model_refusal_is_not_saved_as_translation():
    client = ScriptedClient([_single_item("Lo siento, no puedo ayudar con esa solicitud.")])
    tr = ContextualTranslator(client, "m", TranslationSettings(quality="balanced"))
    result = tr.translate_page(_project(), _page(["殺してやる"]), prev_page=None, next_page=None, story=[], image_jpeg=None)
    region = result.updated[0]
    assert region.translation == "" and "refused" in region.flags and region.status == "review"


def test_apology_in_dialogue_is_not_a_refusal():
    client = ScriptedClient([_single_item("¡Lo siento, Tanaka! No volverá a pasar.")])
    tr = ContextualTranslator(client, "m", TranslationSettings(quality="balanced"))
    result = tr.translate_page(_project(), _page(["すまん、田中！"]), prev_page=None, next_page=None, story=[], image_jpeg=None)
    assert result.updated[0].translation.startswith("¡Lo siento, Tanaka!") and "refused" not in result.updated[0].flags


def test_fiction_fidelity_instruction_in_system_prompt():
    client = ScriptedClient([_single_item("Te mataré, imbécil.")])
    tr = ContextualTranslator(client, "m", TranslationSettings(quality="balanced"))
    tr.translate_page(_project(), _page(["殺してやる、バカ"]), prev_page=None, next_page=None, story=[], image_jpeg=None)
    system = client.calls[0]["messages"][0].content
    assert "no los suavices" in system and "ficción" in system


# --- Recuperación ante JSON inválido (2026-11-10) ------------------------------------------------------------------------

def _one(n, text, echo):
    return {"n": n, "src_start": echo, "translation": text, "speaker": "", "emotion": "", "confidence": 0.9, "flags": [],
            "note": "", "source_fix": ""}


def test_truncated_page_response_is_salvaged_and_recovered_text_by_text():
    from starblitz_engine.translate.llm import salvage_items

    page = _page(["Hello there friend", "See you later", "Good night"])
    cut = '{"items": [' + json.dumps(_one(1, "Hola, amigo", "Hello there friend")) + ', {"n": 2, "translation": "Nos ve'
    assert [i["n"] for i in salvage_items([cut])] == [1]
    client = ScriptedClient([
        {"raw": cut, "finish": "length"},                                     # cortada: no se reintenta igual
        json.dumps({"items": [_one(2, "Nos vemos", "See you later")], "new_terms": [], "characters": [], "page_summary": ""}),
        "nada", "tampoco",                                                    # el 3, ilegible dos veces…
        "otra vez nada", "{",                                                 # …y en su segundo intento
    ])
    tr = ContextualTranslator(client, "m", TranslationSettings())
    result = tr.translate_page(_project(), page, prev_page=None, next_page=None, story=[], image_jpeg=None)
    by_id = {r.id: r for r in result.updated}
    assert by_id["r0"].translation == "Hola, amigo" and by_id["r1"].translation == "Nos vemos"
    assert by_id["r2"].translation == "" and "untranslated" in by_id["r2"].flags  # se conserva el original
    assert (result.json_invalid, result.salvaged, result.recovered, result.json_lost) == (3, 1, 1, 1)
    assert len(client.calls) == 6 and client.calls[1]["max_tokens"] == 512   # reintentos acotados, tope bajo por texto


def test_salvaged_item_with_someone_elses_echo_is_not_used():
    page = _page(["Where is my umbrella", "Nobody knows"])
    broken = '{"items": [' + json.dumps(_one(1, "Nadie lo sabe", "Nobody knows")) + ", {"   # el 1 trae el texto del 2
    good = json.dumps({"items": [_one(1, "¿Dónde está mi paraguas?", "Where is my")], "new_terms": [], "characters": [], "page_summary": ""})
    good2 = json.dumps({"items": [_one(2, "Nadie lo sabe", "Nobody knows")], "new_terms": [], "characters": [], "page_summary": ""})
    client = ScriptedClient([{"raw": broken, "finish": "length"}, good, good2])
    result = ContextualTranslator(client, "m", TranslationSettings()).translate_page(
        _project(), page, prev_page=None, next_page=None, story=[], image_jpeg=None)
    assert [r.translation for r in result.updated] == ["¿Dónde está mi paraguas?", "Nadie lo sabe"]
    assert (result.salvaged, result.recovered) == (0, 2)


def test_short_version_cannot_leave_the_sentence_hanging():
    from starblitz_engine.translate.contextual import _acceptable_short

    assert not _acceptable_short("AFTER YOU-", "Después de usted—", "Después de—", "es-419", [])
    assert _acceptable_short("I DON'T CARE WHO YOU THINK YOU ARE", "No me importa quién crees que eres",
                             "Me da igual quién te crees", "es-419", [])
