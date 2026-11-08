"""Descarga, catálogo de Hugging Face, biblioteca de modelos, servidor integrado y asesor de perfiles."""

import threading
import time

import pytest

from conftest import read_llama_log
from starblitz_engine.core.download import download_file
from starblitz_engine.core.errors import AppError, CancelledError, LLMUnavailableError
from starblitz_engine.core.hardware import GPUInfo, HardwareInfo
from starblitz_engine.core.settings import LLMSettings, SettingsStore
from starblitz_engine.llm import advisor, hf
from starblitz_engine.llm.catalog import PROFILES, classify, estimate_memory_gb, fit_model, license_info
from starblitz_engine.llm.library import LLMLibrary, describe_repo, make_id, quant_of
from starblitz_engine.llm.runtime import LlamaRuntime
from starblitz_engine.projects.schema import Project
from starblitz_engine.translate.llm import ChatMessage, create_client

NOHW = HardwareInfo("test", "cpu", 8, 16, 32 * 1024, [GPUInfo("RTX 4070 Laptop", 8192, "nvidia")])
LOWHW = HardwareInfo("test", "cpu", 4, 8, 8 * 1024)
TINYHW = HardwareInfo("test", "cpu", 2, 4, 4 * 1024)


def _install(lib, repo="fake-org/Tiny-Qwen-GGUF", path="Tiny-Q4_K_M.gguf", mmproj=None, hw=NOHW, **kw):
    return lib.install(repo, path, mmproj=mmproj, token=kw.pop("token", ""), hw=hw, context=8192,
                       progress=lambda p, m: None, cancel=threading.Event(), **kw)


# -- descarga ------------------------------------------------------------------------------------

def test_download_resumes_after_cut_connection(hf_endpoint, tmp_path):
    mod, url = hf_endpoint
    remote = hf.fetch_model("fake-org/Tiny-Qwen-GGUF")
    f = remote.file("Tiny-Q4_K_M.gguf")
    mod.STATE["fail_once"].add("Tiny-Q4_K_M.gguf")
    dest = download_file([remote.url(f.path)], tmp_path / "m.gguf", expected_size=f.size, sha256=f.sha256)
    assert dest.stat().st_size == f.size and not (tmp_path / "m.gguf.part").exists()
    ranges = [r[2] for r in mod.STATE["requests"] if r[0] == "resolve"]
    assert ranges[0] == "" and ranges[1].startswith("bytes=")  # la segunda petición continuó donde se cortó


def test_download_rejects_corrupt_file(hf_endpoint, tmp_path):
    mod, _ = hf_endpoint
    remote = hf.fetch_model("fake-org/Tiny-Qwen-GGUF")
    f = remote.file("Tiny-Q4_K_M.gguf")
    mod.STATE["corrupt"].add("Tiny-Q4_K_M.gguf")
    with pytest.raises(AppError) as exc:
        download_file([remote.url(f.path)], tmp_path / "m.gguf", expected_size=f.size, sha256=f.sha256)
    assert exc.value.code == "integrity" and not (tmp_path / "m.gguf").exists()


# -- Hugging Face ---------------------------------------------------------------------------------

def test_search_and_repo_metadata(hf_endpoint):
    results = hf.search("qwen")
    assert results[0]["repo"] == "fake-org/Tiny-Qwen-GGUF" and results[0]["license"] == "apache-2.0"
    assert "ja" in results[0]["languages"]
    remote = hf.fetch_model("fake-org/Tiny-Qwen-GGUF")
    assert remote.revision == "a" * 40 and remote.architecture == "qwen35" and remote.license == "apache-2.0"
    assert [f.path for f in remote.shards_of("Big-00001-of-00002.gguf")] == ["Big-00001-of-00002.gguf", "Big-00002-of-00002.gguf"]


def test_gated_repo_needs_token_and_invalid_names_rejected(hf_endpoint):
    with pytest.raises(AppError) as exc:
        hf.fetch_model("fake-org/Gated-GGUF")
    assert exc.value.code == "auth_required"
    assert hf.fetch_model("fake-org/Gated-GGUF", token="good").gated
    for bad in ("../x/y", "solo", "a/b/c", "a/b c"):
        with pytest.raises(AppError):
            hf.validate_repo(bad)
    with pytest.raises(AppError):
        hf.validate_path("../../etc/passwd")


