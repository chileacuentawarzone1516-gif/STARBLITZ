# Compilar

## Requisitos de desarrollo

- Node.js 20+ (probado con 22) y npm.
- Python 3.12+ (probado con 3.12 y 3.14; numpy 2.5 exige 3.12) para el motor y las pruebas.
- APK: JDK 21 y Android SDK 35 (el script de Windows los descarga solos). JDK cualquiera para las pruebas nativas.

```bash
npm ci                                   # dependencias de las apps
python -m venv .venv && .venv/bin/pip install -r engine/requirements.txt onnxruntime pytest onnx
.venv/bin/pip install --no-deps rapidocr==3.10.0
```

## Pruebas y tipos

```bash
npm run typecheck                        # shared + desktop + mobile
npm test                                 # shared (30) + mobile (274) + desktop (6)
cd engine && ../.venv/bin/python -m pytest -q     # 131 (19 requieren modelos o páginas reales)
bash apps/mobile/e2e/run.sh              # E2E en Chromium (necesita playwright, Pillow, openssl y fuente CJK)
```

Los datos compartidos Python ↔ TypeScript (prompts, perfiles, casos de paridad, catálogo) se regeneran con
`tools/export_translate_fixtures.py`, `tools/export_llm_catalog.py`, `tools/export_vision_registry.py` y
`tools/export_glyph_metrics.py`; las pruebas
fallan si TypeScript y Python se desvían, y `ci.yml` regenera los cuatro y falla si algún JSON del repo está desfasado.

## Ejecutar en desarrollo

```bash
# Escritorio: motor + interfaz en el navegador
cd engine && STARBLITZ_TOKEN=dev python -m starblitz_engine --port 47811 --ui-dir ../apps/desktop/dist
#   http://127.0.0.1:47811/?token=dev        o como app Electron:  cd apps/desktop && npm run build && npx electron .
# Móvil en el navegador (OPFS, visión en la página; sin llama.cpp): cd apps/mobile && npx vite
```

## Windows

```bash
bash scripts/build-windows.sh              # → dist/STARBLITZ-win-x64/ (portátil autocontenido)
PORTABLE=1 bash scripts/build-windows.sh   # datos junto al ejecutable
bash scripts/build-installer.sh            # → dist/STARBLITZ-Setup-1.0.0.exe (NSIS, sin Wine)
```

Descarga Electron, Python 3.12 embebido, las ruedas `win_amd64` del motor (con `onnxruntime-directml`) y el
`llama-server` de llama.cpp con Vulkan (versión fijada, SHA-256 comprobado), copia interfaz y motor y pone icono y versión
al ejecutable. Funciona en Linux, WSL, Git Bash o CI.

> **Instalador canónico de Windows: NSIS directo** (`scripts/build-installer.sh` + `scripts/nsis/installer.nsi`, salida
> `dist/STARBLITZ-Setup-<versión>.exe`). Es el único que se valida y se publica: `windows.yml` lo genera y lo somete a
> `scripts/ci/probar-instalador.ps1`, y lo reutilizan `build.yml`, `validacion.yml` y `release.yml`. `electron-builder`
> sigue en `apps/desktop` solo como herramienta de desarrollo (`npm run dist:win`); no se usa en la publicación. Ni el
> instalador ni su prueba se han ejecutado todavía en un Windows real.
>
> La versión del instalador sale de `apps/desktop/package.json`. Admite versiones estables (`1.0.0`) y prerelease
> (`1.1.0-rc.1`): la versión numérica `X.Y.Z` del recurso de versión de Windows se obtiene quitando el sufijo.

## Android

El APK solo lleva `arm64-v8a`. Antes de compilar, los scripts verifican por SHA-256 estos componentes:

- `apps/mobile/android/app/src/main/jniLibs/arm64-v8a/*.so`: `llama-server` y bibliotecas de llama.cpp b12017,
  **versionadas en Git** junto con `app/vendor/llama-libs.sha256` y `app/vendor/LLAMA-CPP-LICENSE.txt`
  (regenerables con `tools/prepare_llama_android.sh`).
