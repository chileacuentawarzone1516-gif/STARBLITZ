#!/usr/bin/env python3
"""Pruebas REALES de STARBLITZ (motor Python): sin servidor de lenguaje simulado y sin Hugging Face simulado.

Arranca el motor tal como lo hace la aplicación de escritorio y ejecuta, contra Internet y modelos de verdad:

  catalogo   El catálogo curado frente a Hugging Face real: ¿existe cada archivo y coincide su tamaño?
  vision     Descarga e instala detector de texto, Manga OCR y LaMa (integridad SHA-256 verificada por el motor).
  llm        Búsqueda en Hugging Face, descarga del modelo GGUF y arranque del llama-server real.
  traduccion Traducción japonés → español e inglés → español con el modelo real (frases con respuesta esperada).
  proyecto   Proyecto completo (OCR real, traducción contextual, reconstrucción) sobre páginas sintéticas
             dibujadas aquí (o sobre TU capítulo con --proyecto; nunca sale de tu equipo).

Es solo biblioteca estándar (más Pillow, que ya incluye el motor) y funciona igual en Windows, Linux y CI.
Escribe `informe.md` y `resultados.json` en la carpeta de salida. Código de salida 0 = todas las comprobaciones
duras pasan (la calidad de traducción se informa con puntuaciones, no como aprobado/suspenso).

Ejemplos:
  python tools/probar_real.py --out informe-real --todo
  python tools/probar_real.py --out informe-real --traduccion --llm-repo unsloth/Qwen3.5-2B-GGUF --llm-file Qwen3.5-2B-Q4_K_M.gguf
  python tools/probar_real.py --out informe-real --proyecto --proyecto-origen C:\\mangas\\capitulo1.zip --idioma ja
"""
from __future__ import annotations

import argparse
import difflib
import io
import json
import os
import platform
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CJK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]")
# Palabras españolas que NO son también inglesas: sirven para distinguir una traducción de un eco del original.
ES_WORDS = {"el", "la", "los", "las", "de", "que", "y", "en", "un", "una", "es", "te", "se", "por", "con", "para", "mi", "tu", "al",
            "del", "como", "pero", "ya", "muy", "qué", "estoy", "eres", "gracias", "está", "esto", "esta", "eso", "son", "sin", "más",
            "tú", "yo", "nos", "les", "su", "sus", "porque", "cuando", "donde", "dónde", "hoy", "aquí", "ahora", "vamos", "voy", "soy"}

# Frases con respuesta esperada: cada grupo es una expresión regular y puntúa si aparece en la traducción.
SAMPLES = {
    "ja": [
        ("おはよう！今日はいい天気ですね。", [r"buen(os)? d[ií]as?|hola", r"d[ií]a|clima|tiempo|hace"]),
        ("先輩、待ってください！もう少しで着きます。", [r"espe", r"llego|llegando|casi|falta|enseguida|ya mismo|un poco m[aá]s"]),
        ("本当に行くのか？もう戻れないぞ。", [r"de verdad|en serio|realmente|seguro|veras", r"volver|regresar|vuelta|retroceder|atr[aá]s"]),
        ("ありがとう、みんなのおかげだよ。", [r"gracias", r"todos|ustedes|gracias a"]),
        ("どうして黙っているの？", [r"por qu[eé]", r"call|silenci|habl|dic|nada"]),
    ],
    "en": [
        ("I'm not going to lose to you!", [r"\bno\b", r"perder|ganar|vencer|derrot"]),
        ("Thank you, everyone. I couldn't have done it without you.", [r"gracias", r"sin (ustedes|ti|todos|vosotros)"]),
        ("Wait for me! I'll be there in a minute.", [r"espe", r"minuto|momento|rato|llego|voy|enseguida"]),
        ("Why are you so quiet today?", [r"por qu[eé]", r"call|silenci|tranquil|callad"]),
        ("You've got some nerve, punk.", [r"descaro|valor|agallas|cara|atrev|osad|nervio"]),
    ],
}
# Texto dibujado en las páginas sintéticas (para medir el OCR) — cada globo, sus líneas.
PAGE_JA = [["おはよう！", "今日はいい天気ですね。"], ["先輩、待ってください！", "もう少しで着きます。"], ["本当に行くのか？", "もう戻れないぞ。"], ["大丈夫。", "私に任せて。"]]
PAGE_EN = [["WHAT DO YOU THINK", "YOU ARE DOING?"], ["I WILL NOT LOSE", "TO YOU AGAIN!"], ["WAIT FOR ME!", "I AM ALMOST THERE."]]


