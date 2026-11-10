#!/usr/bin/env python3
"""Tiempo de detección A/B INTERCALADO: para cada página se ejecutan los dos detectores uno tras otro (y en orden alterno),
varias veces, para que los cambios de velocidad del equipo (temperatura, energía) afecten por igual a ambos.

Uso: PYTHONPATH=engine python tools/bench/detector_ab.py <carpeta_paginas> <comictextdetector.onnx> <manga_det.onnx> <salida.json> [--reps 3]
"""
from __future__ import annotations

import json
import statistics as st
import sys
import time
from pathlib import Path

import cv2

from starblitz_engine.vision.detector import TextDetector
from starblitz_engine.vision.manga_det import MangaLineDetector


def main() -> int:
    pages, ctd, mdet, out = (Path(a) for a in sys.argv[1:5])
    reps = int(sys.argv[sys.argv.index("--reps") + 1]) if "--reps" in sys.argv else 3
    dets = {"defecto": TextDetector(ctd, "cpu"), "manga": MangaLineDetector(mdet, "cpu")}
    files = sorted(p for p in pages.iterdir() if p.suffix.lower() in (".png", ".jpg"))
    warm = cv2.imread(str(files[0]))
    for d in dets.values():
        d.detect(warm)
    rows = []
    for k, f in enumerate(files):
        img = cv2.imread(str(f))
        t = {n: [] for n in dets}
        for r in range(reps):
            order = list(dets) if (k + r) % 2 == 0 else list(reversed(list(dets)))
            for n in order:
                s = time.perf_counter()
                dets[n].detect(img)
                t[n].append(time.perf_counter() - s)
        row = {"pagina": f.name, **{n: round(min(v), 3) for n, v in t.items()}}
        row["ratio"] = round(row["defecto"] / row["manga"], 2)
        rows.append(row)
        print(json.dumps(row), flush=True)
    summ = {n: {"mediana_s": round(st.median(r[n] for r in rows), 3), "total_s": round(sum(r[n] for r in rows), 2)} for n in dets}
    summ["ratio_mediano"] = round(st.median(r["ratio"] for r in rows), 2)
    summ["metodo"] = f"mínimo de {reps} repeticiones por página, orden alterno, CPU, ONNX Runtime con desnormalizados a cero"
    out.write_text(json.dumps({"resumen": summ, "paginas": rows}, indent=1), encoding="utf-8")
    print(json.dumps(summ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