- `apps/mobile/public/models/ppocr-rec.onnx`: OCR PP-OCR. **No se versiona** (está en `.gitignore`): se regenera con
  `tools/prepare_ppocr.sh` (descarga con SHA-256 fijado). Los workflows lo ejecutan antes de compilar y
  `build-android.ps1` lo asegura y lo comprueba.
- `ort/ort-wasm-simd-threaded.{mjs,wasm}`: los copia `vite.config.ts` desde `onnxruntime-web` al compilar. **Deben ir como
  archivos propios**, no incrustados en el paquete: con hilos, ONNX Runtime arranca cada hilo con el script que cargó el
  módulo y, incrustado, arrancaría la aplicación entera y se quedaría colgado.

**Opción A — en tu PC con Windows (sin Android Studio):** doble clic en `scripts\Compilar-APK-Android.bat`
(o `powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 [-Install] [-SkipTests]`). Descarga JDK 21 y el SDK
en `.cache\android` (~1,5 GB la primera vez), verifica los componentes nativos, ejecuta las pruebas, compila y deja
`dist\STARBLITZ-android.apk` firmado con una clave propia (`.cache\android\starblitz.jks` + `keystore-password.txt`;
**guárdalos**: sin ellos no podrás publicar actualizaciones sobre la misma instalación).

