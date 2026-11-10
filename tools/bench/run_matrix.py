#!/usr/bin/env python3
"""
Ejecuta la matriz de comparación completa con bench_translate.py (secuencial, para no falsear tiempos ni memoria).
Uso: python run_matrix.py --server <llama-server> --models <carpeta con los .gguf> --out <carpeta de resultados> [--threads 6]
Los resultados que ya existen se omiten (se puede reanudar). Nada se descarga aquí: los GGUF deben estar ya en la carpeta.
"""
import argparse, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
# (archivo, perfil, modo, glosario)
MATRIX = [
    ('Qwen3.5-0.8B-Q4_K_M.gguf', 'qwen', 'per', False),
    ('Qwen3.5-0.8B-Q4_K_M.gguf', 'qwen', 'batch', False),
    ('Qwen3.5-0.8B-Q4_K_M.gguf', 'app', 'batch', False),
    ('Qwen3.5-2B-Q4_K_M.gguf', 'qwen', 'per', False),
    ('Qwen3.5-2B-Q4_K_M.gguf', 'qwen', 'batch', False),
    ('Qwen3.5-2B-Q4_K_M.gguf', 'qwen', 'per', True),
    ('Qwen3.5-2B-Q4_K_M.gguf', 'app', 'batch', False),
    ('Qwen3.5-4B-Q4_K_M.gguf', 'qwen', 'per', False),
    ('Qwen3.5-4B-Q4_K_M.gguf', 'qwen', 'per', True),
    ('Qwen3.5-4B-Q4_K_M.gguf', 'qwen', 'batch', False),
    ('Qwen3.5-4B-Q4_K_M.gguf', 'app', 'batch', False),
    ('Hy-MT2-1.8B-Q4_K_M.gguf', 'hymt2', 'per', False),
    ('Hy-MT2-1.8B-Q4_K_M.gguf', 'hymt2', 'per', True),
    ('Hy-MT2-1.8B-Q4_K_M.gguf', 'hymt2', 'batch', False),
    ('Hy-MT2-1.8B-Q4_K_M.gguf', 'hymt2', 'batch', True),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--server', required=True)
    ap.add_argument('--models', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--threads', type=int, default=6)
    ap.add_argument('--only', default='', help='filtra por subcadena del nombre de archivo del modelo')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    for fname, profile, mode, gloss in MATRIX:
        if a.only and a.only not in fname:
            continue
        model = os.path.join(a.models, fname)
        if not os.path.exists(model):
            print('FALTA', fname, flush=True)
            continue
        tag = f"{fname.split('-Q4')[0]}__{profile}-{mode}{'-gloss' if gloss else ''}"
        out = os.path.join(a.out, tag + '.json')
        if os.path.exists(out):
            print('ya existe', tag, flush=True)
            continue
        cmd = [sys.executable, '-X', 'utf8', os.path.join(HERE, 'bench_translate.py'), '--server', a.server, '--model', model,
               '--profile', profile, '--mode', mode, '--threads', str(a.threads), '--out', out]
        if gloss:
            cmd.append('--gloss')
        print('>>', tag, flush=True)
        r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
        if r.returncode != 0:
            print('ERROR', tag, (r.stderr or r.stdout)[-600:], flush=True)
    print('FIN', flush=True)


if __name__ == '__main__':
    main()
