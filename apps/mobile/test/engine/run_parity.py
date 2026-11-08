"""Paridad del motor TypeScript del móvil frente al motor de escritorio (Python), en Chromium.

Compara, sobre una página real y sobre una tira vertical (que se analiza por tramos): detección de bloques y líneas,
máscara de texto, viñetas, orden de lectura, globos, OCR y borrado del texto.

Uso:  python run_parity.py <golden_dir> <dist_test_dir> <detector.onnx> <ppocr_rec.onnx> [--only full|strip]
"""
import base64
import http.server
import io
import json
import socketserver
import sys
import threading
from pathlib import Path

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

GOLDEN, DIST, DETECTOR, OCR = (Path(a) for a in sys.argv[1:5])
ONLY = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
ISOLATED = "--isolated" in sys.argv


class Handler(http.server.SimpleHTTPRequestHandler):
    files = {"/data/detector.onnx": DETECTOR, "/data/ppocr.onnx": OCR}

    def translate_path(self, path):
        path = path.split("?")[0]
        if path in self.files:
            return str(self.files[path])
        if path.startswith("/golden/"):
            return str(GOLDEN / path[len("/golden/"):])
        return str(DIST / path.lstrip("/"))

    def end_headers(self):
        # Como en el WebView de Android (sin aislamiento entre orígenes): WebAssembly de un solo hilo.
        if ISOLATED:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def log_message(self, *a):
        pass


