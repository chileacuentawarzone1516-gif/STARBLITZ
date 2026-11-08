"""Traducción en texto plano por lotes de página (modelos dedicados). Con modelo SIMULADO: verifica el protocolo, no la calidad real."""
import re

from starblitz_engine.core.settings import LLMSettings, TranslationSettings
from starblitz_engine.projects.schema import Character, GlossaryEntry, Page, Project, Region
from starblitz_engine.translate.contextual import ContextualTranslator
from starblitz_engine.translate.llm import ChatMessage, LLMClient, plamo_system_message
from starblitz_engine.translate.plain import (
    Pair, PlainTranslator, build_plain_request, is_dedicated_mt, make_translator, mt_family, parse_plain,
)


SPANISH = {"おはよう": "Buenos días", "どこへ行くの？": "¿Adónde vas?", "ありがとう": "Gracias", "先輩！": "¡Senpai!", "待って": "Espera"}


class FakeClient(LLMClient):
    """Contesta a las llamadas de texto plano; `reply` permite forzar la respuesta (None = comportamiento normal)."""

    def __init__(self, reply=None, refuse=lambda t: False):
        super().__init__(LLMSettings())
        self.calls = []
        self.reply = reply
        self.refuse = refuse

    def chat_plain(self, messages, *, model, temperature=0.0, max_tokens=1024, extra=None, cancel=None):
        self.calls.append({"messages": messages, "extra": extra or {}, "max_tokens": max_tokens})
        if self.reply:
            custom = self.reply(messages, extra or {}, len(self.calls))
            if custom is not None:
                return custom
        tr = lambda s: "Lo siento, no puedo ayudar con eso." if self.refuse(s) else SPANISH.get(s, f"ES({s})")  # noqa: E731
        user = messages[-1].content
        numbered = [m for m in (re.match(r"^\[(\d+)\] (.*)$", ln) for ln in user.split("\n")) if m]
        if numbered:
            return "\n".join(f"[{m.group(1)}] {tr(m.group(2))}" for m in numbered)
        if (extra or {}).get("chat_template_kwargs", {}).get("target_lang"):
            return "\n".join(tr(ln) for ln in user.split("\n"))
        return tr(user.split("\n\n")[-1])

    def health(self):
        return {"ok": True}

    def _chat(self, *a, **k):  # no se usa en texto plano
        raise AssertionError("no debe haber llamadas con JSON")


def _pages():
    def region(i, text, status="pending", translation=""):
        return Region(id=f"r{i}", order=i, bbox=(0, 0, 100, 100), layout_box=(0, 0, 100, 100), source_text=text, max_chars=40,
                      status=status, translation=translation)
    p1 = Page(id="p1", index=0, filename="1.png", ext="png", width=800, height=1200, sha1="", dhash="0",
              regions=[region(0, "おはよう"), region(1, "どこへ行くの？"), region(2, "ありがとう")])
    p2 = Page(id="p2", index=1, filename="2.png", ext="png", width=800, height=1200, sha1="", dhash="0",
              regions=[region(0, "先輩！"), region(1, "待って")])
    return p1, p2


def _project(**kw):
    return Project(id="proj", name="Prueba", source_lang="ja", page_ids=["p1", "p2"], **kw)


def _tr(family, client):
    return PlainTranslator(client, "modelo", family, TranslationSettings())


def _go(tr, project, page, prev=None):
    return tr.translate_page(project, page, prev_page=prev, next_page=None, story=[], image_jpeg=None)


def test_family_detection():
    assert mt_family("pfnet/plamo-3-translate-0.8b-GGUF") == "plamo"
    assert mt_family("tencent/Hy-MT2-1.8B-GGUF Hy-MT2-1.8B-Q4_K_M.gguf") == "hymt"
    assert mt_family("HY-MT1.5-1.8B") == "hymt"
    assert mt_family("qwen3.5-4b-q4km") == "generic"
    assert mt_family("plamo-2-translate") == "generic"
    assert is_dedicated_mt("hy-mt2") and not is_dedicated_mt("gemma4-e2b")


def test_request_formats():
    base = dict(lang="ja", texts=["おはよう", "待って"], glossary=[Pair("先輩", "senpai")], history=[], batch=True)
    r = build_plain_request("plamo", **{**base, "history": [Pair("やあ", "Hola")]})
    assert [m.role for m in r.messages] == ["user", "assistant", "user"]
    assert r.messages[2].content == "おはよう\n待って"
    assert r.extra["chat_template_kwargs"] == {"target_lang": "es", "source_lang": "ja", "glossary": [{"source": "先輩", "target": "senpai"}]}
    assert build_plain_request("plamo", **{**base, "lang": "es", "glossary": []}).extra["chat_template_kwargs"] == {"target_lang": "es"}
    u = build_plain_request("hymt", **base).messages[0].content
    assert "Reference the following translations:\n先輩 translates to senpai" in u
    assert "[1] おはよう\n[2] 待って" in u and "Do not soften or censor" in u
    g = build_plain_request("generic", **base, variant="es-ES")
    assert g.messages[0].role == "system" and "sin suavizar" in g.messages[0].content and "España" in g.messages[0].content


def test_parse():
    assert parse_plain("hymt", "[1] Hola\n[3] Adiós", 3, True) == ["Hola", "", "Adiós"]
    assert parse_plain("plamo", "Hola\nQué tal", 2, True) == ["Hola", "Qué tal"]
    assert parse_plain("plamo", "Hola Qué tal", 2, True) == ["", ""]
    assert parse_plain("hymt", "<think>x</think>Hola", 1, False) == ["Hola"]