@dataclass
class Check:
    name: str
    status: str            # PASS | FAIL | WARN | SKIP | INFO
    detail: str = ""
    seconds: float = 0.0
    group: str = ""


@dataclass
class Report:
    out: Path
    checks: list[Check] = field(default_factory=list)
    tables: list[tuple[str, list[str], list[list[str]]]] = field(default_factory=list)
    started: float = field(default_factory=time.time)

    def add(self, group: str, name: str, status: str, detail: str = "", seconds: float = 0.0) -> Check:
        c = Check(name, status, detail, seconds, group)
        self.checks.append(c)
        mark = {"PASS": "OK   ", "FAIL": "FALLO", "WARN": "AVISO", "SKIP": "OMITE", "INFO": "INFO "}[status]
        print(f"[{time.strftime('%H:%M:%S')}] {mark} [{group}] {name} {('— ' + detail) if detail else ''}", flush=True)
        return c

    def table(self, title: str, header: list[str], rows: list[list[str]]) -> None:
        self.tables.append((title, header, rows))

    @property
    def failed(self) -> bool:
        return any(c.status == "FAIL" for c in self.checks)

    def write(self, env: dict) -> None:
        self.out.mkdir(parents=True, exist_ok=True)
        (self.out / "resultados.json").write_text(json.dumps({
            "entorno": env, "duracion_s": round(time.time() - self.started, 1),
            "comprobaciones": [c.__dict__ for c in self.checks],
            "tablas": [{"titulo": t, "columnas": h, "filas": r} for t, h, r in self.tables]}, ensure_ascii=False, indent=1), encoding="utf-8")
        lines = ["# STARBLITZ — informe de pruebas REALES", "",
                 "Sin modelo de lenguaje simulado ni Hugging Face simulado. Páginas: sintéticas salvo que se indique `--proyecto`.", "",
                 "## Entorno", ""] + [f"- **{k}**: {v}" for k, v in env.items()] + ["", "## Comprobaciones", "",
                 "| Estado | Grupo | Comprobación | Detalle | s |", "|---|---|---|---|---|"]
        for c in self.checks:
            lines.append(f"| {c.status} | {c.group} | {c.name} | {c.detail.replace('|', '/').replace(chr(10), ' ')[:300]} | {c.seconds:.1f} |")
        for title, header, rows in self.tables:
            lines += ["", f"## {title}", "", "| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
            lines += ["| " + " | ".join(str(x).replace("|", "/").replace("\n", " ") for x in r) + " |" for r in rows]
        n = {s: sum(1 for c in self.checks if c.status == s) for s in ("PASS", "FAIL", "WARN", "SKIP")}
        lines += ["", f"**Resumen:** {n['PASS']} correctas, {n['FAIL']} fallidas, {n['WARN']} avisos, {n['SKIP']} omitidas.", ""]
        (self.out / "informe.md").write_text("\n".join(lines), encoding="utf-8")


class ApiError(RuntimeError):
    pass


class Engine:
    """El motor como proceso hijo (igual que lo lanza Electron) y un cliente mínimo de su API."""

    def __init__(self, data_dir: Path, llama_server: str | None, log: Path):
        self.data_dir, self.llama_server, self.log = data_dir, llama_server, log
        self.token = secrets.token_urlsafe(24)
        self.proc: subprocess.Popen | None = None
        self.base = ""

    def __enter__(self) -> "Engine":
        env = {**os.environ, "STARBLITZ_TOKEN": self.token, "PYTHONUTF8": "1"}
        if self.llama_server:
            env["STARBLITZ_LLAMA_SERVER"] = self.llama_server
        self.data_dir.mkdir(parents=True, exist_ok=True)
        err = open(self.log, "w", encoding="utf-8")
        self.proc = subprocess.Popen([sys.executable, "-m", "starblitz_engine", "--port", "0", "--data-dir", str(self.data_dir)],
                                     stdout=subprocess.PIPE, stderr=err, text=True, env=env, cwd=os.environ.get("STARBLITZ_ENGINE_CWD") or (str(ROOT / "engine") if (ROOT / "engine" / "starblitz_engine").is_dir() else None))
        ready = threading.Event()

        def pump() -> None:
            for line in self.proc.stdout:  # type: ignore[union-attr]
                m = re.search(r"STARBLITZ_READY (\{.*\})", line)
                if m:
                    self.base = f"http://127.0.0.1:{json.loads(m.group(1))['port']}"
                    ready.set()
        threading.Thread(target=pump, daemon=True).start()
        if not ready.wait(120):
            raise ApiError("El motor no arrancó en 120 s (ver " + str(self.log) + ")")
        return self

    def __exit__(self, *exc) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(20)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def call(self, method: str, path: str, body=None, raw: bytes | None = None, ctype: str | None = None, timeout: float = 60):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        if ctype or body is not None:
            req.add_header("Content-Type", ctype or "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                payload = r.read()
                return json.loads(payload) if "json" in (r.headers.get("content-type") or "") else payload
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:400]
            raise ApiError(f"{method} {path} → HTTP {e.code}: {msg}") from None

    def upload(self, path: str, filename: str, content: bytes, ctype: str = "application/zip"):
        boundary = uuid.uuid4().hex
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n").encode() \
            + content + f"\r\n--{boundary}--\r\n".encode()
        return self.call("POST", path, raw=body, ctype=f"multipart/form-data; boundary={boundary}")

    def wait_job(self, job: dict, timeout_s: float, on_tick=None) -> dict:
        t0 = time.time()
        while time.time() - t0 < timeout_s:
            j = self.call("GET", f"/api/jobs/{job['id']}")
            if on_tick:
                on_tick(j)
            if j["status"] in ("done", "error", "cancelled"):
                return j
            time.sleep(2)
        raise ApiError(f"La tarea {job.get('title', job['id'])} no terminó en {timeout_s / 60:.0f} min")


# ── fases ─────────────────────────────────────────────────────────────────────────────────────────────────

def phase_catalogo(eng: Engine, rep: Report) -> None:
    sys.path.insert(0, str(ROOT / "engine"))
    from starblitz_engine.llm.catalog import CATALOG  # noqa: PLC0415
    rows = []
    for m in CATALOG:
        t0 = time.time()
        try:
            info = eng.call("GET", "/api/llm/repo?repo=" + urllib.request.quote(m.repo, safe="/"), timeout=60)
            files = {f["path"]: f for f in info["files"]}
            f = files.get(m.file.path)
            if not f:
                rep.add("catalogo", m.id, "FAIL", f"{m.repo}: no existe {m.file.path} (hay: {', '.join(list(files)[:6])})", time.time() - t0)
                rows.append([m.id, m.repo, m.file.path, "NO EXISTE", "-", "-"]); continue
            size = int(f.get("size") or 0)
            ok = abs(size - m.file.size) <= 0.02 * m.file.size
            rep.add("catalogo", m.id, "PASS" if ok else "WARN", f"{size:,} B en Hugging Face frente a {m.file.size:,} B del catálogo".replace(",", "."), time.time() - t0)
            rows.append([m.id, m.repo, m.file.path, f"{size / 1e9:.2f} GB", f"{m.file.size / 1e9:.2f} GB", info.get("license", "")])
        except ApiError as e:
            rep.add("catalogo", m.id, "FAIL", str(e)[:200], time.time() - t0)
            rows.append([m.id, m.repo, m.file.path, "ERROR", "-", "-"])
    rep.table("Catálogo curado frente a Hugging Face (real)", ["Modelo", "Repositorio", "Archivo", "Tamaño en HF", "Tamaño en catálogo", "Licencia"], rows)


def phase_vision(eng: Engine, rep: Report, ids: list[str], timeout_min: float) -> None:
    status = {m["id"]: m for m in eng.call("GET", "/api/models")["vision"]}
    for mid in ids:
        if mid not in status:
            rep.add("vision", mid, "SKIP", "este motor no define ese modelo"); continue
        t0 = time.time()
        try:
            job = eng.wait_job(eng.call("POST", f"/api/models/{mid}/install"), timeout_min * 60)
            now = {m["id"]: m for m in eng.call("GET", "/api/models")["vision"]}[mid]
            ok = job["status"] == "done" and now.get("installed")
            rep.add("vision", f"instalar {mid}", "PASS" if ok else "FAIL", "instalado y verificado" if ok else (job.get("error") or str(job)[:200]), time.time() - t0)
        except ApiError as e:
            rep.add("vision", f"instalar {mid}", "FAIL", str(e)[:250], time.time() - t0)


def phase_llm(eng: Engine, rep: Report, repo: str, file: str, mmproj: str | None, timeout_min: float, data_dir: Path) -> str | None:
    t0 = time.time()
    try:
        found = eng.call("GET", "/api/llm/search?q=" + urllib.request.quote(repo.split("/")[-1].replace("-GGUF", "") + " gguf"), timeout=60)
        rep.add("llm", "búsqueda en Hugging Face", "PASS" if found else "FAIL", f"{len(found)} resultados; primero: {found[0]['repo'] if found else '-'}", time.time() - t0)
    except ApiError as e:
        rep.add("llm", "búsqueda en Hugging Face", "FAIL", str(e)[:250], time.time() - t0)
    t0 = time.time()
    try:
        info = eng.call("GET", "/api/llm/repo?repo=" + urllib.request.quote(repo, safe="/"), timeout=60)
        ok = any(f["path"] == file for f in info["files"])
        rep.add("llm", f"inspeccionar {repo}", "PASS" if ok else "FAIL", f"licencia {info.get('license')}; {len(info['files'])} archivos GGUF", time.time() - t0)
        if not ok:
            return None
    except ApiError as e:
        rep.add("llm", f"inspeccionar {repo}", "FAIL", str(e)[:250], time.time() - t0)
        return None
    t0 = time.time()
    body = {"repo": repo, "file": file, **({"mmproj": mmproj} if mmproj else {})}
    try:
        job = eng.wait_job(eng.call("POST", "/api/llm/install", body), timeout_min * 60)
    except ApiError as e:
        rep.add("llm", "descargar e instalar el modelo", "FAIL", str(e)[:250], time.time() - t0)
        return None
    if job["status"] != "done":
        rep.add("llm", "descargar e instalar el modelo", "FAIL", job.get("error") or str(job)[:250], time.time() - t0)
        return None
    model = job["result"]
    ggufs = list((data_dir / "models").rglob(file))
    size_ok = bool(ggufs) and ggufs[0].stat().st_size == next((f["size"] for f in info["files"] if f["path"] == file), -1)
    rep.add("llm", "descargar e instalar el modelo (SHA-256 verificado por el motor)", "PASS" if size_ok else "WARN",
            f"{model['id']} · {model.get('quant')} · {model.get('license')} · {(ggufs[0].stat().st_size / 1e9) if ggufs else 0:.2f} GB en disco · "
            f"ajuste: {model.get('fit', {}).get('fits')}", time.time() - t0)
    return model["id"]


def phase_traduccion(eng: Engine, rep: Report, model_id: str) -> None:
    rows, scores = [], {"ja": [], "en": []}
    for lang, items in SAMPLES.items():
        for text, groups in items:
            t0 = time.time()
            try:
                out = eng.call("POST", "/api/llm/test", {"text": text, "source_lang": lang}, timeout=1200)
            except ApiError as e:
                rep.add("traduccion", f"{lang}→es «{text[:18]}»", "FAIL", str(e)[:250], time.time() - t0)
                rows.append([lang, text, "(error)", "-", "-"]); continue
            tr = (out.get("translation") or "").strip()
            words = set(re.findall(r"[a-záéíóúñü]+", tr.lower()))
            norm = lambda x: re.sub(r"\W+", " ", x.lower()).strip()  # noqa: E731
            hard = bool(tr) and not CJK.search(tr) and norm(tr) != norm(text) and len(words & ES_WORDS) >= 1
            score = sum(1 for g in groups if re.search(g, tr, re.I)) / len(groups)
            scores[lang].append(score)
            rep.add("traduccion", f"{lang}→es «{text[:18]}»", "PASS" if hard else "FAIL",
                    f"«{tr}» · confianza {out.get('confidence')} · coincidencia con lo esperado {score:.0%}", time.time() - t0)
            rows.append([lang, text, tr, f"{score:.0%}", ", ".join(out.get("flags") or []) or "-"])
    rep.table(f"Traducciones reales con {model_id} (japonés → español e inglés → español)", ["Idioma", "Original", "Traducción", "Coincidencia esperada", "Marcas"], rows)
    for lang, s in scores.items():
        if s:
            rep.add("traduccion", f"calidad orientativa {lang}→es", "INFO", f"media {sum(s) / len(s):.0%} de coincidencia con las expresiones esperadas ({len(s)} frases; no es una medida de calidad literaria)")


def _font(size: int, cjk: bool):
    from PIL import ImageFont  # noqa: PLC0415
    cands = ["C:/Windows/Fonts/YuGothB.ttc", "C:/Windows/Fonts/YuGothR.ttc", "C:/Windows/Fonts/meiryo.ttc", "C:/Windows/Fonts/msgothic.ttc",
             "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc"] if cjk else \
            ["C:/Windows/Fonts/arialbd.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]
    for p in cands:
        if Path(p).exists():
            return ImageFont.truetype(p, size, index=0) if p.endswith(".ttc") else ImageFont.truetype(p, size)
    return None


def make_page(bubbles: list[list[str]], cjk: bool) -> bytes | None:
    from PIL import Image, ImageDraw  # noqa: PLC0415
    f = _font(30 if cjk else 34, cjk)
    if f is None:
        return None
    im = Image.new("RGB", (900, 1300), "white")
    d = ImageDraw.Draw(im)
    d.rectangle((30, 30, 870, 620), outline="black", width=5)
    d.rectangle((30, 660, 870, 1270), outline="black", width=5)
    for y in range(40, 610, 14):
        d.line((40, y, 860, y), fill=(225, 225, 225))
    for y in range(670, 1260, 14):
        d.line((40, y, 860, y), fill=(225, 225, 225))
    d.ellipse((330, 330, 560, 560), fill=(150, 150, 150))
    boxes = [(80, 60, 430, 300), (500, 90, 840, 330), (90, 700, 440, 940), (470, 1010, 840, 1240)]
    for box, lines in zip(boxes, bubbles):
        d.ellipse(box, fill="white", outline="black", width=4)
        x1, y1, x2, y2 = box
        step = (30 if cjk else 34) + 8
        y = (y1 + y2) / 2 - len(lines) * step / 2
        for ln in lines:
            d.text(((x1 + x2) / 2 - d.textlength(ln, font=f) / 2, y), ln, font=f, fill="black")
            y += step
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def _zip_of(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n, b in files.items():
            z.writestr(n, b)
    return buf.getvalue()


def phase_proyecto(eng: Engine, rep: Report, out: Path, lang: str, user_source: Path | None, timeout_min: float) -> None:
    cases: list[tuple[str, bytes, list[list[str]] | None, str]] = []
    if user_source:
        data = user_source.read_bytes() if user_source.is_file() else _zip_of({p.name: p.read_bytes() for p in sorted(user_source.iterdir()) if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")})
        cases.append((f"capítulo del usuario ({user_source.name})", data, None, lang))
    else:
        ja, en = make_page(PAGE_JA, True), make_page(PAGE_EN, False)
        if ja:
            cases.append(("página sintética japonesa", _zip_of({"001.png": ja}), PAGE_JA, "ja"))
        if en:
            cases.append(("página sintética inglesa", _zip_of({"001.png": en}), PAGE_EN, "en"))
        if not cases:
            rep.add("proyecto", "páginas de prueba", "SKIP", "no hay fuente para dibujarlas (instala una fuente CJK o usa --proyecto)")
            return
    for title, zdata, expected, src in cases:
        t0 = time.time()
        proj = eng.call("POST", "/api/projects", {"name": title, "source_lang": "auto" if expected else src})  # páginas sintéticas: idioma AUTOMÁTICO
        pid = proj["id"]
        try:
            eng.wait_job(eng.upload(f"/api/projects/{pid}/import", "capitulo.zip", zdata), 300)
            job = eng.call("POST", f"/api/projects/{pid}/process", {})

            def tick(j):
                pass
            j = eng.wait_job(job, timeout_min * 60, tick)
        except ApiError as e:
            rep.add("proyecto", title, "FAIL", str(e)[:300], time.time() - t0); continue
        data = eng.call("GET", f"/api/projects/{pid}")
        pages = data["pages"]
        done = j["status"] == "done" and all(p["status"] == "cleaned" and p["has_clean"] for p in pages)
        rep.add("proyecto", f"{title}: proceso completo (OCR, traducción, reconstrucción)", "PASS" if done else "FAIL",
                f"estado {j['status']}; {len(pages)} página(s); {sum(len(p['regions']) for p in pages)} bloques de texto; idioma detectado {data['project'].get('detected_lang')}"
                + (f"; error: {j.get('error')}" if j.get("error") else ""), time.time() - t0)
        if expected:
            det = data["project"].get("detected_lang")
            rep.add("proyecto", f"{title}: idioma de origen detectado automáticamente", "PASS" if det == src else "FAIL", f"detectado «{det}», esperado «{src}»")
        regions = [r for p in pages for r in p["regions"]]
        if not regions:
            rep.add("proyecto", f"{title}: bloques de texto detectados", "FAIL", "el detector no encontró ningún bloque"); continue
        untranslated = [r for r in regions if not (r.get("translation") or "").strip()]
        cjk_left = [r for r in regions if CJK.search(r.get("translation") or "") and src != "ko"]
        rep.add("proyecto", f"{title}: todos los bloques traducidos al español sin restos del idioma original",
                "PASS" if not untranslated and not cjk_left else "FAIL", f"{len(untranslated)} sin traducir, {len(cjk_left)} con caracteres CJK")
        if expected:   # el texto dibujado es conocido: se mide el OCR real
            want = ["".join(b) for b in expected]
            got = [(r.get("source_text") or "").replace("\n", "").replace(" ", "") for r in regions]
            sims = [max((difflib.SequenceMatcher(None, w.replace(" ", ""), g).ratio() for g in got), default=0.0) for w in want]
            avg = sum(sims) / len(sims)
            rep.add("proyecto", f"{title}: OCR real frente al texto dibujado", "PASS" if avg >= 0.6 else "FAIL",
                    f"similitud media {avg:.0%} ({', '.join(f'{s:.0%}' for s in sims)}); motor: {regions[0].get('ocr_engine')}")
        rows = [[p["id"][:6], r.get("source_text", ""), r.get("translation", ""), f"{(r.get('confidence') or 0):.2f}", r.get("ocr_engine", ""), ", ".join(r.get("flags") or []) or "-"]
                for p in pages for r in p["regions"]]
        rep.table(f"Resultado: {title}", ["Pág.", "Texto leído (OCR)", "Traducción", "Confianza", "OCR", "Marcas"], rows)
        try:   # imágenes para revisar a ojo: original y reconstruida
            from PIL import Image  # noqa: PLC0415
            for i, p in enumerate(pages[:3]):
                o = Image.open(io.BytesIO(eng.call("GET", f"/api/projects/{pid}/pages/{p['id']}/image/original"))).convert("RGB")
                c = Image.open(io.BytesIO(eng.call("GET", f"/api/projects/{pid}/pages/{p['id']}/image/clean"))).convert("RGB")
                side = Image.new("RGB", (o.width + c.width, max(o.height, c.height)), "white")
                side.paste(o, (0, 0)); side.paste(c, (o.width, 0))
                name = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") + f"-{i + 1}-original-vs-limpia.png"
                side.thumbnail((1800, 1400)); side.save(out / name)
        except Exception as e:  # noqa: BLE001
            rep.add("proyecto", f"{title}: imágenes de comparación", "WARN", str(e)[:200])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=Path("informe-real"))
    ap.add_argument("--todo", action="store_true", help="catalogo + vision + llm + traduccion + proyecto")
    for n in ("catalogo", "vision", "llm", "traduccion", "proyecto"):
        ap.add_argument("--" + n, action="store_true")
    ap.add_argument("--llm-repo", default="unsloth/Qwen3.5-2B-GGUF")
    ap.add_argument("--llm-file", default="Qwen3.5-2B-Q4_K_M.gguf")
    ap.add_argument("--llm-mmproj", default=None)
    ap.add_argument("--vision-ids", default="text-detector,manga-ocr,lama")
    ap.add_argument("--llama-server", default=os.environ.get("STARBLITZ_LLAMA_SERVER"), help="ruta de llama-server (si no está junto al motor)")
    ap.add_argument("--data-dir", type=Path, default=None, help="carpeta de datos del motor (por defecto, una temporal que se conserva en --out)")
    ap.add_argument("--proyecto-origen", dest="proyecto_origen", type=Path, default=None, help="ZIP o carpeta de imágenes propias (se procesa en local)")
    ap.add_argument("--idioma", default="auto", help="idioma de origen de --proyecto-origen: auto, ja, en, ko, zh…")
    ap.add_argument("--timeout-min", type=float, default=90)
    a = ap.parse_args()
    if a.todo:
        a.catalogo = a.vision = a.llm = a.traduccion = a.proyecto = True
    if not any((a.catalogo, a.vision, a.llm, a.traduccion, a.proyecto)):
        ap.error("elige qué probar (--todo o alguna fase)")
    a.out.mkdir(parents=True, exist_ok=True)
    data_dir = a.data_dir or (a.out / "datos-motor")
    rep = Report(a.out)
    env = {"sistema": f"{platform.system()} {platform.release()} {platform.machine()}", "python": platform.python_version(),
           "cpu": os.cpu_count(), "fecha": time.strftime("%Y-%m-%d %H:%M:%S"), "llama-server": a.llama_server or "(junto al motor)"}
    try:
        with Engine(data_dir, a.llama_server, a.out / "motor.log") as eng:
            env["motor"] = eng.call("GET", "/api/system").get("version", "?")
            if a.catalogo:
                phase_catalogo(eng, rep)
            if a.vision or a.proyecto:
                phase_vision(eng, rep, [s for s in a.vision_ids.split(",") if s], a.timeout_min)
            model_id = None
            if a.llm or a.traduccion or a.proyecto:
                model_id = phase_llm(eng, rep, a.llm_repo, a.llm_file, a.llm_mmproj, a.timeout_min, data_dir)
            if a.traduccion:
                phase_traduccion(eng, rep, model_id) if model_id else rep.add("traduccion", "traducción", "SKIP", "no hay modelo instalado")
            if a.proyecto:
                if model_id:
                    phase_proyecto(eng, rep, a.out, a.idioma, a.proyecto_origen, a.timeout_min)
                else:
                    rep.add("proyecto", "proyecto completo", "SKIP", "no hay modelo instalado")
            if model_id:
                eng.call("POST", "/api/llm/unload")
    except ApiError as e:
        rep.add("motor", "ejecución", "FAIL", str(e)[:400])
    rep.write(env)
    print(f"\nInforme: {a.out / 'informe.md'}")
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
