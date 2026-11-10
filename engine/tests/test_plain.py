"""Traducción en texto plano por lotes de página (modelos dedicados). Con modelo SIMULADO: verifica el protocolo, no la calidad real."""
import re

import pytest

from starblitz_engine.core.errors import AppError, LLMUnavailableError
from starblitz_engine.core.settings import LLMSettings, TranslationSettings
from starblitz_engine.llm import hf
from starblitz_engine.projects.schema import Character, GlossaryEntry, Page, Project, Region
from starblitz_engine.translate.contextual import ContextualTranslator
from starblitz_engine.translate.llm import ChatMessage, LLMClient
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
    assert mt_family("tencent/Hy-MT2-1.8B-GGUF Hy-MT2-1.8B-Q4_K_M.gguf") == "hymt"
    assert mt_family("HY-MT1.5-1.8B") == "hymt"
    assert mt_family("qwen3.5-4b-q4km") == "generic"
    # PLaMo NO está autorizado (D3): ya no es una familia reconocida.
    assert mt_family("pfnet/plamo-3-translate-0.8b-GGUF") == "generic"
    assert is_dedicated_mt("hy-mt2") and not is_dedicated_mt("gemma4-e2b")


def test_request_formats():
    base = dict(lang="ja", texts=["おはよう", "待って"], glossary=[Pair("先輩", "senpai")], history=[], batch=True)
    u = build_plain_request("hymt", **base).messages[0].content
    assert "Reference the following translations:\n先輩 translates to senpai" in u
    assert "[1] おはよう\n[2] 待って" in u and "Do not soften or censor" in u
    g = build_plain_request("generic", **base, variant="es-ES")
    assert g.messages[0].role == "system" and "sin suavizar" in g.messages[0].content and "España" in g.messages[0].content


def test_parse():
    assert parse_plain("hymt", "[1] Hola\n[3] Adiós", 3, True) == ["Hola", "", "Adiós"]
    assert parse_plain("generic", "1. Hola\n2) Qué tal", 2, True) == ["Hola", "Qué tal"]
    assert parse_plain("hymt", "<think>x</think>Hola", 1, False) == ["Hola"]


def test_whole_page_in_one_plain_call_without_invented_metadata():
    p1, _ = _pages()
    client = FakeClient()
    res = _go(_tr("hymt", client), _project(), p1)
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

    def reply(m, e, n):
        nums = re.findall(r"^\[(\d+)\] (.*)$", m[-1].content, re.M)
        return "\n".join(f"[{k}] " + ("Hola 오" if i == 0 else f"ES({t})") for i, (k, t) in enumerate(nums))
    res = _go(_tr("hymt", FakeClient(reply=reply)), _project(), p1)
    assert len(res.updated) == 2
    assert res.updated[0].status == "review" and "ambiguous" in res.updated[0].flags and res.updated[0].translation == "Hola 오"


def test_glossary_only_what_appears():
    p1, _ = _pages()
    project = _project(glossary=[GlossaryEntry(source="先輩", target="senpai", locked=True), GlossaryEntry(source="魔王", target="Rey Demonio", locked=True)],
                       characters=[Character(source="おはよう", target="Buenos días (apodo)", gender="?", speech="", locked=True)])
    client = FakeClient()
    _go(_tr("hymt", client), project, p1)
    user = client.calls[0]["messages"][-1].content
    assert "おはよう translates to Buenos días (apodo)" in user and "魔王" not in user


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
    assert isinstance(make_translator(FakeClient(), "hy-mt2-1.8b-q4km", s, None), PlainTranslator)


def test_plamo_is_blocked_everywhere():
    """D3: PLaMo no se busca, no se describe, no se instala y, si ya estuviera instalado, no se usa."""
    for bad in ("pfnet/plamo-3-translate-0.8b-GGUF", "someone/PLaMo-3-Translate-2B"):
        with pytest.raises(AppError) as e:
            hf.validate_repo(bad)
        assert e.value.code == "model_not_allowed"
    with pytest.raises(AppError):
        hf.validate_path("plamo-3-translate-0.8b-Q4_K_M.gguf")
    assert hf.validate_repo("tencent/Hy-MT2-1.8B-GGUF")
    with pytest.raises(LLMUnavailableError):
        make_translator(FakeClient(), "plamo-3-translate-0.8b", TranslationSettings(), None)


def test_default_client_without_plain_support_says_so():
    class Bare(LLMClient):
        def health(self):
            return {"ok": True}

    with pytest.raises(LLMUnavailableError):
        Bare(LLMSettings()).chat_plain([ChatMessage("user", "x")], model="m")


def test_external_json_requests_are_bounded_and_without_reasoning():
    """Regresión (2026-11-09): con un servidor compatible con OpenAI, Qwen3.5 razonaba y generó >8 500 tokens en una página."""
    from starblitz_engine.translate.llm import JSON_MAX_TOKENS, OpenAICompatibleClient

    c = OpenAICompatibleClient(LLMSettings(provider="openai", base_url="http://127.0.0.1:1/v1"))
    p = c._payload([ChatMessage("user", "hola")], {"type": "object"}, model="m", temperature=0.2)
    assert p["max_tokens"] == JSON_MAX_TOKENS == 4096
    assert p["chat_template_kwargs"] == {"enable_thinking": False}
    assert p["response_format"]["type"] == "json_schema"
