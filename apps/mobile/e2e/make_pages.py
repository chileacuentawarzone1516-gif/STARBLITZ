"""Dos páginas de manga sintéticas (dibujadas aquí, sin contenido de nadie) para la prueba E2E: globos con texto japonés,
uno vertical y manchas grises que no son texto. Uso: python make_pages.py <carpeta_salida> [fuente_cjk.ttc]"""
from PIL import Image, ImageDraw, ImageFont
import sys, os
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
F = sys.argv[2] if len(sys.argv) > 2 else os.environ.get('CJK_FONT', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
def font(sz): return ImageFont.truetype(F, sz, index=0)
def bubble(d, box, lines, sz=34, vertical=False):
    d.ellipse(box, fill='white', outline='black', width=4)
    x1, y1, x2, y2 = box; f = font(sz)
    if not vertical:
        h = len(lines) * (sz + 8); y = (y1 + y2) / 2 - h / 2
        for ln in lines:
            w = d.textlength(ln, font=f); d.text(((x1 + x2) / 2 - w / 2, y), ln, font=f, fill='black'); y += sz + 8
    else:
        cols = len(lines); cw = sz + 10; x = (x1 + x2) / 2 + (cols - 1) * cw / 2
        for ln in lines:
            y = (y1 + y2) / 2 - len(ln) * (sz + 2) / 2
            for ch in ln: d.text((x - sz / 2, y), ch, font=f, fill='black'); y += sz + 2
            x -= cw
def page(name, items):
    im = Image.new('RGB', (900, 1300), 'white'); d = ImageDraw.Draw(im)
    d.rectangle((30, 30, 870, 620), outline='black', width=5); d.rectangle((30, 660, 870, 1270), outline='black', width=5)
    for y in range(40, 610, 14): d.line((40, y, 860, y), fill=(225, 225, 225), width=1)
    for y in range(670, 1260, 14): d.line((40, y, 860, y), fill=(225, 225, 225), width=1)
    d.ellipse((330, 330, 560, 560), fill=(150, 150, 150)); d.ellipse((700, 800, 820, 1000), fill=(110, 110, 110))
    for it in items: bubble(d, *it)
    im.save(os.path.join(out, name))
page('pagina-01.png', [((80, 60, 420, 300), ['おはよう！', '今日はいい天気ですね。'], 26, False), ((520, 90, 840, 330), ['先輩、待ってください！', 'もう少しで着きます。'], 24, False),
                       ((90, 700, 430, 940), ['本当に行くのか？', 'もう戻れないぞ。'], 32, False), ((470, 1010, 840, 1240), ['大丈夫。', '私に任せて。'], 34, False)])
page('pagina-02.png', [((100, 70, 440, 330), ['ありがとう、', 'みんなのおかげだよ。'], 32, False), ((500, 60, 700, 480), ['どうして', '黙っているの？'], 34, True),
                       ((120, 720, 520, 980), ['また明日会おう。', 'さようなら！'], 36, False)])
