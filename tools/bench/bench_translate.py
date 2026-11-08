#!/usr/bin/env python3
"""
Banco de pruebas REPRODUCIBLE de modelos de traducción (GGUF + llama-server) para STARBLITZ.

Qué mide, sin simular nada:
  - tiempo real por segmento y total (reloj de pared), tokens de entrada/salida y tokens/s que informa el propio llama-server;
  - RAM máxima del proceso del servidor (psutil, muestreo cada 100 ms);
  - comprobaciones AUTOMÁTICAS de fidelidad sobre el corpus `corpus_ja_ko.jsonl` (inventado, sin material con derechos):
    vacío, negativa del modelo, texto sin traducir, inglés filtrado, omisión/adición por longitud y conservación del contenido
    («keep»: insultos, términos adultos, violencia, nombres y glosario deben aparecer en la salida).

Qué NO mide:
  - La calidad literaria ni la naturalidad: eso necesita a una persona que lea el idioma. Las comprobaciones automáticas
    detectan omisiones, suavizados y rechazos, no matices. Guarda todas las salidas (`items[].out`) para revisarlas a mano.
  - La velocidad del teléfono: ejecútalo en el equipo que quieras medir. En un PC los tiempos NO representan al Redmi;
    los recuentos de tokens SÍ son independientes del dispositivo (ver --phone-prefill-tps / --phone-gen-tps).

Uso (ejemplo):
  python bench_translate.py --server llama-server.exe --model Hy-MT2-1.8B-Q4_K_M.gguf --profile hymt2 --mode per --out r.json
Perfiles: qwen (instrucción genérica), hymt2 (formato nativo de Hy-MT2), plamo (plantilla nativa PFML3), app (el prompt y el
esquema JSON reales de STARBLITZ, página = escena).
Modos: per (una llamada por segmento), batch (una llamada por escena, líneas numeradas). `--gloss` añade el glosario de la escena.
"""
import argparse, json, os, re, subprocess, sys, threading, time, unicodedata, urllib.request
from collections import defaultdict

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(ROOT, '..', '..'))
LANG_NAME = {'ja': 'Japanese', 'ko': 'Korean'}
LANG_ES = {'ja': 'japonés', 'ko': 'coreano'}

QWEN_SYSTEM = (
    'Eres un traductor profesional de manga, manhwa y cómics al español latino neutro. Traduce de forma FIEL y COMPLETA: '
    'sin omitir, sin añadir, sin resumir, sin explicar y sin suavizar. Conserva el tono, los insultos, la vulgaridad, el contenido '
    'sexual y la violencia tal cual aparecen en el original; no los censures ni los edulcores. Mantén los nombres propios y respeta '
    'el glosario si se da. Devuelve únicamente la traducción.'
)
REFUSAL = re.compile(r"(lo siento|no puedo (ayudar|traducir|cumplir|continuar)|i('m| am) sorry|i can't|i cannot|cannot (help|assist|translate)|como (modelo|ia|asistente)|no me es posible|contenido (inapropiado|expl[ií]cito))", re.I)
CJK = re.compile(r'[぀-ヿ㐀-鿿가-힯]')
EN_WORDS = re.compile(r'\b(the|you|is|are|and|to|of|with|this|that)\b', re.I)


def norm(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s.lower()) if unicodedata.category(c) != 'Mn')


# ---------------------------------------------------------------- servidor
class Server:
    def __init__(self, exe, model, threads, ctx, port, ngl, extra):
        import psutil
        self.psutil = psutil
        args = [exe, '-m', model, '-c', str(ctx), '--parallel', '1', '-t', str(threads), '-ngl', str(ngl), '--host', '127.0.0.1',
                '--port', str(port), '--jinja', '--no-webui', '--reasoning-budget', '0', *extra]
        self.p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, cwd=os.path.dirname(os.path.abspath(exe)))
        self.base = f'http://127.0.0.1:{port}'
        self.peak = 0
        self.stop = False
        self.t = threading.Thread(target=self._sample, daemon=True)
        t0 = time.time()
        while True:
            if self.p.poll() is not None:
                raise RuntimeError('llama-server terminó al arrancar: ' + (self.p.stderr.read().decode('utf8', 'replace')[-1500:]))
            try:
                with urllib.request.urlopen(self.base + '/health', timeout=2) as r:
                    if json.load(r).get('status') == 'ok':
                        break
            except Exception:
                pass
            if time.time() - t0 > 240:
                raise RuntimeError('llama-server no estuvo listo en 240 s')
            time.sleep(0.5)
        self.load_s = time.time() - t0
        self.t.start()

    def _rss(self):
        try:
            pr = self.psutil.Process(self.p.pid)
            return sum(x.memory_info().rss for x in [pr, *pr.children(recursive=True)])
        except Exception:
            return 0

    def _sample(self):
        while not self.stop:
            self.peak = max(self.peak, self._rss())
            time.sleep(0.1)

    def post(self, path, body, timeout=600):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        t0 = time.perf_counter()
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.load(r)
        return data, time.perf_counter() - t0

    def close(self):
        self.stop = True
        self.p.terminate()
        try:
            self.p.wait(10)
        except Exception:
            self.p.kill()