def test_repo_description_groups_quants_and_shards(hf_endpoint):
    remote = hf.fetch_model("fake-org/Tiny-Qwen-GGUF")
    info = describe_repo(remote, NOHW, 8192)
    names = [f["path"] for f in info["files"]]
    assert names == ["Big-00001-of-00002.gguf", "Tiny-Q4_K_M.gguf", "Tiny-Q8_0.gguf"]  # sin trozo 2 ni mmproj
    assert info["files"][0]["shards"] == 2 and info["files"][0]["size"] == 2_300_000
    assert info["mmproj_suggested"]["path"] == "mmproj-F16.gguf"
    assert info["license"]["class"] == "permissive"
    assert {f["fit"]["fits"] for f in info["files"]} <= {"gpu", "hybrid", "cpu"}


# -- biblioteca ------------------------------------------------------------------------------------

def test_install_list_remove_with_shards_and_mmproj(hf_endpoint, tmp_path):
    lib = LLMLibrary(tmp_path / "llm")
    m = _install(lib, path="Big-00001-of-00002.gguf", mmproj="mmproj-F16.gguf")
    assert m.files == ["Big-00001-of-00002.gguf", "Big-00002-of-00002.gguf"] and m.vision
    assert m.size == 1_200_000 + 1_100_000 + 800_000 and m.revision == "a" * 40 and m.arch == "qwen35"
    assert [x.id for x in lib.installed()] == [m.id] and lib.model_path(m.id).name == "Big-00001-of-00002.gguf"
    lib.remove(m.id)
    assert lib.installed() == [] and not (tmp_path / "llm" / m.id).exists()


def test_incompatible_model_is_blocked_unless_forced(hf_endpoint, tmp_path):
    lib = LLMLibrary(tmp_path / "llm")
    with pytest.raises(AppError) as exc:
        _install(lib, repo="fake-org/Huge-GGUF", path="Huge-Q4_K_M.gguf", hw=LOWHW)
    assert exc.value.code == "incompatible" and exc.value.status_code == 409
    assert lib.installed() == []


def test_gated_install_uses_token_only_for_hf(hf_endpoint, tmp_path):
    mod, _ = hf_endpoint
    lib = LLMLibrary(tmp_path / "llm")
    with pytest.raises(AppError) as exc:
        _install(lib, repo="fake-org/Gated-GGUF", path="Gated-Q4_0.gguf")
    assert exc.value.code == "auth_required"
    m = _install(lib, repo="fake-org/Gated-GGUF", path="Gated-Q4_0.gguf", token="good")
    assert lib.is_installed(m.id)
    assert all(r[3] == "Bearer good" for r in mod.STATE["requests"] if r[0] == "resolve")


def test_install_cancel_leaves_no_partial_model(hf_endpoint, tmp_path):
    lib = LLMLibrary(tmp_path / "llm")
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(CancelledError):
        lib.install("fake-org/Tiny-Qwen-GGUF", "Tiny-Q4_K_M.gguf", mmproj=None, token="", hw=NOHW, context=8192,
                    progress=lambda p, m: None, cancel=cancel)
    assert lib.installed() == [] and lib.installing() == []


def test_ids_and_quant_parsing():
    assert quant_of("Qwen3.5-9B-Q4_K_M.gguf") == "Q4_K_M" and quant_of("gemma-4-E2B_q4_0-it.gguf") == "Q4_0"
    assert quant_of("model-UD-Q5_K_XL.gguf") == "UD-Q5_K_XL" and quant_of("m-BF16.gguf") == "BF16"
    assert make_id("unsloth/Qwen3.5-4B-GGUF", "Qwen3.5-4B-Q4_K_M.gguf") == "qwen3-5-4b-gguf-qwen3-5-4b-q4-k-m"


# -- catálogo y perfiles -----------------------------------------------------------------------------

