#!/usr/bin/env bash
# Prueba de extremo a extremo de STARBLITZ Mobile en Chromium (modo navegador).
#
#   REAL:      interfaz, importación, descarga del detector con SHA-256, detector de texto y OCR PP-OCR en WebAssembly (con hilos,
#              página aislada como en el WebView), reconstrucción del fondo, editor, exportación.
#   SIMULADO:  el modelo de lenguaje (servidor compatible con OpenAI interceptado por Playwright) y el plugin nativo de Android.
#   NO CUBRE:  APK, llama.cpp en arm64, Manga OCR/LaMa, hardware físico (ver docs/PRUEBAS.md).
#
# Requisitos: node (con `playwright` y Chromium), python3 con Pillow, openssl, curl y una fuente CJK.
# Uso: bash apps/mobile/e2e/run.sh [carpeta_de_trabajo]      (por defecto .cache/e2e)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE="$(dirname "$HERE")"
WORK="${1:-$MOBILE/../../.cache/e2e}"
PORT="${E2E_PORT:-5198}"
DETECTOR_URL="https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt.onnx"
DETECTOR_SHA256="1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f"
mkdir -p "$WORK/data/models/text-detector" "$WORK/pages" "$WORK/certs"; WORK="$(cd "$WORK" && pwd)"

echo "▶ Compilación de la app para pruebas (VITE_E2E=1 expone el motor a la prueba)"
(cd "$MOBILE" && VITE_E2E=1 npx vite build --outDir dist-e2e >/dev/null)

echo "▶ Detector de texto (se descarga una vez; se comprueba su SHA-256)"
if ! echo "$DETECTOR_SHA256  $WORK/data/detector.onnx" | sha256sum -c - >/dev/null 2>&1; then
  curl -fL --retry 4 -o "$WORK/data/detector.onnx" "$DETECTOR_URL"
  echo "$DETECTOR_SHA256  $WORK/data/detector.onnx" | sha256sum -c -
fi

ln -sf ../../detector.onnx "$WORK/data/models/text-detector/comictextdetector.onnx"   # como la guarda la app en el teléfono

echo "▶ Páginas sintéticas y certificado local"
python3 "$HERE/make_pages.py" "$WORK/pages"
[ -f "$WORK/certs/cert.pem" ] || openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=127.0.0.1 -addext "subjectAltName=IP:127.0.0.1" \
  -keyout "$WORK/certs/key.pem" -out "$WORK/certs/cert.pem" 2>/dev/null

echo "▶ Servidor estático con COOP/COEP (como el WebView) y prueba"
TLS=1 CERT_DIR="$WORK/certs" DATA_DIR="$WORK/data" node "$HERE/serve.mjs" "$MOBILE/dist-e2e" "$PORT" >"$WORK/serve.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do grep -q listo "$WORK/serve.log" 2>/dev/null && break; sleep 0.2; done
export E2E_PORT="$PORT"
echo "── 1/2  Aplicación completa (interfaz + motor en la página)"
node "$HERE/e2e.mjs" "$WORK" | tee "$WORK/e2e.log"
echo "── 2/2  Camino de Android: motor de visión en Web Worker con hilos"
node "$HERE/worker.mjs" "$WORK" "$MOBILE/dist-e2e" | tee "$WORK/worker.log"