# ---------------------------------------------------------------- peticiones por perfil
def gloss_lines(gl):
    return [(s, t) for s, t in gl]


def build(profile, lang, texts, gloss, batch):
    """Devuelve el cuerpo de /v1/chat/completions."""
    base = {'temperature': 0, 'max_tokens': 1024, 'cache_prompt': True, 'stream': False}
    if profile == 'plamo':
        kw = {'target_lang': 'es', 'source_lang': lang}
        if gloss:
            kw['glossary'] = [{'source': s, 'target': t} for s, t in gloss]
        return {**base, 'messages': [{'role': 'user', 'content': '\n'.join(texts)}], 'chat_template_kwargs': kw,
                'stop': ['<|plamo:tag|>', '<|plamo:bos|>']}
    numbered = '\n'.join(f'[{i + 1}] {t}' for i, t in enumerate(texts))
    if profile == 'hymt2':
        pre = ''
        if gloss:
            pre = 'Reference the following translations:\n' + '\n'.join(f'{s} translates to {t}' for s, t in gloss) + '\n'
        if batch:
            user = (pre + 'Translate each of the following numbered lines from ' + LANG_NAME[lang] + ' into Spanish. Keep the same [n] numbering, '
                    'one translation per line, and do not merge, skip or add lines. Do not soften or censor any word. '
                    'Only output the translated result without any additional explanation:\n\n' + numbered)
        else:
            user = (pre + 'Translate the following text into Spanish. Note that you should only output the translated result '
                    'without any additional explanation:\n\n' + texts[0])
        return {**base, 'messages': [{'role': 'user', 'content': user}]}
    if profile == 'qwen':
        sysm = QWEN_SYSTEM
        if gloss:
            sysm += '\nGlosario obligatorio (usa exactamente estas traducciones):\n' + '\n'.join(f'{s} => {t}' for s, t in gloss)
        if batch:
            user = f'Traduce del {LANG_ES[lang]} al español. Mantén la numeración [n], una línea por texto, sin unir, omitir ni añadir líneas:\n\n{numbered}'
        else:
            user = f'Traduce del {LANG_ES[lang]} al español:\n\n{texts[0]}'
        return {**base, 'messages': [{'role': 'system', 'content': sysm}, {'role': 'user', 'content': user}],
                'chat_template_kwargs': {'enable_thinking': False}}
    if profile == 'app':
        raw = json.load(open(os.path.join(REPO, 'apps', 'mobile', 'src', 'engine', 'translate', 'prompts.json'), encoding='utf8'))
        v = raw['variants']['es-419']
        prof = raw['profiles']['natural'][2]
        system = raw['translator_system']
        for k, val in {'variant_name': v[0], 'variant_rules': v[1], 'honorifics': raw['honorifics']['adapt'], 'profile_rules': prof}.items():
            system = system.replace('{' + k + '}', val)
        user = ''
        if gloss:
            user += 'GLOSARIO DE LA OBRA:\n' + '\n'.join(f'- {s} → {t}' for s, t in gloss) + '\n\n'
        user += f'PÁGINA ACTUAL (1/1) — textos en orden de lectura:\n'
        for i, t in enumerate(texts):
            user += f'[{i + 1}] (diálogo, máx. ~40 caracteres) {t}\n'
        user += f'\nDevuelve un elemento en «items» por cada número traducible. En «page_summary»: {raw["summary_note"]}'
        return {**base, 'max_tokens': 4096, 'top_p': 0.9, 'repeat_penalty': 1.05,
                'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
                'response_format': {'type': 'json_schema', 'json_schema': {'name': 'respuesta', 'schema': raw['translation_schema'], 'strict': True}},
                'chat_template_kwargs': {'enable_thinking': False}}
    raise SystemExit('perfil desconocido: ' + profile)


