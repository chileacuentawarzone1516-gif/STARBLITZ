"""Genera los resultados de referencia de la visión (Python) para las pruebas de paridad del motor de Android.

Ejecuta el motor de escritorio sobre una página real y guarda detecciones, viñetas, orden de lectura, globos,
OCR y el resultado del borrado. El motor TypeScript del móvil se compara con estos archivos en Chromium
(`apps/mobile/test/engine/run_parity.py`).

Uso:  python tools/golden_vision.py <pagina.jpg> <detector.onnx> <carpeta_salida>
"""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from starblitz_engine.pipeline.processor import Processor, _split_lines, separate_layouts  # noqa: E402
from starblitz_engine.render.inpaint import EraseTarget, Inpainter  # noqa: E402
from starblitz_engine.vision.bubbles import find_bubble, text_ring_stats  # noqa: E402
from starblitz_engine.vision.detector import TextDetector  # noqa: E402
from starblitz_engine.vision.langid import guess_from_blocks, guess_from_text  # noqa: E402
from starblitz_engine.vision.layout import detect_panels, reading_order  # noqa: E402
from starblitz_engine.vision.ocr.ppocr import PaddleOCREngine  # noqa: E402


class NoModels:
    """Sin LaMa: la referencia usa el relleno exacto y, si hace falta, Telea."""

    def is_installed(self, _id: str) -> bool:
        return False


def variants(page: Path, out: Path) -> dict[str, Path]:
    img = cv2.imread(str(page))
    h, w = img.shape[:2]
    left, right = img[:, : w // 2], img[:, w // 2:]
    paths = {"full": out / "full.png", "strip": out / "strip.png"}
    cv2.imwrite(str(paths["full"]), img)
    cv2.imwrite(str(paths["strip"]), np.vstack([left, right]))  # tira vertical 2,8:1 → se analiza por tramos
    return paths


def run(name: str, path: Path, det: TextDetector, ocr: PaddleOCREngine, inpaint: Inpainter, out: Path) -> dict:
    img = cv2.imread(str(path))
    blocks, mask = det.detect(img)
    panels = detect_panels(img)
    order = reading_order([b.bbox for b in blocks], panels, "rtl")
    cv2.imwrite(str(out / f"{name}.mask.png"), mask)
    entries = []
    targets = []
    texts = []
    for b in blocks:
        bubble = find_bubble(img, mask, b)
        median, spread = text_ring_stats(img, mask, b.bbox)
        res = ocr.recognize(img, b)
        texts.append(res.text)
        entries.append({
            "bbox": list(map(int, b.bbox)), "lines": [p.astype(int).tolist() for p in b.lines], "vertical": bool(b.vertical),
            "confidence": float(b.confidence), "lang_hint": b.lang_hint, "line_size": float(b.line_size),
            "bubble": None if bubble is None else {"polygon": bubble.polygon, "bbox": list(map(int, bubble.bbox)),
                                                   "fill": list(bubble.fill), "uniform": bool(bubble.uniform)},
            "ring": {"median": [float(v) for v in median], "spread": float(spread)},
            "ocr": {"text": res.text, "confidence": float(res.confidence), "engine": res.engine},
        })
        targets.append(EraseTarget(bbox=tuple(map(int, b.bbox)), lines=[np.asarray(p, np.int32) for p in b.lines],
                                   line_size=b.line_size or 16.0, bubble_polygon=bubble.polygon if bubble else None,
                                   fill=tuple(bubble.fill) if bubble else None, uniform=bool(bubble and bubble.uniform)))
    clean = inpaint.erase(img, mask, targets)
    cv2.imwrite(str(out / f"{name}.clean.png"), clean)
    guess, conf = guess_from_blocks(blocks)
    median_line = float(np.median([b.line_size for b in blocks])) if blocks else 0.0
    page = SimpleNamespace(height=int(img.shape[0]))

    centers = [((b.bbox[0] + b.bbox[2]) / 2, (b.bbox[1] + b.bbox[3]) / 2) for b in blocks]

    def regions(sfx: str) -> list[dict]:
        # Las regiones que construye el procesador a partir de lo detectado y leído (sin id ni fecha, que varían), igual que
        # `analyze_page`: búsqueda ampliada exclusiva (centros de los demás textos) y separación de cajas solapadas.
        built = []
        for rank, bi in enumerate(order):
            ocr_res = entries[bi]["ocr"]
            if not ocr_res["text"].strip():
                continue
            built.append(Processor._make_region(None, SimpleNamespace(sfx=sfx), page, img, mask, blocks[bi], ocr_res["text"],
                                                ocr_res["confidence"], ocr_res["engine"], rank, median_line,
                                                others=[c for k, c in enumerate(centers) if k != bi]))
        separate_layouts(built, page.height)
        out_regions = []
        for r in built:
            d = r.model_dump(mode="json")
            d.pop("id"), d.pop("updated")
            out_regions.append(d)
        return out_regions

    h, w = img.shape[:2]
    blank = np.zeros(img.shape[:2], np.uint8)
    split_cases = [(list(map(int, b.bbox)), bool(b.vertical)) for b in blocks[:6]]
    split_cases += [([int(w * 0.1), int(h * 0.1), int(w * 0.5), int(h * 0.3)], False), ([int(w * 0.55), int(h * 0.1), int(w * 0.75), int(h * 0.6)], True)]
    splits = [{"bbox": bb, "vertical": v, "mask": [p.tolist() for p in _split_lines(img, mask, bb, v)],
               "no_mask": [p.tolist() for p in _split_lines(img, blank, bb, v)]} for bb, v in split_cases]
    return {"image": path.name, "width": int(img.shape[1]), "height": int(img.shape[0]), "blocks": entries,
            "panels": [list(map(int, p)) for p in panels], "order": [int(i) for i in order],
            "mask_pixels": int((mask > 0).sum()), "lang_blocks": [guess, float(conf)],
            "lang_text": guess_from_text(texts[:4]), "median_line": median_line, "regions": regions("keep"),
            "regions_note": regions("note"), "splits": splits}


def main() -> None:
    page, detector, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    paths = variants(page, out)
    det = TextDetector(detector, "cpu")
    ocr = PaddleOCREngine("ja", "cpu")
    inpaint = Inpainter(NoModels(), "cpu", "fast")
    result = {name: run(name, p, det, ocr, inpaint, out) for name, p in paths.items()}
    (out / "golden.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    for name, r in result.items():
        print(name, r["width"], r["height"], "bloques:", len(r["blocks"]), "viñetas:", len(r["panels"]),
              "con globo:", sum(1 for b in r["blocks"] if b["bubble"]), "textos:", [b["ocr"]["text"][:12] for b in r["blocks"]][:6])


if __name__ == "__main__":
    main()
