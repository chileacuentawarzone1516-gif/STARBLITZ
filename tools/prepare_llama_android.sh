#!/usr/bin/env bash
# Prepara el motor de lenguaje (llama.cpp) que viaja dentro del APK de Android.
#
#  - Descarga la versión fijada del servidor oficial para Android arm64 y comprueba su SHA-256.
#  - Se queda solo con lo que necesita `llama-server` (fuera las herramientas de línea de comandos y el backend RPC).
#  - Quita los símbolos de depuración (255 MB → 28 MB): sin ello el APK pesaría casi 100 MB más.
#  - Cambia el nombre a lib*.so: Android solo extrae como ejecutables los archivos con ese nombre.
#
# Resultado: apps/mobile/android/app/src/main/jniLibs/arm64-v8a/  y  apps/mobile/android/app/vendor/llama-libs.sha256
# Requisitos: curl, tar, llvm-strip (paquete llvm) o strip con soporte aarch64.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="b12017"
URL="https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/llama-${TAG}-bin-android-arm64.tar.gz"
SHA256="6c122a8448c468038d00996760afe6cf30d03cbaffcc4bbe585e127d037a9c59"
WORK="${WORK:-$(mktemp -d)}"
OUT="$ROOT/apps/mobile/android/app/src/main/jniLibs/arm64-v8a"
STRIP="$(command -v llvm-strip || command -v strip)"

curl -fL --retry 4 -o "$WORK/llama.tar.gz" "$URL"
echo "${SHA256}  $WORK/llama.tar.gz" | sha256sum -c -
tar -xzf "$WORK/llama.tar.gz" -C "$WORK"
SRC="$WORK/llama-${TAG}"
rm -rf "$OUT" && mkdir -p "$OUT"
for f in libllama-server-impl.so libllama-common.so libmtmd.so libllama.so libggml.so libggml-base.so "$SRC"/libggml-cpu-android_*.so; do
  cp "$SRC/$(basename "$f")" "$OUT/$(basename "$f")"
done
cp "$SRC/llama-server" "$OUT/libllama-server-exe.so"
"$STRIP" --strip-unneeded "$OUT"/*.so
( cd "$OUT" && sha256sum *.so > "$ROOT/apps/mobile/android/app/vendor/llama-libs.sha256" )
du -sh "$OUT"
cp "$SRC/LICENSE" "$ROOT/apps/mobile/android/app/vendor/LLAMA-CPP-LICENSE.txt"
echo "Listo."