def parse(profile, content, n, batch):
    content = (content or '').strip()
    if profile == 'app':
        try:
            items = json.loads(content).get('items', [])
            by = {int(i.get('n', 0)): str(i.get('translation', '')).strip() for i in items if isinstance(i, dict)}
            return [by.get(i + 1, '') for i in range(n)]
        except Exception:
            return [''] * n
    if not batch:
        return [content]
    if profile == 'plamo':
        lines = [l for l in content.split('\n') if l.strip()]
        return [lines[i] if i < len(lines) else '' for i in range(n)]
    got = {}
    for line in content.split('\n'):
        m = re.match(r'^\s*\[?(\d+)[\]\.\):]\s*(.*)$', line)
        if m:
            got[int(m.group(1))] = m.group(2).strip()
    return [got.get(i + 1, '') for i in range(n)]


# ---------------------------------------------------------------- evaluación automática
def check(item, out):
    r = {'empty': not out.strip()}
    r['refusal'] = bool(REFUSAL.search(out)) and not REFUSAL.search(item['src'])
    sfx = item['cat'] == 'onomatopeya'
    r['untranslated'] = (not sfx) and len(CJK.findall(out)) > 0
    r['english_leak'] = len(EN_WORDS.findall(out)) >= 2
    o = norm(out)
    groups = item.get('keep', [])
    missing = [g for g in groups if not any(norm(a) in o for a in g)]
    r['keep_missing'] = [g[0] for g in missing]
    r['keep_ok'] = not missing
    ref_len = max(1, len(item['ref']))
    ratio = len(out.strip()) / ref_len
    r['len_ratio'] = round(ratio, 2)
    r['omission_suspect'] = (not sfx) and ratio < 0.45
    r['addition_suspect'] = (not sfx) and ratio > 2.6
    r['ok'] = (not r['empty'] and not r['refusal'] and not r['untranslated'] and not r['english_leak'] and r['keep_ok']
               and not r['omission_suspect'] and not r['addition_suspect'])
    return r


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--server', required=True)
    ap.add_argument('--model', required=True)
    ap.add_argument('--profile', required=True, choices=['qwen', 'hymt2', 'plamo', 'app'])
    ap.add_argument('--mode', choices=['per', 'batch'], default='per')
    ap.add_argument('--gloss', action='store_true', help='añade el glosario de la escena (solo escenas que lo definen)')
    ap.add_argument('--lang', choices=['ja', 'ko', 'all'], default='all')
    ap.add_argument('--threads', type=int, default=6)
    ap.add_argument('--ctx', type=int, default=4096)
    ap.add_argument('--ngl', type=int, default=0, help='capas en GPU (0 = CPU, lo que usa el teléfono)')
    ap.add_argument('--port', type=int, default=18080)
    ap.add_argument('--corpus', default=os.path.join(ROOT, 'corpus_ja_ko.jsonl'))
    ap.add_argument('--ids', default='', help='lista separada por comas para una prueba rápida')
    ap.add_argument('--out', required=True)
    ap.add_argument('--label', default='')
    ap.add_argument('--phone-prefill-tps', type=float, default=0, help='tokens/s de lectura del teléfono (medido) para PROYECTAR; 0 = no proyectar')
    ap.add_argument('--phone-gen-tps', type=float, default=0, help='tokens/s de generación del teléfono (medido)')
    ap.add_argument('--extra', nargs=argparse.REMAINDER, default=[])
    a = ap.parse_args()

    items = [json.loads(l) for l in open(a.corpus, encoding='utf8') if l.strip()]
    if a.lang != 'all':
        items = [i for i in items if i['lang'] == a.lang]
    if a.ids:
        want = set(a.ids.split(','))
        items = [i for i in items if i['id'] in want]
    scenes = defaultdict(list)
    for i in items:
        scenes[i['scene']].append(i)

    srv = Server(a.server, a.model, a.threads, a.ctx, a.port, a.ngl, a.extra)
    results, calls = [], []
    try:
        idle_rss = srv._rss()
        # calentamiento (no cuenta): primera petición paga la carga perezosa de pesos y la caché de prompts
        srv.post('/v1/chat/completions', build(a.profile, 'ja', ['こんにちは。'], [], False) if a.profile != 'app' else build('qwen', 'ja', ['こんにちは。'], [], False))
        t_all = time.perf_counter()
        for name, group in scenes.items():
            gloss = []
            if a.gloss:
                seen = set()
                for it in group:
                    for s, t in it.get('gloss', []):
                        if s not in seen:
                            seen.add(s)
                            gloss.append((s, t))
            lang = group[0]['lang']
            batch = a.mode == 'batch' or a.profile == 'app'
            units = [group] if batch else [[g] for g in group]
            for unit in units:
                texts = [u['src'] for u in unit]
                body = build(a.profile, lang, texts, gloss, batch)
                data, wall = srv.post('/v1/chat/completions', body)
                content = data['choices'][0]['message'].get('content') or ''
                tm = data.get('timings', {})
                us = data.get('usage', {})
                calls.append({'scene': name, 'n_items': len(unit), 'wall_s': round(wall, 3), 'prompt_tokens': us.get('prompt_tokens'),
                              'completion_tokens': us.get('completion_tokens'), 'prompt_n_new': tm.get('prompt_n'),
                              'prompt_ms': tm.get('prompt_ms'), 'predicted_ms': tm.get('predicted_ms'),
                              'predicted_per_second': tm.get('predicted_per_second')})
                outs = parse(a.profile, content, len(unit), batch)
                for u, o in zip(unit, outs):
                    results.append({'id': u['id'], 'lang': u['lang'], 'cat': u['cat'], 'src': u['src'], 'ref': u['ref'], 'out': o,
                                    'check': check(u, o), 'raw': content if len(unit) > 1 and u is unit[0] else ''})
        total = time.perf_counter() - t_all
        peak = srv.peak
    finally:
        srv.close()

    by_cat = defaultdict(lambda: [0, 0])
    for r in results:
        by_cat[r['cat']][1] += 1
        by_cat[r['cat']][0] += 1 if r['check']['ok'] else 0
    n = len(results)
    flag = lambda k: sum(1 for r in results if r['check'][k])
    pt = sum(c['prompt_tokens'] or 0 for c in calls)
    ct = sum(c['completion_tokens'] or 0 for c in calls)
    summary = {
        'label': a.label or f'{os.path.basename(a.model)} · {a.profile} · {a.mode}{" +glosario" if a.gloss else ""}',
        'model': os.path.basename(a.model), 'model_mb': round(os.path.getsize(a.model) / 1e6), 'profile': a.profile, 'mode': 'batch' if a.profile == 'app' else a.mode,
        'gloss': a.gloss, 'threads': a.threads, 'ngl': a.ngl, 'ctx': a.ctx, 'segments': n, 'calls': len(calls),
        'wall_total_s': round(total, 2), 'wall_per_segment_s': round(total / max(1, n), 3),
        'prompt_tokens': pt, 'completion_tokens': ct, 'completion_per_segment': round(ct / max(1, n), 1),
        'gen_tps_avg': round(sum(c['predicted_per_second'] or 0 for c in calls) / max(1, len(calls)), 1),
        'rss_idle_mb': round(idle_rss / 1e6), 'rss_peak_mb': round(peak / 1e6), 'load_s': round(srv.load_s, 1),
        'ok': sum(1 for r in results if r['check']['ok']), 'empty': flag('empty'), 'refusal': flag('refusal'),
        'untranslated': flag('untranslated'), 'english_leak': flag('english_leak'), 'omission_suspect': flag('omission_suspect'),
        'addition_suspect': flag('addition_suspect'), 'keep_failed': sum(1 for r in results if not r['check']['keep_ok']),
        'by_cat': {k: f'{v[0]}/{v[1]}' for k, v in by_cat.items()},
        'host': {'cpu_count': os.cpu_count(), 'platform': sys.platform},
        'server': os.path.basename(a.server),
        'note': 'Tiempos de ESTE equipo: no representan al teléfono. Los recuentos de tokens sí son independientes del dispositivo.',
    }
    if a.phone_prefill_tps and a.phone_gen_tps:
        summary['projection_phone_s'] = round(pt / a.phone_prefill_tps + ct / a.phone_gen_tps, 1)
        summary['projection_note'] = 'PROYECCIÓN (no medición): tokens medidos aquí ÷ velocidades del teléfono que aportaste; ignora el prefijo en caché y la carga.'
    json.dump({'summary': summary, 'calls': calls, 'items': results}, open(a.out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    print(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
