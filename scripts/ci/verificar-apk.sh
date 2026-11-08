#!/usr/bin/env bash
# Verificación ESTÁTICA del APK de STARBLITZ (no ejecuta la app): firma, manifiesto, permisos, ABIs, contenido y
# dependencias nativas de llama-server. Que esto pase NO prueba que la app funcione en un teléfono (eso es hardware
# físico y figura como pendiente en docs/PRUEBAS-HARDWARE.md).
# Uso: scripts/ci/verificar-apk.sh <apk> <carpeta_de_informe>
set -uo pipefail
APK="$1"; OUT="$2"; mkdir -p "$OUT"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BT="$(ls -d "${ANDROID_HOME:?}"/build-tools/* | sort -V | tail -1)"
FAIL=0; REPORT="$OUT/apk-verificacion.md"
ok()   { echo "| PASS | $1 | $2 |" >> "$REPORT"; echo "OK    $1 — $2"; }
bad()  { echo "| FAIL | $1 | $2 |" >> "$REPORT"; echo "FALLO $1 — $2"; FAIL=1; }
chk()  { if [ "$2" = ok ]; then ok "$1" "$3"; else bad "$1" "$3"; fi; }
{ echo "# Verificación estática del APK"; echo; echo "| Estado | Comprobación | Detalle |"; echo "|---|---|---|"; } > "$REPORT"

SIZE=$(stat -c %s "$APK"); SHA=$(sha256sum "$APK" | cut -d' ' -f1)
ok "archivo" "$(basename "$APK") · $(awk -v s="$SIZE" 'BEGIN{printf "%.1f MB", s/1048576}') · SHA-256 $SHA"

"$BT/apksigner" verify --verbose --print-certs "$APK" > "$OUT/apksigner.txt" 2>&1 && chk "firma" ok "apksigner verify correcto: $(grep -m1 'Signer #1 certificate DN' "$OUT/apksigner.txt" | cut -c1-120)" || chk "firma" bad "apksigner falló (ver apksigner.txt)"
"$BT/aapt2" dump badging "$APK" > "$OUT/badging.txt" 2>&1
grep -q "^package: name='app.starblitz.mobile'" "$OUT/badging.txt" && chk "paquete" ok "$(grep -m1 '^package:' "$OUT/badging.txt" | cut -c1-140)" || chk "paquete" bad "nombre de paquete inesperado"
grep -q "^sdkVersion:'28'" "$OUT/badging.txt" && chk "Android mínimo" ok "minSdk 28 (Android 9), target $(grep -o "targetSdkVersion:'[0-9]*'" "$OUT/badging.txt")" || chk "Android mínimo" bad "minSdk distinto de 28"
ABIS=$(grep -m1 '^native-code:' "$OUT/badging.txt")
[ "$ABIS" = "native-code: 'arm64-v8a'" ] && chk "ABIs" ok "solo arm64-v8a" || chk "ABIs" bad "${ABIS:-sin código nativo}"
PERMS=$(grep "^uses-permission" "$OUT/badging.txt" | sed -E "s/.*name='([^']+)'.*/\1/" | sort | tr '\n' ' ')
[ "$PERMS" = "android.permission.ACCESS_NETWORK_STATE android.permission.INTERNET " ] && chk "permisos" ok "solo INTERNET y ACCESS_NETWORK_STATE" || chk "permisos" bad "permisos inesperados: $PERMS"
"$BT/aapt2" dump xmltree --file AndroidManifest.xml "$APK" > "$OUT/manifest.txt" 2>&1
grep -q 'allowBackup.*=false\|allowBackup.*0x0' "$OUT/manifest.txt" && chk "copia de seguridad en la nube" ok "allowBackup=false" || chk "copia de seguridad en la nube" bad "allowBackup no está desactivado"
grep -q networkSecurityConfig "$OUT/manifest.txt" && chk "tráfico en claro" ok "networkSecurityConfig presente (solo 127.0.0.1/localhost en claro)" || chk "tráfico en claro" bad "sin networkSecurityConfig"