**Opción B — GitHub Actions:** el workflow `build.yml` (manual) compila el APK y el instalador y los deja como
artefactos; el detalle de workflows, disparadores y nombres de artefactos está en [GitHub Actions](#github-actions).
Sin keystore genera un **APK de depuración** instalable; con él, un APK de producción firmado. Variables de firma y
alias: ver [Firma del APK](#firma-del-apk).

**Opción C — Android Studio:** `cd apps/mobile && npm run build && npx cap sync android`, abre `apps/mobile/android`.

> Esta documentación del APK describe los scripts, **no un resultado**: en la sesión de desarrollo no hubo acceso a
> Google Maven ni a `dl.google.com`, así que el APK no se compiló ni se instaló (ver [PRUEBAS](PRUEBAS.md)).

## Firma del APK

`apps/mobile/android/app/build.gradle` lee estas variables de entorno para firmar la variante `release`:

| Variable | Significado | Valor si falta |
|---|---|---|
| `SB_KEYSTORE` | Ruta del keystore (`.jks`) | El APK `release` queda **sin firmar** |
| `SB_KEYSTORE_PASSWORD` | Contraseña del almacén | — |
| `SB_KEY_ALIAS` | Alias de la clave | **`starblitz`** |
| `SB_KEY_PASSWORD` | Contraseña de la clave | La de `SB_KEYSTORE_PASSWORD` |

- `scripts\build-android.ps1` crea su clave con el alias `starblitz` y define las cuatro variables necesarias.
- En GitHub Actions, `build.yml` solo pasa `SB_KEYSTORE` (desde el secreto `ANDROID_KEYSTORE_B64`, en Base64) y
  `SB_KEYSTORE_PASSWORD` (desde `ANDROID_KEYSTORE_PASSWORD`). **No pasa `SB_KEY_ALIAS` ni `SB_KEY_PASSWORD`**: el
  keystore de producción debe usar el alias `starblitz` y la misma contraseña para el almacén y la clave. Para otro
  alias habría que ampliar el workflow.
- `release.yml` llama a `build.yml` con `require-signing: true`: si falta el secreto `ANDROID_KEYSTORE_B64`, el job falla y
  **no se crea el borrador**. Lanzado a mano sin esa opción, `build.yml` genera un APK de **depuración** (no apto para publicar).
- `validacion.yml` firma con una clave **desechable** de CI (alias `starblitz`); su APK sirve para validar, no para publicar.
- Guarda el keystore fuera del repositorio: sin él no podrás publicar actualizaciones sobre la misma instalación.

## Versiones

La versión del producto es **una sola**: la de `package.json` (hoy `1.0.0`). Deben coincidir con ella `apps/desktop`,
`apps/mobile` y `apps/shared` (`package.json`), `engine/starblitz_engine/__init__.py`, `engine/pyproject.toml` y el
`versionName` de Android (`apps/mobile/android/app/build.gradle`); `scripts/ci/verificar-repo.sh` lo comprueba y
`release.yml` exige además que la etiqueta `vX.Y.Z` sea esa versión. El `versionCode` de Android es un entero que **solo
debe crecer** con cada APK publicado (`1` en la 1.0.0). `ENGINE_VERSION` (`apps/mobile/src/engine/api/localEngine.ts`,
hoy `2.0.0`) es un valor aparte —la versión que responde `/health` del motor móvil— y no sigue a la del producto.

## GitHub Actions

Todos los workflows usan `contents: read`; solo `release.yml` pide `contents: write`, únicamente en el job que crea el
**borrador** de la Release. Las acciones de terceros están fijadas por SHA. Ningún workflow publica por sí solo.

| Workflow | Disparadores | Qué hace |
|---|---|---|
| `ci.yml` | `pull_request`, `push` a `main`, manual y `workflow_call` | `integridad` (`scripts/ci/verificar-repo.sh`) → `test` (motor, tipos, vitest, prueba nativa de Java) → `mobile-e2e` (Chromium) |
| `windows.yml` | Manual y `workflow_call` | **Instalador canónico (NSIS directo):** `compilar` (portátil, comprobación del contenido del motor Python, instalador, ZIP y huellas) → `probar-instalador` (descarga el mismo artefacto, verifica su SHA-256 y ejecuta `probar-instalador.ps1` en Windows) |
| `build.yml` | Manual (con la opción `require-signing`) y `workflow_call` | Llama a `windows.yml` y compila el APK (`android`); falla si falta un archivo obligatorio |
| `validacion.yml` | **Solo manual** | Validación completa por tipo de evidencia (simuladas, reales con modelos, APK, emulador y el instalador, vía `windows.yml`) e `INFORME` |
| `release.yml` | `push` de etiquetas `v*` | Comprueba etiqueta, versiones, CHANGELOG y `main`; ejecuta `ci.yml` y `build.yml` (firma obligatoria); crea un **borrador** solo si existen todos los archivos |

**Artefactos:**

| Artefacto | Origen | Contenido |
|---|---|---|
| `STARBLITZ-Windows` (30 días) | `windows.yml` | `STARBLITZ-Setup-<versión>.exe`, `STARBLITZ-win-x64-portable.zip` y `STARBLITZ-Setup.sha256` (SHA-256 del `.exe`) |
| `informe-windows-instalador` (14 días) | `windows.yml` | Informe de `probar-instalador.ps1` |
| `STARBLITZ-Android` (30 días) | `build.yml` | `STARBLITZ-android.apk` (depuración sin keystore; firmado con él) |

`validacion.yml` añade: `informe-simuladas`, `informe-motor-detector-real`, `informe-movil-e2e-chromium`,
`STARBLITZ-Android-APK` (contiene `STARBLITZ-android-arm64-CI.apk` y su `.sha256`; clave **desechable**),
`STARBLITZ-Android-APK-desde-bat`, `informe-emulador`, `informe-modelos-reales` e `INFORME`, además de los de `windows.yml`.

**Borrador de `release.yml`** (archivos adjuntos): `STARBLITZ-Setup-<versión>.exe`, `STARBLITZ-win-x64-portable.zip`,
`STARBLITZ-<versión>-android-arm64.apk` y `SHA256SUMS.txt`. **No se crea** si falta el `.exe`, el `.zip`, el `.apk` o la
huella del instalador, si el hash del `.exe` no coincide con el que compiló y probó `windows.yml`, o si la etiqueta no
coincide con las versiones. Las etiquetas con guion (p. ej. `v1.1.0-rc.1`) se marcan como *pre-release*. Para publicarlo
hay que revisarlo y pulsar *Publish* a mano, tras completar [PRUEBAS-HARDWARE](PRUEBAS-HARDWARE.md). Conviene crear en
*Settings → Environments* el entorno `release` con revisores obligatorios (si no existe, GitHub lo crea sin aprobación
manual; igualmente solo se crea un borrador).

> Estado: ninguno de estos workflows se ha ejecutado todavía; esta descripción sale de su lectura.
