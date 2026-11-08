"""Páginas SINTÉTICAS de distintos tamaños para tools/bench/vision_bench.mjs (texto japonés sobre viñetas simples).
Uso: python make_bench_pages.py <carpeta_pages> <fuente_cjk.ttc>     (genera bench-*.png a partir de pagina-01/02.png de apps/mobile/e2e)
No es manga real: sirve para comparar tamaños y formas de página, no para predecir el teléfono."""
import os
import subprocess
import sys

from PIL import Image

out, font = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
make = os.path.join(here, '..', '..', 'apps', 'mobile', 'e2e', 'make_pages.py')
subprocess.run([sys.executable, make, out, font], check=True)
a = Image.open(os.path.join(out, 'pagina-01.png')).convert('RGB')
b = Image.open(os.path.join(out, 'pagina-02.png')).convert('RGB')
a.save(os.path.join(out, 'bench-1-pagina-900x1300.png'))
a.resize((1620, 2340), Image.LANCZOS).save(os.path.join(out, 'bench-2-pagina-1620x2340.png'))       # escaneo de resolución típica
tall = Image.new('RGB', (900, 1300 * 3), 'white')                                                    # tira vertical (webtoon): 3 páginas
for i, im in enumerate([a, b, a]):
    tall.paste(im, (0, i * 1300))
tall.save(os.path.join(out, 'bench-3-tira-900x3900.png'))
print('ok')