LIST="$OUT/contenido.txt"; unzip -l "$APK" > "$LIST"
for f in assets/public/index.html assets/public/ort/ort-wasm-simd-threaded.mjs assets/public/ort/ort-wasm-simd-threaded.wasm assets/public/models/ppocr-rec.onnx lib/arm64-v8a/libllama-server-exe.so; do
  grep -q " $f\$" "$LIST" && chk "incluye $f" ok "presente" || chk "incluye $f" bad "AUSENTE"
done
N=$(grep -c ' lib/arm64-v8a/.*\.so$' "$LIST"); EXPECT=$(grep -c . "$ROOT/apps/mobile/android/app/vendor/llama-libs.sha256")
[ "$N" -eq "$EXPECT" ] && chk "bibliotecas llama.cpp" ok "$N archivos .so arm64 (los $EXPECT esperados)" || chk "bibliotecas llama.cpp" bad "$N .so frente a $EXPECT esperados"
grep -qE ' lib/(x86|x86_64|armeabi)' "$LIST" && chk "sin otras arquitecturas" bad "hay bibliotecas x86/armeabi" || chk "sin otras arquitecturas" ok "solo arm64-v8a"
[ "$(grep -c '\.onnx$' "$LIST")" -eq 1 ] && chk "pesos de modelos en el APK" ok "solo el OCR PP-OCR (ppocr-rec.onnx); detector, Manga OCR, LaMa y LLM se descargan en el teléfono" || chk "pesos de modelos en el APK" bad "hay más .onnx de los previstos"
W="$(mktemp -d)"; unzip -q -o "$APK" 'assets/public/assets/*.js' 'lib/arm64-v8a/*' -d "$W" 2>/dev/null
grep -rqs '__sb' "$W/assets/public/assets" && chk "sin gancho E2E" bad "el JS contiene __sb (compilado con VITE_E2E)" || chk "sin gancho E2E" ok "no hay window.__sb en la interfaz de producción"
( cd "$W/lib/arm64-v8a" && sha256sum -c "$ROOT/apps/mobile/android/app/vendor/llama-libs.sha256" > "$OUT/hash-libs.txt" 2>&1 ) && chk "integridad de llama.cpp en el APK" ok "SHA-256 de las $EXPECT bibliotecas = vendor/llama-libs.sha256" || chk "integridad de llama.cpp en el APK" bad "hashes distintos (ver hash-libs.txt)"

EXE="$W/lib/arm64-v8a/libllama-server-exe.so"
M=$(readelf -h "$EXE" 2>/dev/null | awk -F: '/Machine/{gsub(/^ +/,"",$2);print $2}')
[ "$M" = "AArch64" ] && chk "llama-server es AArch64" ok "ELF $M" || chk "llama-server es AArch64" bad "máquina: $M"
NEEDED=$( { readelf -d "$EXE"; for l in "$W"/lib/arm64-v8a/lib*.so; do readelf -d "$l"; done; } 2>/dev/null | sed -n 's/.*NEEDED.*\[\(.*\)\]/\1/p' | sort -u)
SYSTEM="libc.so libm.so libdl.so liblog.so libandroid.so libz.so libvulkan.so libOpenSLES.so libEGL.so libGLESv2.so libGLESv3.so libnativewindow.so libomp.so"
MISSING=""
for n in $NEEDED; do [ -f "$W/lib/arm64-v8a/$n" ] || echo " $SYSTEM " | grep -q " $n " || MISSING="$MISSING $n"; done
[ -z "$MISSING" ] && chk "dependencias nativas resueltas" ok "todo NEEDED está en el APK o es del sistema Android: $(echo $NEEDED | tr '\n' ' ')" || chk "dependencias nativas resueltas" bad "faltan en el APK y no son del sistema:$MISSING"
echo >> "$REPORT"; echo "_Verificación estática: no sustituye la prueba en un teléfono arm64 real._" >> "$REPORT"
rm -rf "$W"; exit $FAIL