def test_plamo_system_message_for_servers_without_template_kwargs():
    m = plamo_system_message({"chat_template_kwargs": {"target_lang": "es", "source_lang": "ja", "glossary": [{"source": "先輩", "target": "senpai"}]}})
    assert m.role == "system"
    assert m.content == "[plamo-translate]\ntarget_lang=es\nsource_lang=ja\nglossary=先輩 => senpai"
    assert plamo_system_message({}) is None


def test_whole_page_in_one_plain_call_without_invented_metadata():
    p1, _ = _pages()
    client = FakeClient()
    res = _go(_tr("plamo", client), _project(), p1)
    assert len(client.calls) == 1
    assert [r.translation for r in res.updated] == ["Buenos días", "¿Adónde vas?", "Gracias"]
    assert all(r.status == "translated" and r.speaker == "" and not r.flags for r in res.updated)
    assert res.new_terms == [] and res.characters == []


def test_missing_line_is_requested_again_alone_never_omitted():
    p1, _ = _pages()

    def reply(messages, extra, n):
        if n == 1:
            return "[1] Buenos días\n[3] Gracias"
        return None
    client = FakeClient(reply=reply)
    res = _go(_tr("hymt", client), _project(), p1)
    assert [r.translation for r in res.updated] == ["Buenos días", "¿Adónde vas?", "Gracias"]
    assert len(client.calls) == 2  # lote + solo la línea 2
    assert res.updated[1].confidence < res.updated[0].confidence


def test_refusal_is_not_saved_as_translation():
    _, p2 = _pages()
    client = FakeClient(refuse=lambda t: t == "待って")
    res = _go(_tr("hymt", client), _project(), p2)
    refused = next(r for r in res.updated if r.source_text == "待って")
    assert refused.translation == "" and "refused" in refused.flags and refused.status == "review"
    assert next(r for r in res.updated if r.source_text == "先輩！").translation == "¡Senpai!"


def test_empty_answer_leaves_untranslated_in_review():
    p1, _ = _pages()
    res = _go(_tr("hymt", FakeClient(reply=lambda *a: "")), _project(), p1)
    assert all("untranslated" in r.flags and r.status == "review" and r.translation == "" for r in res.updated)


def test_original_script_leak_goes_to_review_and_approved_is_kept():
    p1, _ = _pages()
    p1.regions[1].status = "approved"
    p1.regions[1].translation = "A mano"
    client = FakeClient(reply=lambda m, e, n: "\n".join("Hola 오" if i == 0 else f"ES({ln})" for i, ln in enumerate(m[-1].content.split("\n"))))
    res = _go(_tr("plamo", client), _project(), p1)
    assert len(res.updated) == 2
    assert res.updated[0].status == "review" and "ambiguous" in res.updated[0].flags and res.updated[0].translation == "Hola 오"


def test_glossary_only_what_appears_and_history_from_previous_page():
    p1, p2 = _pages()
    project = _project(glossary=[GlossaryEntry(source="先輩", target="senpai", locked=True), GlossaryEntry(source="魔王", target="Rey Demonio", locked=True)],
                       characters=[Character(source="おはよう", target="Buenos días (apodo)", gender="?", speech="", locked=True)])
    client = FakeClient()
    tr = _tr("plamo", client)
    _go(tr, project, p1)
    assert [g["source"] for g in client.calls[0]["extra"]["chat_template_kwargs"]["glossary"]] == ["おはよう"]
    for r in p1.regions:
        r.translation = f"T:{r.source_text}"
    _go(tr, project, p2, prev=p1)
    msgs = client.calls[1]["messages"]
    assert [m.role for m in msgs] == ["user", "assistant", "user", "assistant", "user", "assistant", "user"]
    assert msgs[1].content == "T:おはよう" and msgs[-1].content == "先輩！\n待って"
    # el glosario también cubre lo que aparece en la página anterior (ahí está «おはよう»)
    assert [g["source"] for g in client.calls[1]["extra"]["chat_template_kwargs"]["glossary"]] == ["先輩", "おはよう"]


def test_history_skips_refused_and_untranslated():
    p1, p2 = _pages()
    p1.regions[0].translation = "Bien"
    p1.regions[1].translation = ""
    p1.regions[2].translation = "Roto"
    p1.regions[2].flags = ["refused"]
    client = FakeClient()
    _go(_tr("plamo", client), _project(), p2, prev=p1)
    assert [m.content for m in client.calls[0]["messages"]] == ["おはよう", "Bien", "先輩！\n待って"]


def test_factory_chooses_translator_by_model_family():
    class Info:
        def __init__(self, id, repo, files):
            self.id, self.repo, self.files = id, repo, files

    class Lib:
        def installed(self):
            return [Info("modelo-x", "tencent/Hy-MT2-1.8B-GGUF", ["Hy-MT2-1.8B-Q4_K_M.gguf"]), Info("qwen3.5-4b-q4km", "unsloth/Qwen3.5-4B-GGUF", ["Qwen3.5-4B-Q4_K_M.gguf"])]

    s = TranslationSettings()
    assert isinstance(make_translator(FakeClient(), "modelo-x", s, Lib()), PlainTranslator)
    assert isinstance(make_translator(FakeClient(), "qwen3.5-4b-q4km", s, Lib()), ContextualTranslator)
    assert isinstance(make_translator(FakeClient(), "plamo-3-translate-0.8b", s, None), PlainTranslator)


def test_default_client_without_plain_support_says_so():
    import pytest

    from starblitz_engine.core.errors import LLMUnavailableError

    class Bare(LLMClient):
        def health(self):
            return {"ok": True}

    with pytest.raises(LLMUnavailableError):
        Bare(LLMSettings()).chat_plain([ChatMessage("user", "x")], model="m")
