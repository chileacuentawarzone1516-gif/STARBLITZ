#!/usr/bin/env python3
"""Paridad del detector EXPERIMENTAL entre el motor de escritorio (Python) y el móvil (TypeScript en Chromium).

Para cada página de la carpeta ejecuta `MangaLineDetector` (Python, ONNX Runtime CPU) y lo compara con la salida guardada por
`manga_det_parity.mjs`: nº de líneas y de bloques, emparejamiento de líneas por IoU de su rectángulo y coincidencia de la máscara.

Uso: PYTHONPATH=engine python tools/bench/manga_det_compare.py <carpeta_paginas> <salida_ts> <manga_det.onnx> <informe.json>
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from starblitz_engine.vision.manga_det import MangaLineDetector


def bbox(poly) -> tuple[float, float, float, float]:
    a = np.asarray(poly, np.float32)
    return float(a[:, 0].min()), float(a[:, 1].min()), float(a[:, 0].max()), float(a[:, 1].max())


def iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def match(py: list, ts: list, thr: float = 0.5) -> int:
    """Emparejamiento voraz por IoU (cada línea se usa una vez)."""
    used: set[int] = set()
    n = 0
    for a in py:
        best, bi = 0.0, -1
        for j, b in enumerate(ts):
            if j in used:
                continue
            v = iou(a, b)
            if v > best:
                best, bi = v, j
        if best >= thr:
            used.add(bi)
            n += 1
    return n


def main() -> int:
    pages, ts_dir, model, out = (Path(a) for a in sys.argv[1:5])
    det = MangaLineDetector(model, "cpu")
    rows = []
    for f in sorted(p for p in pages.iterdir() if p.suffix.lower() in (".png", ".jpg", ".jpeg")):
        ts_json = ts_dir / (f.stem + ".json")
        if not ts_json.is_file():
            continue
        ts = json.loads(ts_json.read_text(encoding="utf-8"))
        img = cv2.imread(str(f))
        det.detect(img) if not rows else None  # calentamiento solo en la primera página
        t = time.perf_counter()
        blocks, mask = det.detect(img)
        ms = (time.perf_counter() - t) * 1000
        py_lines = [bbox(p) for b in blocks for p in b.lines]
        ts_lines = [bbox(p) for b in ts["blocks"] for p in b["lines"]]
        m = match(py_lines, ts_lines)
        ts_mask = cv2.imread(str(ts_dir / (f.stem + ".mask.png")), cv2.IMREAD_GRAYSCALE)
        inter = int(((mask > 0) & (ts_mask > 0)).sum())
        union = int(((mask > 0) | (ts_mask > 0)).sum())
        rows.append({"page": f.name, "py_lines": len(py_lines), "ts_lines": len(ts_lines), "matched_iou50": m,
                     "py_blocks": len(blocks), "ts_blocks": len(ts["blocks"]), "mask_iou": round(inter / union, 4) if union else 1.0,
                     "py_ms": round(ms), "ts_ms": ts["ms"], "ts_infer_ms": ts["infer_ms"]})
        print(json.dumps(rows[-1]))
    tot = {k: sum(r[k] for r in rows) for k in ("py_lines", "ts_lines", "matched_iou50", "py_blocks", "ts_blocks")}
    tot["mask_iou_media"] = round(float(np.mean([r["mask_iou"] for r in rows])), 4) if rows else None
    tot["pages"] = len(rows)
    out.write_text(json.dumps({"total": tot, "pages": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(tot))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
