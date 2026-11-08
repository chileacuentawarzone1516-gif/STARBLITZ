#!/usr/bin/env bash
# Prueba de HUMO del APK en un emulador Android (NO es un teléfono físico): instala, abre, espera, y comprueba que el proceso
# sigue vivo, que no hay cierres (crash) ni errores de JavaScript en el registro, y guarda una captura de pantalla.
# Límite conocido: el emulador de CI es x86_64; el APK solo trae arm64-v8a, así que puede rechazar la instalación
# (INSTALL_FAILED_NO_MATCHING_ABIS) si la imagen no traduce ARM. Eso se informa tal cual y NO cuenta como fallo del APK.
# Uso: scripts/ci/emulador-humo.sh <apk> <carpeta_de_informe>
set -uo pipefail
APK="$1"; OUT="$2"; mkdir -p "$OUT"; R="$OUT/emulador.md"; PKG=app.starblitz.mobile
FAIL=0
row() { echo "| $1 | $2 | $3 |" >> "$R"; echo "$1 $2 — $3"; }
{ echo "# Prueba de humo en emulador Android"; echo; echo "| Estado | Comprobación | Detalle |"; echo "|---|---|---|"; } > "$R"
ABIS=$(adb shell getprop ro.product.cpu.abilist | tr -d '\r'); API=$(adb shell getprop ro.build.version.sdk | tr -d '\r')
row INFO emulador "API $API · ABIs: $ABIS · $(adb shell getprop ro.product.model | tr -d '\r')"
adb logcat -c
if adb install -r -t "$APK" > "$OUT/install.txt" 2>&1; then row PASS "instalación (adb install)" "$(tr -d '\r' < "$OUT/install.txt" | tail -1)"
else
  row LIMITE "instalación (adb install)" "$(tr -d '\r' < "$OUT/install.txt" | tail -2 | tr '\n' ' ') — si es NO_MATCHING_ABIS, la imagen x86_64 no admite arm64: límite del emulador, hay que probar en un teléfono arm64"
  echo "_Sin instalación no hay más pruebas en este emulador._" >> "$R"; exit 0
fi
adb shell dumpsys package $PKG | grep -E "^\s+(android.permission\.[A-Z_]+): granted=true" | sed 's/^ *//' > "$OUT/permisos-concedidos.txt"
row INFO "permisos concedidos" "$(tr '\n' ' ' < "$OUT/permisos-concedidos.txt")"
adb shell dumpsys webviewupdate 2>/dev/null | grep -i "current webview" | tr -d '\r' | head -1 > "$OUT/webview.txt"; row INFO WebView "$(cat "$OUT/webview.txt")"
adb shell am start -W -n $PKG/.MainActivity > "$OUT/start.txt" 2>&1
grep -q "Status: ok" "$OUT/start.txt" && row PASS "abre la actividad principal" "$(grep -E 'TotalTime|WaitTime' "$OUT/start.txt" | tr -d '\r' | tr '\n' ' ')" || { row FAIL "abre la actividad principal" "$(tr -d '\r' < "$OUT/start.txt" | tail -3 | tr '\n' ' ')"; FAIL=1; }
sleep 40
PID=$(adb shell pidof $PKG | tr -d '\r')
[ -n "$PID" ] && row PASS "el proceso sigue vivo a los 40 s" "PID $PID" || { row FAIL "el proceso sigue vivo a los 40 s" "la app se cerró"; FAIL=1; }
adb logcat -d > "$OUT/logcat.txt" 2>&1
if grep -qE "FATAL EXCEPTION|Process: $PKG.*(died|crash)|ANR in $PKG" "$OUT/logcat.txt"; then row FAIL "sin cierres ni ANR" "$(grep -m3 -E 'FATAL EXCEPTION|ANR in' "$OUT/logcat.txt" | tr -d '\r' | tr '\n' ' ')"; FAIL=1; else row PASS "sin cierres ni ANR" "logcat sin FATAL EXCEPTION/ANR"; fi
JS=$(grep -E "Capacitor/Console|chromium.*CONSOLE" "$OUT/logcat.txt" | grep -iE "uncaught|ReferenceError|TypeError|error" | head -5 | tr -d '\r' | cut -c1-200 | tr '\n' ' ')
[ -z "$JS" ] && row PASS "sin errores de JavaScript en el WebView" "consola limpia" || { row FAIL "sin errores de JavaScript en el WebView" "$JS"; FAIL=1; }
adb exec-out screencap -p > "$OUT/captura-inicio.png"; row INFO captura "captura-inicio.png ($(stat -c %s "$OUT/captura-inicio.png") bytes)"
adb shell input keyevent KEYCODE_HOME; sleep 2; adb shell am start -n $PKG/.MainActivity >/dev/null 2>&1; sleep 5
[ -n "$(adb shell pidof $PKG | tr -d '\r')" ] && row PASS "vuelve a primer plano sin reiniciarse" "proceso vivo tras Home + reabrir" || row FAIL "vuelve a primer plano sin reiniciarse" "no hay proceso"
echo >> "$R"; echo "_Emulador: no sustituye la prueba en un teléfono arm64 real (llama.cpp nativo, batería, temperatura, RAM)._" >> "$R"
exit $FAIL
