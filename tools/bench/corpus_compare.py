#!/usr/bin/env python3
"""Compara dos evaluaciones de `corpus_eval.py` (mismas páginas, distinto detector) y genera tablas por página y del capítulo.

Referencia INDEPENDIENTE (no humana): la capa de texto OCR que trae el propio PDF (la hizo quien escaneó el cómic). Es ruidosa
e incompleta, así que solo se usa como INDICADOR de cobertura: qué parte de sus palabras cae dentro de alguna región detectada.
No se presenta como precisión ni exhaustividad reales.

Uso: python tools/bench/corpus_compare.py <capitulo.pdf> <eval_A> <eval_B> <salida.json> [--names A B]
"""
from __future__ import annotations

import difflib
import json
import re
import statistics as st
import sys
from pathlib import Path

import pypdfium2 as pdfium

WORD = re.compile(r"[A-Za-z0-9]{2,}")


def pdf_words(pdf_path: Path, sizes: list[tuple[int, int]]) -> list[list[tuple[str, tuple[float, float, float, float]]]]:
    """Palabras de la capa de texto de cada página, en píxeles de la imagen importada (origen arriba a la izquierda)."""
    doc = pdfium.PdfDocument(str(pdf_path))
    out = []
    for i, (iw, ih) in enumerate(sizes):
        page = doc[i]
        pw, ph = page.get_size()
        sx, sy = iw / pw, ih / ph
        tp = page.get_textpage()
        n = tp.count_chars()
        words, cur, box = [], "", None
        for k in range(n + 1):
            ch = tp.get_text_range(k, 1) if k < n else " "
            if ch.isalnum():
                l, b, r, t = tp.get_charbox(k)
                box = (l, b, r, t) if box is None else (min(box[0], l), min(box[1], b), max(box[2], r), max(box[3], t))
                cur += ch
            else:
                if cur and box and WORD.fullmatch(cur):
                    l, b, r, t = box
                    words.append((cur, (l * sx, (ph - t) * sy, r * sx, (ph - b) * sy)))
                cur, box = "", None
        out.append(words)
    return out


def inside(word_box, regions, margin=8) -> bool:
    cx, cy = (word_box[0] + word_box[2]) / 2, (word_box[1] + word_box[3]) / 2
    return any(r[0] - margin <= cx <= r[2] + margin and r[1] - margin <= cy <= r[3] + margin for r in regions)


def iou(a, b) -> float:
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union else 0.0


def overlap_small(a, b) -> float:
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    small = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return ix * iy / small if small else 0.0


def norm(t: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (t or "").upper())


def main() -> int:
    pdf, a_dir, b_dir, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
    names = sys.argv[sys.argv.index("--names") + 1:sys.argv.index("--names") + 3] if "--names" in sys.argv else ["A", "B"]
    A = json.loads((a_dir / "result.json").read_text(encoding="utf-8"))
    B = json.loads((b_dir / "result.json").read_text(encoding="utf-8"))
    sizes = [(p["w"], p["h"]) for p in A["pages"]]
    ref = pdf_words(pdf, sizes)
    rows = []
    for pa, pb, words in zip(A["pages"], B["pages"], ref):
        ra = [t["bbox"] for t in pa["texts"]]
        rb = [t["bbox"] for t in pb["texts"]]
        row = {"pag": pa["n"], "ref_palabras": len(words)}
        for name, p, regs in ((names[0], pa, ra), (names[1], pb, rb)):
            t = p["timings"]
            row[name] = {
                "regiones": p["regions"], "lineas": p["lines"], "con_globo": p["with_bubble"], "ocr_vacio": p["ocr_empty"],
                "revision": p["review"], "tipos": p["kinds"],
                "cubre_ref": sum(1 for _w, bx in words if inside(bx, regs)),
                "t_deteccion": t.get("deteccion"), "t_ocr": t.get("ocr"), "t_globos": t.get("globos"), "t_vinetas": t.get("vinetas_orden"),
                "t_analisis": t.get("analisis_total"), "t_reconstruccion": t.get("reconstruccion"), "t_traduccion": t.get("traduccion"),
                "status": p["status"],
            }
        # Emparejamiento de regiones entre detectores (solape del menor ≥ 50 %): coincidentes, solo en A, solo en B.
        used, pairs = set(), []
        for i, x in enumerate(ra):
            best, bj = 0.0, -1
            for j, y in enumerate(rb):
                if j not in used and (v := overlap_small(x, y)) > best:
                    best, bj = v, j
            if best >= 0.5:
                used.add(bj)
                pairs.append((i, bj))
        sims = [difflib.SequenceMatcher(None, norm(pa["texts"][i]["src"]), norm(pb["texts"][j]["src"])).ratio() for i, j in pairs]
        row["emparejadas"] = len(pairs)
        row[f"solo_{names[0]}"] = [pa["texts"][i]["src"] for i in range(len(ra)) if i not in {p[0] for p in pairs}]
        row[f"solo_{names[1]}"] = [pb["texts"][j]["src"] for j in range(len(rb)) if j not in used]
        row["similitud_ocr_media"] = round(st.mean(sims), 3) if sims else None
        rows.append(row)

    def total(name, key):
        return round(sum((r[name][key] or 0) for r in rows), 2)

    def stats(name, key):
        v = [r[name][key] for r in rows if r[name][key] is not None]
        return {"media": round(st.mean(v), 3), "mediana": round(st.median(v), 3), "max": round(max(v), 3), "min": round(min(v), 3)} if v else {}

    ref_total = sum(r["ref_palabras"] for r in rows)
    summary = {"paginas": len(rows), "ref_palabras_total": ref_total}
    for name, res in ((names[0], A), (names[1], B)):
        summary[name] = {
            "regiones": total(name, "regiones"), "lineas": total(name, "lineas"), "con_globo": total(name, "con_globo"),
            "ocr_vacio": total(name, "ocr_vacio"), "revision": total(name, "revision"),
            "cobertura_ref": round(total(name, "cubre_ref") / ref_total, 4) if ref_total else None,
            "deteccion_s": stats(name, "t_deteccion"), "ocr_s": stats(name, "t_ocr"), "globos_s": stats(name, "t_globos"),
            "analisis_s": stats(name, "t_analisis"), "reconstruccion_s": stats(name, "t_reconstruccion"),
            "traduccion_s": stats(name, "t_traduccion"),
            "import_s": res.get("import_s"), "proceso_s": res.get("process_s"), "recursos": res.get("resources"),
            "paginas_ok": sum(1 for p in res["pages"] if p["status"] in ("cleaned", "translated", "analyzed")),
            "paginas_error": [p["n"] for p in res["pages"] if p["status"] == "error"],
        }
    summary["emparejadas"] = sum(r["emparejadas"] for r in rows)
    summary[f"solo_{names[0]}"] = sum(len(r[f"solo_{names[0]}"]) for r in rows)
    summary[f"solo_{names[1]}"] = sum(len(r[f"solo_{names[1]}"]) for r in rows)
    sims = [r["similitud_ocr_media"] for r in rows if r["similitud_ocr_media"] is not None]
    summary["similitud_ocr_media"] = round(st.mean(sims), 3) if sims else None
    out.write_text(json.dumps({"resumen": summary, "paginas": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
