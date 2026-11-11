"""Compara las salidas de `translate_models.py` (mismas regiones traducidas por varios modelos).

Imprime en Markdown: (1) métricas automáticas por modelo — tiempo, tokens, RAM/VRAM, fallos de JSON, textos sin traducir, marcas,
«vosotros», nombres propios perdidos —, y (2) las frases SONDA lado a lado: textos del capítulo con errores ya documentados
(género, modismos, nombres, variante es-419) para revisarlas a mano. Las métricas automáticas NO miden la calidad por sí solas.

Uso: python tools/bench/translate_compare.py qwen4b.json qwen9b.json gemma-e4b.json [--names ...] > comparacion.md
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from starblitz_engine.translate import quality  # noqa: E402

# Frases del capítulo de prueba (Ultimate Spider-Man n.º 1, en inglés) con errores documentados en EVALUACION-CORPUS-USM §7 y §11.
PROBES = [
    ("ARE YOU SWEET ON HIM", "género: Harry es varón («enamorado»)"),
    ("SWEET ON YOU", "género del hablante"),
    ("DOGHOUSE", "modismo: estar castigado / en problemas"),
    ("MILLION DOLLARS", "modismo: verse espléndido"),
    ("YOU DID GREAT", "lo hiciste genial"),
    ("PUNKS HAVE PRACTICE", "es-419: «ustedes», nada de «vosotros»"),
    ("JERKHOLE", "insulto sin suavizar"),
    ("ROLL IT OFF", "modismo"),
    ("LEAVE THE KID ALONE", "sentido: «deja en paz al chico»"),
    ("PARKER HOME", "cartela de lugar con OCR roto («HE PARKER HOME»)"),
    ("QUEENS DISTRICT", "nombre propio (Queens) sin traducir"),
    ("MARY JANE SITTING", "nombre propio estable"),
    ("TELL YOU WHAT", "palabras inventadas («CUENTARTE»)"),
    ("COULDA FOOLED", "modismo: «pues no lo parecía»"),
    ("SPIDER BITE", "OCR roto («MIXEI»)"),
    ("BUMMER", "interjección breve"),
    ("WIGGED OUT", "modismo: me asusté / perdí los nervios"),
    ("POWERLESS", "título (no «impotente»)"),
]
NAMES = [("Peter", "Peter"), ("Parker", "Parker"), ("Mary Jane", "Mary Jane"), ("Harry", "Harry"), ("Osborn", "Osborn"),
         ("Queens", "Queens"), ("Ben", "Ben"), ("May", "May"), ("Thompson", "Thompson"), ("Norman", "Norman"), ("Oz", "Oz")]


def load(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def texts(run: dict) -> list[dict]:
    return [t for p in run["pages"] for t in p["texts"] if t["src"].strip()]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="+")
    ap.add_argument("--names", nargs="*", help="etiqueta de cada salida (por defecto, el nombre del modelo)")
    a = ap.parse_args()
    runs = [load(p) for p in a.runs]
    labels = a.names or [r["summary"]["model"] for r in runs]

    rows = []
    for lab, run in zip(labels, runs):
        s, ts = run["summary"], texts(run)
        done = [t for t in ts if t["es"].strip()]
        secs = [p["s"] for p in run["pages"] if p["calls"]]
        secs.sort()
        rows.append({
            "Modelo": lab, "Págs. con error": s["page_errors"], "Textos": s["texts"],
            "Sin traducir": s["untranslated"], "En revisión": s["review"],
            "JSON inválido / rescatados / recuperados / perdidos": f"{s['json_invalid']} / {s['salvaged']} / {s['recovered']} / {s['json_lost']}",
            "Cortes por tope": s["truncated"], "Reparación (textos)": s["repaired"], "Reformulados": s["condensed"],
            "«vosotros»": sum(1 for t in done if quality.has_vosotros(t["es"]) and not quality.has_vosotros(t["src"])),
            "Nombres perdidos": sum(1 for t in done if quality.lost_names(t["src"], t["es"], NAMES)),
            "Inventados / desalineados": f"{s['flags'].get('invented', 0)} / {s['flags'].get('misaligned', 0)}",
            "too_long": s["flags"].get("too_long", 0),
            "Tiempo total (s)": s["seconds"], "Mediana por página (s)": secs[len(secs) // 2] if secs else 0,
            "Tokens generados": s["completion_tokens"],
            "tok/s (gen.)": round(s["completion_tokens"] / max(1e-6, sum(c["s"] for c in run["calls"])), 1),
            "RAM pico servidor (MB)": s["llm_rss_peak_mb"], "VRAM pico GPU (MB)": s["vram_peak_mb"],
        })
    cols = list(rows[0])
    print("| Métrica | " + " | ".join(r["Modelo"] for r in rows) + " |")
    print("|---|" + "---|" * len(rows))
    for c in cols[1:]:
        print(f"| {c} | " + " | ".join(str(r[c]) for r in rows) + " |")

    print("\n## Frases sonda (revisión manual)\n")
    by_src = [{t["src"].upper(): t for t in texts(run)} for run in runs]
    for probe, why in PROBES:
        src = next((k for k in by_src[0] if probe in k), None)
        if not src:
            continue
        print(f"**{src[:90]}** — _{why}_\n")
        for lab, idx in zip(labels, by_src):
            t = idx.get(src)
            es = t["es"] if t and t["es"] else "(sin traducción)"
            fl = f" `{','.join(f for f in t['flags'] if f not in ('idiom', 'cultural'))}`" if t and t["flags"] else ""
            print(f"- {lab}: {es}{fl}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
