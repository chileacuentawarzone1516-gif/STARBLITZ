#!/usr/bin/env bash
# Genera STARBLITZ-Setup-<versión>.exe a partir de la aplicación portátil (scripts/build-windows.sh).
# Usa makensis (NSIS 3) para Linux/Windows; no necesita Wine.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${SRC:-$ROOT/dist/STARBLITZ-win-x64}"
VERSION="$(node -p "require('$ROOT/apps/desktop/package.json').version")"
# Versión numérica X.Y.Z para el recurso de versión de Windows: admite estables (1.0.0) y prereleases (1.1.0-rc.1, 1.1.0+build).
VERSION_NUM="${VERSION%%[-+]*}"
[[ "$VERSION_NUM" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "La versión «$VERSION» debe empezar por X.Y.Z"; exit 1; }
OUTFILE="${OUTFILE:-$ROOT/dist/STARBLITZ-Setup-$VERSION.exe}"
NSIS_HOME="${NSIS_HOME:-$HOME/.cache/electron-builder/nsis/nsis-3.0.4.1}"
if [ ! -d "$NSIS_HOME" ]; then
  mkdir -p "$(dirname "$NSIS_HOME")"
  curl -fL -o /tmp/nsis.7z https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z
  # 7za viene con electron-builder (paquete 7zip-bin, instalado por `npm ci`); se resuelve desde la raíz, no desde la carpeta de caché.
  SEVENZ="$(command -v 7za || command -v 7z || node -p "require(require.resolve('7zip-bin', { paths: ['$ROOT'] })).path7za")"
  chmod +x "$SEVENZ" 2>/dev/null || true
  "$SEVENZ" x -y "-o$NSIS_HOME" /tmp/nsis.7z >/dev/null   # el 7z contiene Bin/, Contrib/, linux/… en su raíz
fi
case "$(uname -s)" in
  Linux*) MAKENSIS="$NSIS_HOME/linux/makensis" ;;
  Darwin*) MAKENSIS="$NSIS_HOME/mac/makensis" ;;
  *) MAKENSIS="$NSIS_HOME/Bin/makensis.exe" ;;
esac
chmod +x "$MAKENSIS" 2>/dev/null || true
NSISDIR="$NSIS_HOME" "$MAKENSIS" -V2 \
  -DVERSION="$VERSION" -DVERSION_NUM="$VERSION_NUM" -DSRC="$SRC" -DOUTFILE="$OUTFILE" \
  -DICON="$ROOT/brand/starblitz.ico" -DLICENSE="$ROOT/LICENSE" \
  "$ROOT/scripts/nsis/installer.nsi"
ls -lh "$OUTFILE"