Handler.extensions_map = {**Handler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript"}


def decode(data_url: str) -> np.ndarray:
    return np.array(Image.open(io.BytesIO(base64.b64decode(data_url.split(",", 1)[1]))))


def iou(a, b) -> float:
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union else 0.0


def similar(a: str, b: str) -> float:
    """Proporción de coincidencia entre dos textos (distancia de edición normalizada)."""
    if a == b:
        return 1.0
    n, m = len(a), len(b)
    if not n or not m:
        return 0.0
    d = list(range(m + 1))
    for i in range(1, n + 1):
        prev, d[0] = d[0], i
        for j in range(1, m + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
            prev, d[j] = d[j], cur
    return 1 - d[m] / max(n, m)


def compare(name: str, gold: dict, got: dict, clean_ref: np.ndarray, mask_ref: np.ndarray, original: np.ndarray) -> list[str]:
    problems: list[str] = []

    def check(cond: bool, msg: str) -> None:
        print(("  ok   " if cond else "  FALLA"), msg)
        if not cond:
            problems.append(f"{name}: {msg}")

    check((got["width"], got["height"]) == (gold["width"], gold["height"]), f"tamaño {got['width']}x{got['height']}")
    gb, tb = gold["blocks"], got["blocks"]
    check(len(gb) == len(tb), f"nº de bloques TS={len(tb)} Python={len(gb)}")
    # Emparejado por solape (los bloques no tienen identificador).
    pairs = []
    used = set()
    for i, g in enumerate(gb):
        best = max(((iou(g["bbox"], t["bbox"]), j) for j, t in enumerate(tb) if j not in used), default=(0, -1))
        if best[0] > 0.8:
            pairs.append((i, best[1]))
            used.add(best[1])
    check(len(pairs) == len(gb), f"bloques emparejados {len(pairs)}/{len(gb)}")
    mism_v = sum(1 for i, j in pairs if gb[i]["vertical"] != tb[j]["vertical"])
    check(mism_v == 0, f"orientación igual en todos ({mism_v} distintos)")
    lines_ok = sum(1 for i, j in pairs if len(gb[i]["lines"]) == len(tb[j]["lines"]))
    check(lines_ok >= 0.9 * max(1, len(pairs)), f"mismo nº de líneas en {lines_ok}/{len(pairs)} bloques")
    bb = max((max(abs(a - b) for a, b in zip(gb[i]["bbox"], tb[j]["bbox"])) for i, j in pairs), default=0)
    check(bb <= 3, f"diferencia máxima de cuadro ≤3 px (real {bb})")

    # Máscara
    mine = decode(got["mask_png"])
    if mine.ndim == 3:
        mine = mine[..., 0]
    agree = float((mine == mask_ref).mean())
    check(agree >= 0.995, f"máscara de texto coincide en {agree * 100:.3f} % ({int((mine != mask_ref).sum())} píxeles distintos)")

    check(gold["panels"] == got["panels"], f"viñetas {len(got['panels'])} (Python {len(gold['panels'])})")
    # El orden se compara en términos de cuadros, no de índices (los índices dependen del orden de detección).
    go = [gb[i]["bbox"] for i in gold["order"]]
    to = [tb[i]["bbox"] for i in got["order"]]
    same_order = len(go) == len(to) and all(iou(a, b) > 0.8 for a, b in zip(go, to))
    check(same_order, "orden de lectura idéntico")

    # Globos
    bub_ok = bub_total = 0
    for i, j in pairs:
        g, t = gb[i]["bubble"], tb[j]["bubble"]
        bub_total += 1
        if g is None or t is None:
            bub_ok += g is None and t is None
        else:
            bub_ok += (max(abs(a - b) for a, b in zip(g["bbox"], t["bbox"])) <= 3 and g["uniform"] == t["uniform"]
                       and max(abs(a - b) for a, b in zip(g["fill"], t["fill"])) <= 1)
    check(bub_ok == bub_total, f"globos iguales en {bub_ok}/{bub_total}")
    shown = 0
    for i, j in pairs:
        g, t = gb[i]["bubble"], tb[j]["bubble"]
        if shown < 3 and (g is None) != (t is None or False) or (g and t and (g["bbox"] != t["bbox"] or g["uniform"] != t["uniform"] or g["fill"] != t["fill"])):
            shown += 1
            print("      bloque", gb[i]["bbox"], "\n        Python:", None if g is None else {k: g[k] for k in ("bbox", "uniform", "fill")} | ({"npoly": len(g["polygon"])}),
                  "\n        TS    :", None if t is None else {k: t[k] for k in ("bbox", "uniform", "fill")} | ({"npoly": len(t["polygon"])}))
    # La dispersión depende de unos pocos píxeles de máscara que el detector decide distinto por redondeo en coma
    # flotante (WebAssembly frente a ONNX Runtime nativo): se exige la misma clasificación y una diferencia pequeña.
    def ring_equal(a, b) -> bool:
        return (max(abs(x - y) for x, y in zip(a["median"], b["median"])) <= 0.5 and abs(a["spread"] - b["spread"]) < 4.0
                and (a["spread"] < 12) == (b["spread"] < 12))
    ring_ok = sum(1 for i, j in pairs if ring_equal(gb[i]["ring"], tb[j]["ring"]))
    check(ring_ok == len(pairs), f"color de fondo del texto igual en {ring_ok}/{len(pairs)}")
    for i, j in pairs:
        a, b = gb[i]["ring"], tb[j]["ring"]
        if not ring_equal(a, b):
            print("      anillo", gb[i]["bbox"], "Python:", a, "| TS:", b)

    # OCR
    exact = sum(1 for i, j in pairs if gb[i]["ocr"]["text"] == tb[j]["ocr"]["text"])
    sim = np.mean([similar(gb[i]["ocr"]["text"], tb[j]["ocr"]["text"]) for i, j in pairs]) if pairs else 0
    check(exact >= 0.85 * len(pairs), f"texto OCR idéntico en {exact}/{len(pairs)} (similitud media {sim * 100:.1f} %)")
    for i, j in pairs:
        if gb[i]["ocr"]["text"] != tb[j]["ocr"]["text"]:
            print(f"      Python: {gb[i]['ocr']['text']!r}\n      TS    : {tb[j]['ocr']['text']!r}")
    check(gold["lang_blocks"][0] == got["lang_blocks"][0] and gold["lang_text"] == got["lang_text"],
          f"idioma detectado {got['lang_blocks'][0]}/{got['lang_text']}")

    # Borrado: igual fuera de la máscara y parecido dentro
    clean = decode(got["clean_png"])[..., :3]
    ref = clean_ref[..., :3]
    changed_ts = np.any(clean != original, axis=2)
    changed_py = np.any(ref != original, axis=2)
    overlap = float((changed_ts & changed_py).sum() / max(1, (changed_ts | changed_py).sum()))
    check(overlap >= 0.9, f"píxeles borrados coinciden en {overlap * 100:.1f} % (IoU)")
    diff = np.abs(clean.astype(int) - ref.astype(int)).mean()
    check(diff < 3.0, f"diferencia media de la página limpia {diff:.2f} (de 255)")
    print("  tiempos (ms):", got["timings"])
    return problems


def compare_service(name: str, gold: dict, got: dict, clean_ref: np.ndarray, original: np.ndarray) -> list[str]:
    """La fachada de visión de la app (regiones, borrado, relectura, idioma, anotación y líneas dibujadas a mano)."""
    problems: list[str] = []

    def check(cond: bool, msg: str) -> None:
        print(("  ok   " if cond else "  FALLA"), msg)
        if not cond:
            problems.append(f"{name}/servicio: {msg}")

    gr, tr = gold["regions"], got["regions"]
    check(len(gr) == len(tr), f"nº de regiones TS={len(tr)} Python={len(gr)}")
    pairs = []
    used = set()
    for i, g in enumerate(gr):
        best = max(((iou(g["bbox"], t["bbox"]), j) for j, t in enumerate(tr) if j not in used), default=(0, -1))
        if best[0] > 0.8:
            pairs.append((i, best[1]))
            used.add(best[1])
    check(len(pairs) == len(gr), f"regiones emparejadas {len(pairs)}/{len(gr)}")
    check(all(gr[i]["order"] == tr[j]["order"] for i, j in pairs), "mismo orden de lectura en todas")
    check(all(gr[i]["kind"] == tr[j]["kind"] for i, j in pairs), f"mismo tipo en todas ({[ (gr[i]['kind'], tr[j]['kind']) for i, j in pairs if gr[i]['kind'] != tr[j]['kind']]})")
    check(all(gr[i]["vertical"] == tr[j]["vertical"] and gr[i]["erase"] == tr[j]["erase"] and gr[i]["render"] == tr[j]["render"] for i, j in pairs),
          "orientación, borrado y rotulado iguales")
    lb = max((max(abs(a - b) for a, b in zip(gr[i]["layout_box"], tr[j]["layout_box"])) for i, j in pairs), default=0)
    check(lb <= 4, f"zona de maquetación: diferencia máxima {lb} px (≤4)")
    for i, j in pairs:
        if max(abs(a - b) for a, b in zip(gr[i]["layout_box"], tr[j]["layout_box"])) > 4:
            print("      layout Python:", gr[i]["layout_box"], "TS:", tr[j]["layout_box"], "kind", gr[i]["kind"], "bubble", gr[i]["bubble"] is not None)
    mc = max((abs(gr[i]["max_chars"] - tr[j]["max_chars"]) for i, j in pairs), default=0)
    check(mc <= max(2, 0.1 * max((g["max_chars"] for g in gr), default=0)), f"caracteres máximos: diferencia máxima {mc}")
    ls = max((abs(gr[i]["line_size"] - tr[j]["line_size"]) for i, j in pairs), default=0)
    check(ls <= 1.0, f"tamaño de letra: diferencia máxima {ls:.1f}")
    same_style = all({k: gr[i]["style"][k] for k in ("font", "color", "stroke_color", "uppercase", "bold", "italic", "align", "line_height")}
                     == {k: tr[j]["style"][k] for k in ("font", "color", "stroke_color", "uppercase", "bold", "italic", "align", "line_height")}
                     and abs(gr[i]["style"]["stroke_width"] - tr[j]["style"]["stroke_width"]) <= 0.5 for i, j in pairs)
    check(same_style, "estilo inicial igual (fuente, color, contorno)")
    check(all((gr[i]["bubble"] is None) == (tr[j]["bubble"] is None) for i, j in pairs), "globo detectado en las mismas regiones")
    check(all(tr[j]["status"] == "pending" and tr[j]["translation"] == "" and tr[j]["flags"] == [] for _, j in pairs), "regiones nuevas sin traducir")
    check(got["ocr_engine"] == "ppocr-ja" or "ppocr" in got["ocr_engine"], f"motor de OCR {got['ocr_engine']}")

    # Borrado a partir de las regiones guardadas (lo que hace la app) frente al borrado de referencia
    clean = decode(got["clean_png"])[..., :3]
    ref = clean_ref[..., :3]
    changed_ts = np.any(clean != original, axis=2)
    changed_py = np.any(ref != original, axis=2)
    overlap = float((changed_ts & changed_py).sum() / max(1, (changed_ts | changed_py).sum()))
    check(overlap >= 0.9, f"página limpia: píxeles borrados coinciden en {overlap * 100:.1f} %")
    check(np.abs(clean.astype(int) - ref.astype(int)).mean() < 3.0, "página limpia: diferencia media < 3")

    check(got["lang"] == "ja", f"idioma detectado por la fachada: {got['lang']}")
    rr = got["reread"]
    check(rr is not None and rr["id_kept"] and bool(rr["text"].strip()), f"relectura de un área conserva el identificador y lee texto: {rr and rr['text'][:12]!r}")
    a = got["annotated"]
    check(a["head"] == [255, 216] and max(a["width"], a["height"]) <= 4096 and a["bytes"] > 2000, f"imagen anotada JPEG {a['width']}x{a['height']} ({a['bytes']} bytes)")

    sp_ok = sp_total = 0
    for gs, ts in zip(gold["splits"], got["splits"]):
        for key in ("mask", "no_mask"):
            sp_total += 1
            ok = gs[key] == ts[key]
            sp_ok += ok
            if not ok:
                print(f"      líneas ({key}) bbox={gs['bbox']} vertical={gs['vertical']}\n        Python: {gs[key]}\n        TS    : {ts[key]}")
    check(sp_ok == sp_total, f"separación de líneas de texto dibujado a mano idéntica en {sp_ok}/{sp_total} casos")
    print("  análisis completo (ms):", got["t_analyze"])
    return problems


def check_importers(got: dict) -> list[str]:
    """Importador con los códecs reales del navegador (formatos, EXIF, bombas, dañados, duplicados, ZIP y PDF)."""
    problems: list[str] = []

    def check(cond: bool, msg: str) -> None:
        print(("  ok   " if cond else "  FALLA"), msg)
        if not cond:
            problems.append(f"importador: {msg}")

    j, p, w = got["jpg"], got["png"], got["webp"]
    check((j["ext"], j["width"], j["height"], j["same"]) == ("jpg", 200, 100, True), f"JPEG sin giro: conserva los bytes originales ({j['width']}x{j['height']})")
    check((p["ext"], p["width"], p["height"]) == ("png", 120, 80), "PNG leído")
    check((w["ext"], w["width"], w["height"]) == ("webp", 90, 60), "WebP leído")
    e = got["exif"]
    check((e["ext"], e["width"], e["height"], e["decoded"]) == ("png", 100, 200, [100, 200]), f"JPEG con orientación EXIF 6 → PNG girado {e['width']}x{e['height']} (decodificado {e['decoded']})")
    check(got["exif1"]["ext"] == "jpg" and got["exif1"]["same"], "JPEG con orientación normal no se recodifica")
    check(got["bomb"] == "la imagen es demasiado grande", f"bomba de píxeles rechazada sin decodificar: {got['bomb']}")
    check(got["corrupt"] == "la imagen está dañada o incompleta", f"imagen dañada: {got['corrupt']}")
    check(got["truncatedHeader"] == "la imagen está dañada o incompleta", f"cabecera truncada: {got['truncatedHeader']}")
    h = got["hash"]
    check(h["jpgVsPng"] <= 3 and h["jpgVsBigWebp"] <= 3 and h["different"] > 3, f"huella perceptual: mismo contenido {h['jpgVsPng']}/{h['jpgVsBigWebp']} bits, distinto {h['different']} bits")
    pdf = got["pdf"]
    check(pdf["numPages"] == 3 and pdf["pages"] == [[2120, 3000], [2120, 3000], [1750, 2479]], f"PDF de 3 páginas renderizado a 300 ppp con tope de 3000 px: {pdf['pages']}")
    check(got["pdfBroken"] == "falla", "PDF dañado lanza error")
    ing = got["ingest"]
    names = [a["name"] for a in ing["added"]]
    check(names == ["doc.pdf · página 1", "doc.pdf · página 2", "doc.pdf · página 3", "repetida.png", "p1.webp", "p10.jpg", "rot.jpg"], f"orden de importación {names}")
    rot = next(a for a in ing["added"] if a["name"] == "rot.jpg")
    check((rot["ext"], rot["width"], rot["height"]) == ("png", 100, 200), "imagen girada dentro del CBZ")
    rep = ing["report"]
    check({"file": "c/p2.png", "of": "g4", "exact": True} in rep["duplicates"], f"duplicado exacto detectado entre archivos: {rep['duplicates']}")
    check(not rep["errors"], f"sin errores: {rep['errors']}")
    return problems


def main() -> int:
    gold = json.loads((GOLDEN / "golden.json").read_text(encoding="utf-8"))
    problems: list[str] = []
    with socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler) as srv:
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: m.type == "error" and errors.append(m.text))
            page.goto(f"{base}/index.html")
            page.wait_for_function("window.SBT !== undefined", timeout=30000)
            info = page.evaluate("opts => window.SBT.init(opts)", {"detectorUrl": f"{base}/data/detector.onnx", "ocrUrl": f"{base}/data/ppocr.onnx"})
            print("motor listo en", round(info["ms"]), "ms; aislado (hilos):", info["isolated"])
            print("== importador")
            problems += check_importers(page.evaluate("() => window.SBT.importers()"))
            for name in ("full", "strip"):
                if ONLY and ONLY != name:
                    continue
                print(f"== {name}")
                got = page.evaluate("u => window.SBT.analyze(u)", f"{base}/golden/{name}.png")
                g = gold[name]
                clean_ref = np.array(Image.open(GOLDEN / f"{name}.clean.png").convert("RGB"))
                mask_ref = np.array(Image.open(GOLDEN / f"{name}.mask.png").convert("L"))
                original = np.array(Image.open(GOLDEN / f"{name}.png").convert("RGB"))
                problems += compare(name, g, got, clean_ref, mask_ref, original)
                print(f"== {name} (fachada de visión de la app)")
                svc = page.evaluate("a => window.SBT.service(a.img, a.mask, a.cases)", {
                    "img": f"{base}/golden/{name}.png", "mask": f"{base}/golden/{name}.mask.png",
                    "cases": [{"bbox": s["bbox"], "vertical": s["vertical"]} for s in g["splits"]]})
                problems += compare_service(name, g, svc, clean_ref, original)
            real = [e for e in errors if "favicon" not in e]
            if real:
                problems += [f"consola: {e}" for e in real]
            browser.close()
    print("\nRESULTADO:", "TODO CORRECTO" if not problems else f"{len(problems)} problemas")
    for pr in problems:
        print(" -", pr)
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
