"""Exporta el catálogo de modelos y los perfiles de Python a JSON para el motor de Android (TypeScript).

El catálogo vive en `engine/starblitz_engine/llm/catalog.py` (única fuente de verdad). Este script genera:
  - apps/shared/src/llm/catalog.json            catálogo curado + perfiles
  - apps/shared/test/fixtures/llm_cases.json    casos calculados por Python para las pruebas de paridad del TS
Ejecútalo tras cambiar el catálogo:  python tools/export_llm_catalog.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from starblitz_engine.llm import catalog as c  # noqa: E402


def main() -> None:
    models = [m.to_dict() for m in c.CATALOG]
    for m, raw in zip(c.CATALOG, models):
        raw["arch"] = "qwen35" if m.family == "qwen3.5" else m.family
    profiles = {k: {"id": p.id, "label": p.label, "description": p.description, "context": p.context, "vision_llm": p.vision_llm,
                    "quality": p.quality, "ocr_japanese": p.ocr_japanese, "inpaint": p.inpaint, "default_model": p.default_model}
                for k, p in c.PROFILES.items()}
    out = ROOT / "apps" / "shared" / "src" / "llm" / "catalog.json"
    out.write_text(json.dumps({"models": models, "profiles": profiles, "arch_kv_factor": c.ARCH_KV_FACTOR}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    cases = {"classify": [], "fit": [], "estimate": [], "license": [], "pick_default": []}
    for ram in (2, 3.9, 4, 5.5, 6.4, 6.5, 7.4, 8, 10.4, 10.5, 11.2, 12, 16, 24, 32, 64):
        for vram in (0, 2, 4, 5.4, 5.5, 6, 8, 10, 12, 16, 18, 24):
            for mobile in (False, True):
                if mobile and vram:
                    continue
                cases["classify"].append({"ram": ram, "vram": vram, "mobile": mobile, "out": c.classify(ram, vram, mobile=mobile)})
    for tier in ("low", "mid", "high", "pc-gpu"):
        for vram in (0, 6, 10, 12, 18, 24):
            cases["pick_default"].append({"tier": tier, "vram": vram, "out": c.pick_default(tier, vram)})
    for need in (0.8, 1.9, 2.5, 3.6, 4.2, 5.9, 7.8, 11.0, 17.5):
        for ram in (4, 6, 8, 12, 16, 32):
            for vram in (0, 4, 6, 8, 12, 24):
                for mobile in (False, True):
                    if mobile and vram:
                        continue
                    cases["fit"].append({"need": need, "ram": ram, "vram": vram, "mobile": mobile, "out": c.fit_model(need, ram, vram, mobile=mobile)})
    for m in c.CATALOG:
        for ctx in (4096, 8192, 12288):
            arch = "qwen35" if m.family == "qwen3.5" else m.family
            cases["estimate"].append({"size": m.file.size, "params": m.params_b, "ctx": ctx, "mm": m.mmproj.size if m.mmproj else 0,
                                      "arch": arch, "out": c.estimate_memory_gb(m.file.size, m.params_b, ctx, m.mmproj.size if m.mmproj else 0, arch)})
    for lic in ("apache-2.0", "MIT", "gemma", "llama3.1", "cc-by-nc-4.0", "other", "", "desconocida", "weird-license", "openrail++", "research-only"):
        cases["license"].append({"id": lic, "out": c.license_info(lic)})
    (ROOT / "apps" / "shared" / "test" / "fixtures" / "llm_cases.json").write_text(json.dumps(cases, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(models)} modelos, {sum(len(v) for v in cases.values())} casos de paridad")


if __name__ == "__main__":
    main()
