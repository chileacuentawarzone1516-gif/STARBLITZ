#!/usr/bin/env bash
# Compila STARBLITZ Desktop para Windows x64 como aplicación portátil autocontenida:
#   Electron + interfaz + motor Python embebido (python-build-standalone) + dependencias.
# Funciona en Linux, WSL o GitHub Actions (también en Git Bash de Windows con Node y Python).
#
# Variables opcionales:
#   OUT=dist/STARBLITZ-win-x64   carpeta de salida
#   PORTABLE=1                   guarda los datos junto al ejecutable (carpeta data/)
#   SKIP_UI_BUILD=1              usa la interfaz ya compilada en apps/desktop/dist
#   ZIP=1                        crea también STARBLITZ-win-x64.zip
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${OUT:-$ROOT/dist/STARBLITZ-win-x64}"
CACHE="${CACHE:-$ROOT/.cache/build}"
PY_TAG="20260718"
PY_VERSION="3.12.13"
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_TAG}/cpython-${PY_VERSION}%2B${PY_TAG}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
ELECTRON_VERSION="$(node -p "require('$ROOT/apps/desktop/package.json').devDependencies.electron")"
ELECTRON_URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-win32-x64.zip"
APP_VERSION="$(node -p "require('$ROOT/apps/desktop/package.json').version")"
LLAMA_TAG="b12017"
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip"
LLAMA_SHA256="e3d43788fed7b2e5983320975cb21d91fbc2579698a497f0f8cecbe9c029312b"
PIP="${PIP:-python3 -m pip}"
# SHA-256 oficiales: Electron (SHASUMS256.txt de su Release) y python-build-standalone (SHA256SUMS de su Release).
# Al subir de versión hay que actualizar el hash: si falta, la compilación se detiene en vez de empaquetar algo sin comprobar.
PY_SHA256="0d422a1439ec308e03f47df551bc30f5994727c456e414b026d202bcda9b7c1c"
case "$ELECTRON_VERSION" in
  38.2.0) ELECTRON_SHA256="4382b317dbbbc0bbf8a301304749324b88207218aac240b670f1c1247c2a02b0" ;;
  *) echo "Falta el SHA-256 de Electron ${ELECTRON_VERSION} (win32-x64) en scripts/build-windows.sh"; exit 1 ;;
esac

step() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
fetch() { # fetch URL DESTINO SHA256 (con caché y reanudación; la copia en caché también se comprueba)
  if [ ! -s "$2" ]; then
    curl -fL --retry 4 --retry-delay 3 -C - -o "$2.part" "$1"
    mv "$2.part" "$2"
  fi
  echo "$3  $2" | sha256sum -c - >/dev/null \
    || { echo "El SHA-256 de $(basename "$2") no coincide: se borra la copia en caché."; rm -f "$2"; exit 1; }
}

mkdir -p "$CACHE"

if [ "${SKIP_UI_BUILD:-0}" != "1" ]; then
  step "Compilando interfaz y proceso principal"
  (cd "$ROOT/apps/desktop" && npx vite build && node electron/build.mjs)
fi
[ -f "$ROOT/apps/desktop/dist/index.html" ] || { echo "Falta apps/desktop/dist (compila la interfaz)"; exit 1; }
[ -f "$ROOT/apps/desktop/dist-electron/main.cjs" ] || { echo "Falta dist-electron (node electron/build.mjs)"; exit 1; }

step "Electron ${ELECTRON_VERSION} (win32-x64)"
fetch "$ELECTRON_URL" "$CACHE/electron-${ELECTRON_VERSION}-win32-x64.zip" "$ELECTRON_SHA256"
rm -rf "$OUT"
mkdir -p "$OUT"
unzip -q "$CACHE/electron-${ELECTRON_VERSION}-win32-x64.zip" -d "$OUT"
mv "$OUT/electron.exe" "$OUT/STARBLITZ.exe"
rm -f "$OUT/resources/default_app.asar"

step "Código de la aplicación"
APP="$OUT/resources/app"
mkdir -p "$APP"
cp -r "$ROOT/apps/desktop/dist-electron" "$APP/"
node -e "
const p=require('$ROOT/apps/desktop/package.json');
require('fs').writeFileSync('$APP/package.json', JSON.stringify({name:'starblitz',productName:'STARBLITZ',version:p.version,description:p.description,main:'dist-electron/main.cjs',author:p.author},null,1));"
cp -r "$ROOT/apps/desktop/dist" "$OUT/resources/ui"

