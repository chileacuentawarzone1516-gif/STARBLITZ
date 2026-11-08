#!/usr/bin/env bash
# Incluye en la app el OCR multilingüe PP-OCR (PaddleOCR, Apache-2.0), que se usa sin descargar nada.
#
#  - Descarga el paquete oficial `rapidocr` de PyPI (versión fijada) y comprueba su SHA-256.
#  - Extrae solo el reconocedor (≈21 MB, con su diccionario en los metadatos) y comprueba también su huella.
#  - Lo deja en apps/mobile/public/models/ppocr-rec.onnx (Vite lo copia al APK) junto a su licencia.
#
# Es idempotente: si el archivo ya está y su huella coincide, no hace nada.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="3.10.0"
WHEEL_URL="https://files.pythonhosted.org/packages/59/07/203065283bba0c5e9c10af3602dc25ab3e59ee54dc2d1d22c8faeabf5ed8/rapidocr-${VERSION}-py3-none-any.whl"
WHEEL_SHA256="2fc34e26cd0f48514804a94f8832283039c7334076bff60768b1fed9ad068050"
MODEL_IN_WHEEL="rapidocr/models/PP-OCRv6_rec_small.onnx"
MODEL_SHA256="6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884"
OUT_DIR="${OUT_DIR:-$ROOT/apps/mobile/public/models}"
OUT="$OUT_DIR/ppocr-rec.onnx"

if [ -f "$OUT" ] && echo "${MODEL_SHA256}  $OUT" | sha256sum -c - >/dev/null 2>&1; then
  echo "OCR PP-OCR ya preparado: $OUT"; exit 0
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
curl -fL --retry 4 --retry-delay 3 -o "$WORK/rapidocr.whl" "$WHEEL_URL"
echo "${WHEEL_SHA256}  $WORK/rapidocr.whl" | sha256sum -c - >/dev/null || { echo "El SHA-256 del paquete rapidocr no coincide"; exit 1; }
mkdir -p "$OUT_DIR"
unzip -q -o -j "$WORK/rapidocr.whl" "$MODEL_IN_WHEEL" -d "$WORK/m"
echo "${MODEL_SHA256}  $WORK/m/$(basename "$MODEL_IN_WHEEL")" | sha256sum -c - >/dev/null || { echo "El SHA-256 del modelo PP-OCR no coincide"; exit 1; }
mv "$WORK/m/$(basename "$MODEL_IN_WHEEL")" "$OUT"
unzip -q -o -j "$WORK/rapidocr.whl" "rapidocr-${VERSION}.dist-info/licenses/LICENSE" "rapidocr-${VERSION}.dist-info/licenses/MODEL_LICENSES.md" -d "$WORK/l"
cp "$WORK/l/LICENSE" "$OUT_DIR/PPOCR-LICENSE.txt"
cp "$WORK/l/MODEL_LICENSES.md" "$OUT_DIR/PPOCR-MODEL-LICENSES.md"
echo "OCR PP-OCR listo: $OUT ($(du -h "$OUT" | cut -f1))"
