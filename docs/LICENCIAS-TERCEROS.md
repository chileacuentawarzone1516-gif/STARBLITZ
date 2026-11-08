# Licencias de terceros

El código de STARBLITZ es MIT. Esta lista recoge lo que usa o descarga; verifica las licencias vigentes antes de
redistribuir modelos o paquetes.

## Modelos (los descarga el usuario desde la app; no se incluyen en instaladores ni en el APK, salvo PP-OCR)

| Componente | Licencia | Fuente |
|---|---|---|
| comic-text-detector (pesos ONNX) | **GPL‑3.0** | https://github.com/dmMaze/comic-text-detector · ONNX: https://github.com/zyddnys/manga-image-translator |
| Manga OCR (kha-white) / exportación ONNX de onnx-community | Apache‑2.0 | https://github.com/kha-white/manga-ocr |
| LaMa (Samsung AI Center) / exportación Carve/LaMa-ONNX | Apache‑2.0 | https://github.com/advimman/lama |
| PP-OCR (PaddleOCR) vía RapidOCR — **incluido en el APK y en el escritorio** | Apache‑2.0 | https://github.com/RapidAI/RapidOCR (texto en `apps/mobile/public/models/PPOCR-*`) |
| Qwen 3.5 (Alibaba), GGUF de unsloth | Apache‑2.0 | https://huggingface.co/Qwen |
| Gemma 4 (Google), GGUF QAT | Apache‑2.0 según el catálogo; comprobar la licencia del repositorio | https://huggingface.co/google |
| Cualquier otro modelo del buscador de Hugging Face | **La que declare su repositorio**; la app la muestra y la clasifica (permisiva / restringida / desconocida) antes de instalar | — |

Sobre el detector (GPL‑3.0): no se redistribuye con la aplicación; lo descarga cada usuario desde su publicación original
y la app lo trata como un componente independiente que se carga en tiempo de ejecución. Si redistribuyes STARBLITZ junto con
ese archivo, tu distribución debe cumplir la GPL‑3.0 para ese componente.

## Software incluido

| Componente | Licencia | Dónde |
|---|---|---|
| llama.cpp (`llama-server`, ggml) — versión b12017 | MIT (`apps/mobile/android/app/vendor/LLAMA-CPP-LICENSE.txt`) | Escritorio (Vulkan) y Android (arm64) |
| ONNX Runtime / ONNX Runtime Web (+ DirectML) | MIT | Escritorio y móvil |
| OpenCV.js / OpenCV | Apache‑2.0 | Móvil / escritorio |
| Electron / Chromium | MIT / BSD y otras (`LICENSES.chromium.html`) | Escritorio |
| CPython (python-build-standalone) | PSF | Escritorio |
| FastAPI, Starlette, Uvicorn, Pydantic, HTTPX | MIT / BSD | Escritorio |
| NumPy, Pillow, pypdfium2 (PDFium), psutil, Shapely, pyclipper | BSD / Apache‑2.0 / HPND | Escritorio |
| React, Zustand, Lucide, pdf-lib, fflate | MIT / ISC | Ambos |
| pdf.js (`pdfjs-dist`) | Apache‑2.0 | Móvil |
| Capacitor | MIT | Móvil |
| Ollama / LM Studio (opcionales, instalación aparte) | MIT / propietario | Solo si el usuario los configura |

## Tipografías (SIL Open Font License 1.1)

Shantell Sans, Comic Neue, Bangers, Patrick Hand, Barlow Semi Condensed, Sora, Manrope y Orbitron (logotipo, convertido a
trazados).
