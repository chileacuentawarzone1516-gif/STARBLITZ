#!/usr/bin/env python3
"""Antes/después: compara dos ejecuciones de `corpus_eval.py` del MISMO capítulo (p. ej. línea base y versión nueva).

Métricas generales (ninguna depende de una página concreta):
- Visión: regiones, regiones con globo, globos MAYORES que su texto (globo real y no la silueta del texto), relación área de la caja de
  rotulado / área del texto, pares de cajas de rotulado solapadas.
- Traducción: regiones traducidas / en revisión / sin traducción, marcas (too_long, misaligned, invented, variant, name,
  original_kept…), formas de «vosotros» en la salida final (es-419), traducciones cuyo uso de mayúsculas no coincide con el original.
- Rotulado (si se pasan los export.json de `export_render.mjs`): textos dibujados, que no caben, restaurados al original.
- Tiempos por etapa (mediana) y recursos.

Uso: python tools/bench/compare_versions.py <run_antes> <run_despues> <salida.json> [--export-antes X.json] [--export-despues Y.json]
"""
from __future__ import annotations

import json
import re
import statistics as st
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from starblitz_engine.translate.quality import has_vosotros, match_case  # noqa: E402

STAGES = ("deteccion", "ocr", "globos", "analisis_total", "traduccion", "reconstruccion")


def pages(run: Path) -> list[dict]:
    img = run / "img"
    return [json.loads((img / f"{n:03d}-page.json").read_text(encoding="utf-8"))
            for n in range(1, 1000) if (img / f"{n:03d}-page.json").is_file()]


def overlaps(regs: list[dict]) -> int:
    drawn = [r for r in regs if r.get("render") and r.get("translation", "").strip() and "original_kept" not in r.get("flags", [])]
    if not drawn and not any(r.get("translation") for r in regs):
        drawn = regs  # pasada solo de visión: se miden las cajas de todas las regiones
    n = 0
    for i, a in enumerate(drawn):
        for b in drawn[i + 1:]:
            la, lb = a["layout_box"], b["layout_box"]
            if min(la[2], lb[2]) > max(la[0], lb[0]) and min(la[3], lb[3]) > max(la[1], lb[1]):
                n += 1
    return n


def area(b) -> int:
    return max(0, b[2] - b[0]) * max(0, b[3] - b[1])


def metrics(run: Path, export: Path | None) -> dict:
    res = json.loads((run / "result.json").read_text(encoding="utf-8"))
    pg = pages(run)
    regs = [r for p in pg for r in p["regions"]]
    with_bubble = [r for r in regs if r.get("bubble")]
    translated = [r for r in regs if r.get("translation", "").strip()]
    flags = Counter(f for r in regs for f in r.get("flags", []))
    out = {
        "paginas": len(pg), "paginas_error": sum(1 for p in pg if p.get("status") == "error"),
        "regiones": len(regs), "con_globo": len(with_bubble),
        "globo_mayor_que_texto": sum(1 for r in with_bubble if area(r["bubble"]["bbox"]) > 1.15 * area(r["bbox"])),
        "caja_rotulado_vs_texto_mediana": round(st.median(area(r["layout_box"]) / max(1, area(r["bbox"])) for r in regs), 2) if regs else None,
        "max_chars_mediana": st.median(r.get("max_chars", 0) for r in regs) if regs else None,
        "cajas_solapadas": sum(overlaps(p["regions"]) for p in pg),
        "traducidas": len(translated),
        "estado": dict(Counter(r.get("status") for r in regs)),
        "marcas": dict(sorted(flags.items())),
        "vosotros_en_salida": sum(1 for r in translated if has_vosotros(r["translation"])),
        "mayusculas_distintas_del_original": sum(1 for r in translated if match_case(r["source_text"], r["translation"]) != r["translation"]),
        "import_s": res.get("import_s"), "proceso_s": res.get("process_s"), "recursos": res.get("resources"),
        "tiempos_mediana_s": {k: round(st.median(v), 2) for k in STAGES
                              if (v := [p["timings"][k] for p in res["pages"] if p["timings"].get(k) is not None])},
    }
    if export and export.is_file():
        ex = json.loads(export.read_text(encoding="utf-8"))["pages"]
        out["rotulado"] = {"dibujados": sum(p.get("drawn", 0) for p in ex),
                           "no_caben": sum(len(p.get("not_fit", [])) for p in ex),
                           "restaurados_al_original": sum(p.get("kept_original", 0) for p in ex)}
    return out


def main() -> int:
    a, b, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    ea = Path(sys.argv[sys.argv.index("--export-antes") + 1]) if "--export-antes" in sys.argv else None
    eb = Path(sys.argv[sys.argv.index("--export-despues") + 1]) if "--export-despues" in sys.argv else None
    data = {"antes": metrics(a, ea), "despues": metrics(b, eb)}
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(data, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
