"""Perfiles de traducción y diccionario personal: el prompt cambia con el perfil, el diccionario se fusiona sin pisar al
proyecto y los ajustes se validan y saneán."""

import json

import pytest
from pydantic import ValidationError

from starblitz_engine.core.settings import MAX_DICTIONARY, LLMSettings, Settings, TranslationSettings
from starblitz_engine.projects.schema import GlossaryEntry, Page, Project, ProjectCreate, ProjectUpdate, Region
from starblitz_engine.translate.contextual import ContextualTranslator, effective_glossary
from starblitz_engine.translate.llm import LLMClient
from starblitz_engine.translate.prompts import DEFAULT_PROFILE, PROFILES


class Recorder(LLMClient):
    def __init__(self, response):
        super().__init__(LLMSettings())
        self.response, self.calls = response, []

    def _chat(self, messages, schema, *, model, temperature, cancel=None, max_tokens=None):
        self.calls.append(messages)
        return self.response


def _page():
    r = Region(id="r0", order=0, bbox=(0, 0, 10, 10), layout_box=(0, 0, 10, 10), source_text="先輩、ラーメン", max_chars=40)
    return Page(id="g1", index=0, filename="1.png", ext="png", width=800, height=1200, sha1="", dhash="0", regions=[r])


def _answer(new_terms=()):
    return json.dumps({"items": [{"n": 1, "translation": "Sempai, ramen", "speaker": "", "emotion": "", "confidence": 0.9,
                                  "flags": [], "note": "", "source_fix": ""}],
                       "new_terms": list(new_terms), "characters": [], "page_summary": "x"})


def _translate(project, settings=None, response=None):
    client = Recorder(response or _answer())
    tr = ContextualTranslator(client, "m", settings or TranslationSettings(quality="balanced"))
    result = tr.translate_page(project, _page(), prev_page=None, next_page=None, story=[], image_jpeg=None)
    return client, result


@pytest.mark.parametrize("profile", list(PROFILES))
def test_each_profile_changes_the_system_prompt(profile):
    client, _ = _translate(Project(id="p", name="x", page_ids=["g1"], translation_profile=profile))
    system = client.calls[0][0].content
    assert PROFILES[profile][2] in system
    others = [v[2] for k, v in PROFILES.items() if k != profile]
    assert not any(o in system for o in others)


def test_old_projects_without_profile_use_natural():
    data = Project(id="p", name="x").model_dump()
    data.pop("translation_profile")  # proyecto guardado por una versión anterior
    assert Project.model_validate(data).translation_profile == DEFAULT_PROFILE == "natural"


def test_reviewer_receives_the_profile_too():
    review = json.dumps({"items": [{"n": 1, "final": "Sempai, ramen", "issue": "", "confidence": 0.9}]})
    client = Recorder(_answer())
    responses = [_answer(), review]
    client._chat = lambda messages, schema, **kw: (client.calls.append(messages), responses.pop(0))[1]  # type: ignore[method-assign]
    tr = ContextualTranslator(client, "m", TranslationSettings(quality="max"))
    tr.translate_page(Project(id="p", name="x", page_ids=["g1"], translation_profile="fiel"), _page(), prev_page=None, next_page=None,
                      story=[], image_jpeg=None)
    assert len(client.calls) == 2
    assert PROFILES["fiel"][2] in client.calls[1][0].content


def test_invalid_profile_is_rejected():
    with pytest.raises(ValidationError):
        ProjectUpdate(translation_profile="inventado")
    with pytest.raises(ValidationError):
        ProjectCreate(name="x", translation_profile="inventado")
    with pytest.raises(ValidationError):
        TranslationSettings(profile="inventado")


def test_dictionary_is_applied_and_project_glossary_wins():
    project = Project(id="p", name="x", page_ids=["g1"], glossary=[GlossaryEntry(source="ラーメン", target="ramen", locked=True)])
    settings = TranslationSettings(quality="balanced", dictionary=[
        GlossaryEntry(source="先輩", target="sempai"), GlossaryEntry(source="ラーメン", target="fideos ramen")])
    assert [(g.source, g.target) for g in effective_glossary(project, settings.dictionary)] == [("ラーメン", "ramen"), ("先輩", "sempai")]
    client, _ = _translate(project, settings)
    user = client.calls[0][1].content
    assert "- 先輩 → sempai" in user and "- ラーメン → ramen" in user and "fideos ramen" not in user


def test_dictionary_terms_are_not_suggested_again_as_new_terms():
    settings = TranslationSettings(quality="balanced", dictionary=[GlossaryEntry(source="先輩", target="sempai")])
    terms = [{"source": "先輩", "target": "senpai", "note": ""}, {"source": "食べる", "target": "comer", "note": ""}]
    _, result = _translate(Project(id="p", name="x", page_ids=["g1"]), settings, _answer(terms))
    assert [t.source for t in result.new_terms] == ["食べる"]


def test_dictionary_is_cleaned_and_always_locked():
    s = TranslationSettings(dictionary=[
        GlossaryEntry(source="  先輩 ", target=" sempai ", note=" n ", locked=False), GlossaryEntry(source="先輩", target="otro"),
        GlossaryEntry(source="", target="x"), GlossaryEntry(source="x", target="  ")])
    assert [(e.source, e.target, e.note, e.locked) for e in s.dictionary] == [("先輩", "sempai", "n", True)]


def test_dictionary_size_is_limited():
    too_many = [GlossaryEntry(source=f"t{i}", target=f"v{i}") for i in range(MAX_DICTIONARY + 1)]
    with pytest.raises(ValidationError):
        TranslationSettings(dictionary=too_many)


def test_old_settings_files_load_with_defaults():
    s = Settings.model_validate({"translation": {"target_variant": "es-ES"}})
    assert s.translation.profile == "natural" and s.translation.dictionary == []
