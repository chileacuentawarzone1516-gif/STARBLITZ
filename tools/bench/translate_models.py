"""Compara modelos de lenguaje traduciendo EXACTAMENTE las mismas regiones de un capítulo ya analizado.

Toma las páginas que deja `corpus_eval.py --keep-images` (carpeta `img/` con NNN-page.json), borra sus traducciones y las vuelve a
traducir con el traductor real del motor (`ContextualTranslator`), en orden y con el mismo contexto que el procesador: resumen
acumulado, página anterior ya traducida, página siguiente en original y memoria de la obra (glosario y personajes). Sin imagen
(igual que la línea base). Mide por página tiempo, tokens y fallos de JSON, y muestrea la RAM del servidor y la VRAM de la GPU.

Uso:
  python tools/bench/translate_models.py --pages res/e2e/img --llm-url http://127.0.0.1:8081/v1 --llm-model qwen3.5-9b \\
      --llm-pid 1234 --out res/modelos/qwen9b.json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import psutil

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from starblitz_engine.core.settings import LLMSettings, TranslationSettings  # noqa: E402
from starblitz_engine.projects.schema import Page, Project  # noqa: E402
from starblitz_engine.translate.contextual import ContextualTranslator, merge_memory  # noqa: E402
from starblitz_engine.translate.llm import OpenAICompatibleClient  # noqa: E402

TRANSLATION_FLAGS = {"untranslated", "refused", "too_long", "misaligned", "invented", "variant", "name", "condensed", "original_kept",
                     "idiom", "wordplay", "sarcasm", "honorific", "cultural", "ambiguous", "ocr_suspect"}


class BenchClient(OpenAICompatibleClient):
    """Cliente del motor con el uso de tokens y el motivo de fin de cada llamada."""

    def __init__(self, settings: LLMSettings):
        super().__init__(settings)
        self.log: list[dict] = []

    def _chat(self, messages, schema, *, model, temperature, cancel=None, max_tokens=None):
        payload = self._payload(messages, schema, model=model, temperature=temperature, max_tokens=max_tokens)
        t = time.perf_counter()
        r = httpx.post(self._url("/chat/completions"), json=payload, headers=self._headers(), timeout=self._timeout())
        r.raise_for_status()
        data = r.json()
        choice = (data.get("choices") or [{}])[0]
        self.last_finish = str(choice.get("finish_reason") or "")
        usage = data.get("usage") or {}
        self.log.append({"s": round(time.perf_counter() - t, 2), "prompt": usage.get("prompt_tokens", 0),
                         "completion": usage.get("completion_tokens", 0), "finish": self.last_finish,
                         "kind": "review" if "new_terms" not in schema.get("properties", {}) else "translate"})
        return (choice.get("message") or {}).get("content", "")


class Sampler(threading.Thread):
    """RSS del servidor de lenguaje y memoria usada de la GPU (nvidia-smi), cada `every` segundos."""

    def __init__(self, pid: int, every: float = 1.0):
        super().__init__(daemon=True)
        self.proc = psutil.Process(pid) if pid else None
        self.every, self.stop_evt, self.samples = every, threading.Event(), []

    def run(self):
        while not self.stop_evt.wait(self.every):
            s: dict = {}
            if self.proc:
                try:
                    s["rss_mb"] = self.proc.memory_info().rss / 2**20
                except psutil.Error:
                    pass
            try:
                out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                                     capture_output=True, text=True, timeout=5).stdout.strip().splitlines()
                s["vram_mb"] = float(out[0])
            except (OSError, ValueError, IndexError, subprocess.SubprocessError):
                pass
            self.samples.append(s)

    def peak(self, key):
        v = [s[key] for s in self.samples if key in s]
        return round(max(v), 1) if v else None


def fresh(page: Page) -> Page:
    """La página con sus regiones tal como salieron del análisis (sin traducción ni marcas de traducción)."""
    p = page.model_copy(deep=True)
    for r in p.regions:
        r.translation, r.speaker, r.emotion, r.note, r.review_note, r.ocr_fix = "", "", "", "", "", ""
        r.flags = [f for f in r.flags if f not in TRANSLATION_FLAGS]
        r.status = "review" if "ocr_empty" in r.flags else "pending"
        r.confidence = 0.0
    p.summary = ""
    return p


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", required=True)
    ap.add_argument("--llm-url", required=True)
    ap.add_argument("--llm-model", required=True)
    ap.add_argument("--llm-pid", type=int, default=0)
    ap.add_argument("--variant", default="es-419")
    ap.add_argument("--quality", default="balanced")
    ap.add_argument("--limit", type=int, default=0, help="solo las N primeras páginas (prueba rápida)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    files = sorted(Path(a.pages).glob("*-page.json"))[: a.limit or None]
    pages = [fresh(Page.model_validate_json(f.read_text(encoding="utf-8"))) for f in files]
    for i, p in enumerate(pages):
        p.index = i
    project = Project(id="bench", name="corpus", source_lang="en", page_ids=[p.id for p in pages], target_variant=a.variant)
    client = BenchClient(LLMSettings(provider="openai", base_url=a.llm_url, model=a.llm_model, use_vision=False))
    tr = ContextualTranslator(client, a.llm_model, TranslationSettings(quality=a.quality))
    sampler = Sampler(a.llm_pid)
    sampler.start()
    story: dict[str, str] = {}
    rows, t_all = [], time.perf_counter()
    for i, page in enumerate(pages):
        n_calls = len(client.log)
        t = time.perf_counter()
        row = {"page": files[i].name[:3], "regions": len(page.regions), "error": ""}
        if any(r.source_text.strip() for r in page.regions):
            try:
                res = tr.translate_page(project, page, prev_page=pages[i - 1] if i else None,
                                        next_page=pages[i + 1] if i + 1 < len(pages) else None,
                                        story=[story[p.id] for p in pages[:i] if p.id in story], image_jpeg=None)
            except Exception as exc:  # una página con error no detiene la comparación (se cuenta)
                row["error"] = f"{type(exc).__name__}: {exc}"[:300]
                res = None
            if res is not None:
                by_id = {r.id: r for r in res.updated}
                page.regions = [by_id.get(r.id, r) for r in page.regions]
                page.summary = res.summary or page.summary
                merge_memory(project, res)
                if page.summary:
                    story[page.id] = f"p.{i + 1}: {page.summary}"
                row.update({k: getattr(res, k) for k in ("repaired", "json_invalid", "salvaged", "recovered", "json_lost", "condensed")})
        calls = client.log[n_calls:]
        row.update({"s": round(time.perf_counter() - t, 2), "calls": len(calls),
                    "prompt_tokens": sum(c["prompt"] for c in calls), "completion_tokens": sum(c["completion"] for c in calls),
                    "truncated": sum(1 for c in calls if c["finish"] == "length"),
                    "texts": [{"id": r.id, "src": r.source_text, "es": r.translation, "flags": r.flags, "status": r.status,
                               "max_chars": r.max_chars, "note": r.note} for r in page.regions]})
        rows.append(row)
        print(json.dumps({k: row[k] for k in ("page", "regions", "s", "calls", "completion_tokens", "error")}), flush=True)
    sampler.stop_evt.set()
    sampler.join()
    texts = [t for r in rows for t in r["texts"] if t["src"].strip()]
    summary = {
        "model": a.llm_model, "pages": len(rows), "page_errors": sum(1 for r in rows if r["error"]),
        "seconds": round(time.perf_counter() - t_all, 1), "texts": len(texts),
        "untranslated": sum(1 for t in texts if not t["es"].strip()),
        "review": sum(1 for t in texts if t["status"] == "review"),
        "flags": {f: sum(1 for t in texts if f in t["flags"]) for f in sorted({f for t in texts for f in t["flags"]})},
        **{k: sum(r.get(k, 0) for r in rows) for k in ("repaired", "json_invalid", "salvaged", "recovered", "json_lost", "condensed",
                                                      "calls", "prompt_tokens", "completion_tokens", "truncated")},
        "llm_rss_peak_mb": sampler.peak("rss_mb"), "vram_peak_mb": sampler.peak("vram_mb"),
        "memory": {"characters": [c.model_dump() for c in project.characters], "glossary": [g.model_dump() for g in project.glossary]},
    }
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "pages": rows, "calls": client.log}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "memory"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
