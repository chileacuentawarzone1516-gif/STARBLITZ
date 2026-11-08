"""Rasteriza SVG a PNG con Chromium (Playwright) a los tamaños pedidos."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

def render(jobs):
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(device_scale_factor=1)
        for svg, png, w, h in jobs:
            data = Path(svg).read_text(encoding="utf-8")
            page.set_viewport_size({"width": w, "height": h})
            page.set_content(f'<html><body style="margin:0;background:transparent">'
                             f'<img src="data:image/svg+xml;base64,{__import__("base64").b64encode(data.encode()).decode()}" '
                             f'style="width:{w}px;height:{h}px;display:block"></body></html>')
            page.wait_for_timeout(50)
            page.screenshot(path=png, omit_background=True, clip={"x": 0, "y": 0, "width": w, "height": h})
        b.close()

if __name__ == "__main__":
    args = sys.argv[1:]
    render([(args[i], args[i+1], int(args[i+2]), int(args[i+3])) for i in range(0, len(args), 4)])