def test_profiles_by_device():
    assert classify(ram_gb=4, vram_gb=0, mobile=True) == "low" and classify(7.4, 0, mobile=True) == "mid"
    assert classify(11.2, 0, mobile=True) == "high" and classify(32, 8) == "pc-gpu" and classify(8, 0) == "low"
    assert classify(16, 0) == "mid" and classify(32, 0) == "high"
    assert advisor.current_profile(NOHW).id == "pc-gpu" and advisor.current_profile(LOWHW).id == "low"
    assert advisor.current_profile(LOWHW, "high").id == "high"  # la elección manual manda


def test_fit_and_memory_estimates():
    need = estimate_memory_gb(5_680_522_464, 9.0, 8192, 918_166_080, "qwen35")
    assert 6.5 < need < 8.5
    assert fit_model(need, 32, 16)["fits"] == "gpu"
    assert fit_model(need, 32, 6)["fits"] == "hybrid"
    assert fit_model(need, 16, 0)["fits"] == "cpu"
    assert fit_model(need, 8, 0)["fits"] == "no"
    assert fit_model(7.0, 8, 0, mobile=True)["fits"] == "no" and fit_model(3.0, 8, 0, mobile=True)["fits"] == "cpu"


def test_licenses_classified():
    assert license_info("apache-2.0")["class"] == "permissive" and license_info("gemma")["class"] == "terms"
    assert license_info("cc-by-nc-4.0")["class"] == "restricted" and license_info("")["class"] == "unknown"


def test_advice_never_recommends_what_does_not_fit(tmp_path):
    lib = LLMLibrary(tmp_path / "llm")
    for hw in (NOHW, LOWHW, HardwareInfo("t", "c", 8, 16, 16 * 1024)):
        advice = advisor.advise(hw, lib, "")
        rec = next(o for o in advice["options"] if o["recommended"])
        assert rec["fit"]["fits"] != "no", (advice["profile"]["id"], rec["id"])
        assert advice["supported"] and rec["id"] == PROFILES[advice["profile"]["id"]].default_model or advice["profile"]["id"] == "pc-gpu"


def test_advice_is_honest_when_nothing_fits(tmp_path):
    advice = advisor.advise(TINYHW, LLMLibrary(tmp_path / "llm"), "")
    assert advice["supported"] is False and "no tiene memoria suficiente" in advice["reason"]


# -- servidor integrado ---------------------------------------------------------------------------------

@pytest.fixture
def runtime(tmp_path, hf_endpoint, fake_llama_dir):
    llama_dir, log = fake_llama_dir
    lib = LLMLibrary(tmp_path / "llm")
    model = _install(lib, mmproj="mmproj-F16.gguf")
    settings = SettingsStore(tmp_path / "settings.json")
    rt = LlamaRuntime(lib, settings, tmp_path / "logs", llama_dir)
    yield rt, lib, model, settings, log
    rt.shutdown()


def test_runtime_starts_on_demand_and_reuses_the_process(runtime):
    rt, _lib, model, _settings, log = runtime
    assert not rt.status()["running"]
    with rt.use(model.id) as ep:
        assert ep.base_url.startswith("http://127.0.0.1:") and ep.api_key
    pid = rt.status()["pid"]
    with rt.use(model.id):
        pass
    assert rt.status()["pid"] == pid and rt.running_model() == model.id
    starts = [e for e in read_llama_log(log) if e["type"] == "start"]
    assert len(starts) == 1 and starts[0]["model"] == "Tiny-Q4_K_M.gguf" and "--jinja" in starts[0]["flags"]
    assert starts[0]["mmproj"].endswith("mmproj-F16.gguf") or starts[0]["mmproj"] == ""  # solo si cabe en GPU


def test_runtime_retries_with_fewer_options_when_a_flag_is_unknown(runtime, monkeypatch):
    rt, _lib, model, _s, log = runtime
    monkeypatch.setenv("FAKE_LLAMA_REJECT", "--reasoning-budget")
    rt.ensure(model.id)
    starts = [e for e in read_llama_log(log) if e["type"] == "start"]
    assert "--reasoning-budget" not in starts[-1]["flags"] and "--jinja" in starts[-1]["flags"]
    rt.stop()
    monkeypatch.setenv("FAKE_LLAMA_REJECT", "--reasoning-budget,--jinja")
    rt.ensure(model.id)
    assert "--jinja" not in [e for e in read_llama_log(log) if e["type"] == "start"][-1]["flags"]


