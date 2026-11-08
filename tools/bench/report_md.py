#!/usr/bin/env python3
"""Resume uno o varios resultados de bench_translate.py en Markdown (tabla comparativa y, opcionalmente, todas las salidas)."""
import json, sys

sys.stdout.reconfigure(encoding='utf-8')
args = [a for a in sys.argv[1:] if not a.startswith('--')]
show_items = '--items' in sys.argv
only_fail = '--fails' in sys.argv

runs = [json.load(open(p, encoding='utf-8')) for p in args]
print('| Configuración | MB | Seg. | Llamadas | Tokens ent./sal. | tok/s gen. | s/seg. | s total | RAM pico MB | OK | Vacías | Rechazos | Sin traducir | Inglés | Omisión? | Adición? | Contenido perdido |')
print('|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for r in runs:
    s = r['summary']
    print(f"| {s['label']} | {s['model_mb']} | {s['segments']} | {s['calls']} | {s['prompt_tokens']}/{s['completion_tokens']} | {s['gen_tps_avg']} | "
          f"{s['wall_per_segment_s']} | {s['wall_total_s']} | {s['rss_peak_mb']} | {s['ok']}/{s['segments']} | {s['empty']} | {s['refusal']} | "
          f"{s['untranslated']} | {s['english_leak']} | {s['omission_suspect']} | {s['addition_suspect']} | {s['keep_failed']} |")
print()
for r in runs:
    s = r['summary']
    print(f"**{s['label']}** — por categoría (OK/total): " + ', '.join(f'{k} {v}' for k, v in s['by_cat'].items()))
if show_items:
    print()
    ids = [i['id'] for i in runs[0]['items']]
    for iid in ids:
        base = next(i for i in runs[0]['items'] if i['id'] == iid)
        rows = []
        for r in runs:
            it = next((i for i in r['items'] if i['id'] == iid), None)
            if it and (not only_fail or not it['check']['ok']):
                rows.append((r['summary']['label'], it))
        if not rows:
            continue
        print(f"\n### {iid} · {base['cat']} · `{base['src']}`  \nReferencia: {base['ref']}")
        for label, it in rows:
            c = it['check']
            tags = [k for k in ('empty', 'refusal', 'untranslated', 'english_leak', 'omission_suspect', 'addition_suspect') if c[k]]
            if c['keep_missing']:
                tags.append('falta: ' + '/'.join(c['keep_missing']))
            print(f"- {'✅' if c['ok'] else '⚠️'} **{label}**: {it['out']!r}" + (f"  _({', '.join(tags)})_" if tags else ''))
