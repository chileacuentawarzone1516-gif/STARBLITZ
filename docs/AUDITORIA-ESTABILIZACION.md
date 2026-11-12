# Auditoría de estabilización (2026-11-11/12)

Fase sin funcionalidades ni modelos nuevos: localizar errores reales, corregir los confirmados y dejar pruebas que lo
demuestren. Punto de partida: `4d98165` (rama `test/windows-ci`). Se revisaron la app de escritorio (Electron + React), la app
Android (Capacitor + motor TS + plugin Java), el código compartido, el motor Python, CI, scripts de compilación y documentación.

**Estados:** CONFIRMADO = reproducido o comprobado leyendo el flujo completo · SOSPECHA = plausible, sin reproducir.
**Pruebas:** «regresión» = prueba nueva que falla con el código anterior y pasa con la corrección.

## 1. Errores corregidos

### Críticos y altos

| # | Componente | Problema (causa raíz) | Corrección | Prueba |
|---|---|---|---|---|
| C1 | Motor PC + móvil (`pipeline/processor.*`) | **Ediciones del usuario perdidas durante la traducción**: el traductor trabaja con una copia y al terminar sustituía las regiones sin mirar si la persona las cambió entretanto (reproducido: «EDICIÓN PERDIDA»). | Se guarda el estado de cada región al empezar (`_snapshot`/`snapshotRegions`) y solo se aplica la traducción donde la región sigue igual (`_merge_unchanged`/`mergeUnchanged`). También en «Retraducir». | regresión Py + TS |
| A1 | Motor PC + móvil | **Reanálisis borraba regiones revisadas** sin pareja en el detector (p. ej. dibujadas a mano) y en las que sí la tenían perdía texto original, caja y opciones de borrado/rotulado. El análisis además partía de la página leída al empezar. | `_keep_reviewed`/`keepReviewed`: conserva las revisadas sin pareja y copia todos los campos; la página se relee bajo el bloqueo al guardar. | regresión Py + TS |
| A2 | Importación PC (`importers/ingest.py`, API) | **Un ZIP/CBZ con una entrada dañada** (CRC, deflate) tumbaba toda la importación y dejaba páginas huérfanas en disco. | Error por entrada («archivo dañado dentro del ZIP»); el proyecto se guarda en `finally`. | regresión Py |
| A3 | Ajustes PC (`core/settings.py`) | **Un valor no válido devolvía TODOS los ajustes a los valores por defecto** (diccionario y token incluidos) y un `settings.json` truncado impedía arrancar. | Se descartan solo los campos no válidos; JSON ilegible → valores por defecto; siempre se guarda copia `settings.json.bad`. | regresión Py |
| A4 | Exportación Android (`shared/export.ts`, `ExportSheet`, `images.tsx`) | **La exportación cerraba bitmaps compartidos con el lector** (y la caché los cerraba al desalojarlos aunque estuvieran en pantalla): segunda exportación fallida y páginas en blanco. El original nunca se cerraba (fuga). | La exportación usa bitmaps propios (`ownedPageBitmap`) y libera base y original en `finally`; la caché del lector ya no cierra. | regresión TS (base y original cerrados, también si falla) |
| A5 | Exportación Android (`exportFile.ts` ↔ `SafePath.java`) | **Proyectos cuyo nombre empieza por «(», «-» o «.»** no se podían exportar («Ruta de archivo no válida»). | Prefijo `e-` en la ruta temporal; el nombre visible no cambia. | regresión TS con el patrón Java |
| A6 | Compilación Windows (`build-windows.sh`, `build-installer.sh`, `requirements.txt`) | **Electron, Python embebido y NSIS se descargaban sin SHA-256**; 8 dependencias del motor sin versión fija. | SHA-256 oficiales (Electron `SHASUMS256.txt`, python-build-standalone `SHA256SUMS`; NSIS calculado, su Release no publica sumas), comprobados también en caché; versiones fijadas a lo probado. | CI `windows.yml` |
| A7 | `build.yml` (APK de las Releases) | **El APK del borrador no pasaba ninguna verificación** (solo «existe»). | Mismos pasos que `android.yml`: SHA-256 de las bibliotecas de llama.cpp y `verificar-apk.sh`. | CI (se ejecuta al lanzar `build`/`release`) |

### Medios

| # | Componente | Problema | Corrección | Prueba |
|---|---|---|---|---|
| M1 | Escritorio (`useEditor.ts`, `main.ts`, `preload.ts`) | Cerrar la ventana antes de 450 ms perdía la última edición; un guardado fallido se descartaba. | Al cerrar, la ventana pide a la interfaz que guarde (máx. 5 s); los guardados fallidos vuelven a la cola y se reintentan (lo escrito después gana). | regresión vitest (reintento, prioridad, vaciado) |
| M2 | Escritorio (`ProjectView` → `MemoryTab`) | Guardar la «Memoria» sustituía la lista del motor: se perdían personajes/términos añadidos por la IA durante el procesado. | Se combina con lo último del motor (`mergeMemoryEdits`); sin cambios propios la pestaña sigue al proyecto. | regresión vitest |
| M3 | Compartido (`api.ts`) | «Probar la traducción» (carga el modelo), subidas grandes y la primera relectura usaban el límite general de 30 s. | Límites propios (`SLOW_MS`: 25 min, 10 min, 3 min). | `tsc` (sin prueba automática) |
| M4 | Escritorio (`electron/main.ts`) | Si reiniciar el motor fallaba, promesa rechazada sin tratar: sin aviso y ventana colgada. | Bucle con diálogo de error y opción de reintentar o cerrar. | `tsc` de Electron (sin prueba automática; requiere la app real) |
| M5 | Motor PC + móvil (`contextual.*`) | `"n": null` tumbaba la página entera (PC) o se tomaba como 0 (móvil); `2.7` llevaba la traducción al globo 2. | `_item_n`/`indexByNumber` con la misma regla en los dos motores. | regresión Py + TS |
| M6 | Importación PC | Todos los JPG se recodificaban a PNG (3–5× más disco) porque `exif_transpose` siempre devuelve una copia. | Solo se recodifica si la orientación EXIF lo exige. | regresión Py |
| M7 | Móvil (`vision/service.ts`) | Cambiar ajustes olvidaba la sesión de LaMa sin liberarla (~200 MB por cambio). | `dispose()` antes de soltarla. | regresión TS |
| M8 | Móvil (`localEngine.ts`, `models/runtime.ts`) | Activar o borrar un modelo detenía `llama-server` aunque estuviera traduciendo (abortaba el capítulo). | Activar no corta lo que está en curso; borrar el modelo que traduce responde 409 `busy`. | regresión TS |
| M9 | Motor PC (`translate/llm.py`) | Cancelar/Pausar no cortaba las peticiones a Ollama ni a servidores OpenAI externos (hasta 600 s). | La petición va en un hilo; al cancelar se cierra la conexión y se lanza `CancelledError` al momento. | regresión Py (servidor lento real) |
| M10 | Modelos PC + móvil (`library.*`) | Reanudar una descarga casi completa daba «No hay espacio»; los `.part` ocupaban disco sin aparecer en ningún sitio. | El espacio descuenta lo ya descargado; `incomplete()` lista las descargas sin terminar, cuentan en el uso de disco y se pueden borrar desde «Modelos instalados». | regresión Py |
| M11 | Móvil (`store/docs.ts`) | Abrir Configuración cargaba a la vez todas las imágenes de todos los proyectos para sumar tamaños. | Suma con un cursor (una imagen cada vez). | comprobación nueva en el E2E de Chromium (IndexedDB real) |
| M12 | Python 3.11 / 3.12 | `pyproject.toml` y la documentación decían 3.11+, pero numpy 2.5 exige 3.12. | `>=3.12` en `pyproject.toml`, `COMPILAR.md` y `CONTRIBUTING.md`. | — |
| M13 | CI | `ci.yml` no se lanzaba con los push a `test/windows-ci`; los JSON exportados Python→TS solo tenían guarda para uno de cuatro; el script del emulador daba por buenos fallos de instalación. | CI también en `test/**`; paso que regenera los 4 exportadores y exige `git diff` vacío (exportador de casos sin marcas de tiempo); el emulador solo tolera `NO_MATCHING_ABIS`. | CI |
| M14 | Pruebas en Windows (`engine/tests/conftest.py`) | 7 pruebas del servidor de modelos fallaban en Windows (`WinError 216`): el `llama-server.exe` falso era un script con `#!`. | Lanzador `.exe` real (el de los `console_scripts` de pip). | `test_llm_stack.py` 25/25 en Windows |

### Bajos y calidad

| # | Problema | Corrección |
|---|---|---|
| B1 | Deshacer una edición dejaba la región «editada» para siempre (el procesado y «Retraducir» la saltaban). | `undoSnapshot` guarda también el estado previo (prueba vitest). |
| B2 | `main.ts`/`preload.ts` de Electron no se comprobaban con TypeScript en ningún sitio. | `typecheck:electron` en CI (y comprobado en local con los tipos de Electron 38.2.0). |
| B3 | Al retraducir textos sueltos, el contexto incluía resúmenes de páginas POSTERIORES si alguna anterior no tenía resumen (filtrar antes de cortar). | Se corta y luego se filtra (PC y móvil). |
| B4 | Nombres de archivo reservados de Windows (`CON`, `NUL`…) o con punto final en la exportación. | `safeFileName` los corrige (prueba). |
| B5 | `PlainTranslator` calcula el historial pero no lo envía; código, CHANGELOG y `ARQUITECTURA-TRADUCCION.md` decían lo contrario. | Textos corregidos (sin cambiar el comportamiento de traducción). |
| B6 | La app de escritorio no tenía pruebas automáticas. | `apps/desktop/test` (vitest) incluido en `npm test`. |

## 2. Pendientes (no corregidos en esta fase)

| Problema | Estado | Motivo |
|---|---|---|
| Borrar una página mientras se procesa puede recrear su carpeta y hacer fallar el trabajo (`api/app.py` `delete_page`). | SOSPECHA | Sin reproducir. Corrección propuesta: 409 si hay un trabajo activo, como `delete_project`. |
| Un `.part` incompleto podría promoverse a archivo final si un reintento devuelve 401/403/404 y el archivo no tiene tamaño ni SHA (`core/download.py`). | SOSPECHA | Afecta a archivos pequeños de manga-ocr. |
| En modo solapado (teléfonos ≥10,5 GB) la traducción de N no espera al análisis de N+1: el contexto «página siguiente» llega vacío. | CONFIRMADO, MEDIO | Cambio en la planificación del procesado; no afecta al Redmi (modo en serie). |
| `killStale` del plugin Java podría matar el `llama-server` recién arrancado. | SOSPECHA | Carrera al cargar el plugin. |
| La clave de `layoutCache` usa solo el número de vértices del polígono. | SOSPECHA | Bajo impacto. |
| `validacion.yml`: `continue-on-error` en el job del emulador puede ocultar su resultado en el informe. | SOSPECHA | Semántica de GitHub sin verificar. |
| Dependencias transitivas del motor (urllib3, idna…) sin versión fija; sin `--require-hashes`. | MEDIO | Requiere un archivo de bloqueo con hashes; queda documentado. |
| `vitest` no figura en las `devDependencies` de `apps/desktop` (se resuelve desde la raíz del workspace). | BAJO | Actualizar el lockfile choca con la política local de npm (bloquea dependencias git de electron-builder). |
| `History.undo` pierde el comando si `revert` lanza un error. | BAJO | Sin impacto observado. |

## 3. Verificación

Local (Windows 11, este PC): `npm run typecheck` sin errores · `tsc` de Electron main/preload (tipos de Electron 38.2.0) sin
errores · vitest shared 30/30, mobile 274/274, desktop 6/6 · pytest 131 OK, 19 omitidas (necesitan el detector o páginas de
prueba; las ejecuta CI) · `scripts/ci/verificar-repo.sh` OK. No ejecutado en local: E2E de Chromium, autoprueba Java (no hay
JDK), compilación del APK y del instalador (los hace CI). **Nada probado en un teléfono ni en un instalador ejecutado por una
persona.** Resultados de CI: ver el informe de la fase en el Vault y el CHANGELOG.