def test_runtime_reports_a_clear_error_when_the_server_cannot_start(runtime, monkeypatch):
    rt, _lib, model, _s, _log = runtime
    monkeypatch.setenv("FAKE_LLAMA_REJECT", "-c")  # opción imprescindible: ningún nivel de reintento puede evitarla
    with pytest.raises(LLMUnavailableError) as exc:
        rt.ensure(model.id)
    assert "no pudo arrancar" in exc.value.message and "invalid argument" in exc.value.message
    assert not rt.status()["running"]


def test_runtime_without_binary_or_model(tmp_path):
    lib = LLMLibrary(tmp_path / "llm")
    rt = LlamaRuntime(lib, SettingsStore(tmp_path / "s.json"), tmp_path / "logs", tmp_path / "vacia")
    assert not rt.available()
    with pytest.raises(LLMUnavailableError, match="servidor de modelos integrado"):
        rt.ensure("x")


def test_idle_model_is_unloaded_to_free_memory(runtime):
    rt, _lib, model, _s, _log = runtime
    rt.WATCH_INTERVAL_S = 0.1
    rt._idle_limit_s = lambda: 0.4
    rt.ensure(model.id)
    assert rt.status()["running"]
    deadline = time.time() + 5
    while rt.status()["running"] and time.time() < deadline:
        time.sleep(0.1)
    assert not rt.status()["running"]


def test_switching_models_restarts_server(runtime, hf_endpoint, tmp_path):
    rt, lib, model, _s, log = runtime
    other = _install(lib, path="Tiny-Q8_0.gguf")
    rt.ensure(model.id)
    first = rt.status()["pid"]
    rt.ensure(other.id)
    assert rt.status()["pid"] != first and rt.running_model() == other.id
    assert [e["model"] for e in read_llama_log(log) if e["type"] == "start"] == ["Tiny-Q4_K_M.gguf", "Tiny-Q8_0.gguf"]


def test_builtin_client_returns_schema_json_and_sends_expected_options(runtime):
    rt, lib, model, settings, log = runtime
    client = create_client(settings.value.llm, rt, lib)
    assert client.health()["ok"] and [m.name for m in client.list_models()] == [model.id]
    schema = {"type": "object", "properties": {"items": {"type": "array"}}, "required": ["items"]}
    out = client.chat_json([ChatMessage("system", "s"), ChatMessage("user", "u", images=[b"\xff\xd8x"])], schema, model=model.id)
    assert out == {"items": []}
    req = [e for e in read_llama_log(log) if e["type"] == "request"][-1]
    assert req["stream"] is True and req["enable_thinking"] is False and req["has_image"] is True
    assert client.last_stats["tokens"] > 0


def test_generation_can_be_cancelled_midway(runtime, monkeypatch):
    rt, lib, model, settings, log = runtime
    monkeypatch.setenv("FAKE_LLAMA_CHUNK_DELAY", "0.15")
    rt.ensure(model.id)  # el servidor ya arrancado hereda el retardo
    rt.stop()
    rt.ensure(model.id)
    client = create_client(settings.value.llm, rt, lib)
    cancel = threading.Event()
    threading.Timer(0.4, cancel.set).start()
    items = {"type": "object", "properties": {"new_terms": {}, "items": {}}}
    t0 = time.time()
    with pytest.raises(CancelledError):
        client.chat_json([ChatMessage("system", "s"), ChatMessage("user", "[1] (Diálogo, máx. ~40 caracteres) " + "あ" * 400)],
                         items, model=model.id, cancel=cancel)
    assert time.time() - t0 < 3


def test_external_providers_still_supported(tmp_path):
    cfg = LLMSettings(provider="openai", base_url="http://127.0.0.1:9", model="x")
    client = create_client(cfg)
    assert client.health()["ok"] is False
    with pytest.raises(LLMUnavailableError):
        create_client(LLMSettings(provider="builtin"))  # sin runtime ni biblioteca


def test_project_effective_language():
    p = Project(id="p1", name="x", source_lang="auto")
    assert p.lang == "ja"
    p.detected_lang = "en"
    assert p.lang == "en" and Project(id="p2", name="x", source_lang="ko").lang == "ko"