step "Python ${PY_VERSION} embebido"
fetch "$PY_URL" "$CACHE/cpython-${PY_VERSION}-win64.tar.gz" "$PY_SHA256"
mkdir -p "$OUT/resources/engine"
tar -xzf "$CACHE/cpython-${PY_VERSION}-win64.tar.gz" -C "$OUT/resources/engine"
SITE="$OUT/resources/engine/python/Lib/site-packages"
rm -rf "$OUT/resources/engine/python/Lib/test" "$OUT/resources/engine/python/Lib/idlelib" "$OUT/resources/engine/python/Lib/tkinter" \
       "$OUT/resources/engine/python/tcl" "$OUT/resources/engine/python/include"

step "Dependencias del motor (wheels win_amd64)"
PIPW="$PIP install --quiet --no-compile --target $SITE --platform win_amd64 --python-version 3.12 --implementation cp --only-binary=:all: --upgrade"
$PIPW -r "$ROOT/engine/requirements.txt" "onnxruntime-directml==1.24.4"
$PIPW --no-deps "rapidocr==3.10.0"
# Recortes seguros: utilidades de desarrollo de onnxruntime (sympy) y el códec de vídeo de OpenCV no se usan.
rm -rf "$SITE"/sympy* "$SITE"/mpmath* "$SITE/bin" "$SITE"/cv2/opencv_videoio_ffmpeg*.dll
rm -rf "$OUT/resources/engine/python/Lib/site-packages/pip" "$OUT/resources/engine/python/Lib/site-packages"/pip-*.dist-info
find "$SITE" -name "__pycache__" -type d -prune -exec rm -rf {} +

step "Motor STARBLITZ"
mkdir -p "$OUT/resources/engine/app"
(cd "$ROOT/engine" && tar --exclude='__pycache__' --exclude='*.pyc' -cf - starblitz_engine) | tar -xf - -C "$OUT/resources/engine/app"

step "llama.cpp ${LLAMA_TAG} (servidor de modelos de lenguaje con Vulkan)"
# Servidor oficial de llama.cpp, fijado por versión y comprobado por SHA-256: es lo que ejecuta la traducción en local.
fetch "$LLAMA_URL" "$CACHE/llama-${LLAMA_TAG}-win-vulkan-x64.zip" "$LLAMA_SHA256"
LLAMA_OUT="$OUT/resources/llama"
mkdir -p "$LLAMA_OUT"
unzip -q -o "$CACHE/llama-${LLAMA_TAG}-win-vulkan-x64.zip" -d "$LLAMA_OUT"
# Solo lo necesario para servir modelos: fuera las herramientas de línea de comandos y el backend RPC.
( cd "$LLAMA_OUT" && find . -maxdepth 1 -type f \( -name 'llama-*.exe' -o -name 'ggml-rpc*' -o -name 'llama.exe' \) ! -name 'llama-server.exe' -delete \
  && find . -maxdepth 1 -type f -name 'llama-*-impl.dll' ! -name 'llama-server-impl.dll' -delete )
[ -f "$LLAMA_OUT/llama-server.exe" ] || { echo "Falta llama-server.exe en el paquete de llama.cpp"; exit 1; }

step "Icono y datos de versión del ejecutable"
if ! node -e "require.resolve('resedit')" 2>/dev/null; then
  mkdir -p "$CACHE/tools" && (cd "$CACHE/tools" && npm install --silent --no-audit --no-fund resedit@2.0.3 pe-library@1.0.1 >/dev/null)
  export SB_TOOLS="$CACHE/tools/node_modules"
fi
node "$ROOT/scripts/set-exe-icon.mjs" "$OUT/STARBLITZ.exe" "$ROOT/brand/starblitz.ico" "$APP_VERSION"

cp "$ROOT/LICENSE" "$OUT/LICENSE.txt" 2>/dev/null || true
cp "$ROOT/docs/LICENCIAS-TERCEROS.md" "$OUT/LICENCIAS-TERCEROS.md" 2>/dev/null || true
if [ "${PORTABLE:-0}" = "1" ]; then
  echo "Modo portátil: los datos se guardan en la carpeta data junto al ejecutable." > "$OUT/portable.txt"
fi

if [ "${ZIP:-0}" = "1" ]; then
  step "Comprimiendo"
  (cd "$(dirname "$OUT")" && rm -f "$(basename "$OUT").zip" && zip -qr -9 "$(basename "$OUT").zip" "$(basename "$OUT")")
fi

du -sh "$OUT" | awk '{print "Tamaño total: " $1}'
echo "Listo: $OUT/STARBLITZ.exe"
