# Pruebas realizadas

Cada prueba se clasifica por **lo que realmente ejercita**. Una prueba con piezas simuladas no demuestra que la pieza
simulada funcione: la columna «Simulado» lo dice. Lo que no se pudo probar está en [LIMITACIONES](LIMITACIONES.md#1-no-verificado-en-esta-entrega).

Entorno: contenedor Linux x64 de 2 vCPU y 8 GB, sin GPU, Python 3.13, Node 22, Chromium (Playwright 1.63), JDK 21. Sin
acceso a Hugging Face, Google Maven ni Gradle.

## Resumen por categoría

| Categoría | Qué es | Resultado |
|---|---|---|
| **Unitarias** | Una pieza aislada (maquetación, perfiles, esquemas, guardas, importadores) | Todas pasan |
| **Integración** | Varias piezas reales juntas con dispositivo/LLM/HF simulados (motor móvil completo, API del motor Python) | Todas pasan |
| **E2E en navegador** | Interfaz real + detector y OCR reales en WebAssembly; **LLM simulado** | 2 escenarios, pasan, 0 errores de consola |
| **Con modelos reales** | Detector y PP-OCR reales sí (arriba); **modelos de lenguaje, Manga OCR y LaMa reales: no** | Parcial |
| **Hardware físico** | Teléfono Android, GPU de Windows, sensores | **No realizado** |

## Automáticas

```bash
npm run typecheck                                  # shared + desktop + mobile: sin errores
npm test                                           # shared 23 + mobile 149
cd engine && python -m pytest -q                   # 76 pasan, 14 requieren detector y página de prueba (STARBLITZ_DETECTOR, STARBLITZ_TESTDATA)
cd apps/mobile/android/app && javac … NativeIoSelfTest   # 46 comprobaciones (ver más abajo)
bash apps/mobile/e2e/run.sh                        # E2E en Chromium
```

| Suite | Pruebas | Tipo | Qué comprueba | Simulado |
|---|---|---|---|---|
| `apps/shared/test/layout.test.ts` | 8 | Unitaria | Ajuste del texto al polígono del globo, equilibrio de líneas, guiones solo si imprescindibles, corte forzado, mayúsculas, interlineado | — |
| `apps/shared/test/llm.test.ts` | 15 | Unitaria | Perfil por RAM/VRAM, recomendación, estimación de memoria y veredicto cabe/justo/no cabe (un móvil modesto no recibe modelos que no caben; ≤ 4 GB se declara no compatible), `resolveModel`, catálogo solo con licencias permisivas, cliente de Hugging Face (búsqueda, archivos con tamaño y SHA-256, paginación, ids peligrosos, errores HTTP) | Respuestas HTTP |
| `mobile/test/unit/importers.test.ts` | 13 | Unitaria | Tipo por firma, orden natural, ZIP seguro (rutas `../`, bomba), duplicados, límites | Códec de imagen |
| `mobile/test/unit/translate.test.ts` | 13 | Unitaria/paridad | Mensajes exactos (sistema y usuario) idénticos a los que calcula Python, perfiles, diccionario personal, negativas del modelo, JSON inválido | Modelo de lenguaje |
| `mobile/test/unit/guard.test.ts` | 9 | Unitaria | Pausa por batería, calor, poco espacio; enfriamiento; poca memoria | Lecturas del dispositivo |
| `mobile/test/unit/models.test.ts` | 26 | Integración | Biblioteca de modelos (ficha con cuantizaciones y proyector, instalación con troceado, bloqueo de lo que no cabe, espacio libre, token solo hacia Hugging Face, corte de conexión, archivo corrupto, cancelar/pausar/reanudar con Range, registro de visión idéntico al de Python) y servidor de lenguaje (arranque bajo demanda, reintento con menos opciones, reinicio si el sistema lo cierra, descarga por inactividad, cancelar a mitad) | Servidor HF, descarga y `llama-server` falsos |
| `mobile/test/unit/nativehost.test.ts` | 25 | Integración | Contrato con el plugin nativo: archivos privados y rutas seguras, descarga con progreso/integridad/cancelación y solo HTTPS, errores traducidos, arranque y registro de `llama-server`, capacidades del teléfono, elección de OCR y reconstrucción por perfil, pantalla encendida solo mientras hay tareas | Plugin nativo falso |
| `mobile/test/unit/pipeline.test.ts` | 19 | Integración | Importar → analizar → traducir → reconstruir sin intervención; cada página visible al terminar; contexto entre páginas; progreso y tiempo restante; pausa, cancelación y reanudación sin repetir; interrupción detectada; página dañada no detiene la obra; «forzar» conserva lo aprobado/editado; idioma automático; rechazo del modelo → revisión; sin modelo o LLM caído → mensaje claro; imagen al LLM solo si procede | Visión y LLM falsos |
| `mobile/test/unit/localengine.test.ts` | 17 | Integración | API completa del motor local sin PC: ajustes (la clave de HF no se devuelve), proyectos, importar (ZIP, duplicados, límite de páginas), procesar la obra en una tarea, pausa/reanudación, interrupción, edición de textos, reordenar, modelos de lenguaje y visión, servidor de lenguaje bajo demanda | Visión, LLM y dispositivo falsos |
| `mobile/test/unit/workervision.test.ts` | 16 | Integración | Protocolo página ↔ Worker de visión: operaciones simultáneas, cancelación cooperativa y descarte del worker, caída por memoria con recuperación, `dispose`, modelos opcionales solo si el perfil lo permite | Worker simulado (el real se prueba en la E2E) |
| `mobile/test/unit/platform.test.ts` | 11 | Unitaria/integración | SHA-256 incremental contra la referencia, rutas peligrosas rechazadas, descargas con reanudación por Range, cancelación, contenido corrupto, archivo completo no se vuelve a bajar, servidor que ignora Range | Servidor HTTP falso |
| `engine/tests/test_import.py` | 10 | Unitaria | Igual que arriba, en Python | — |
| `engine/tests/test_layout.py` | 4 | Unitaria | Orden de lectura manga, doble página, textos fuera de viñetas | — |
| `engine/tests/test_manga_ocr.py` | 2 | Unitaria | Pipeline de Manga OCR y decodificación por haz | **Modelo ONNX sintético** |
| `engine/tests/test_translate.py` | 9 | Unitaria | JSON tolerante, traducción + corrección, marcas, línea omitida, memoria bloqueada | LLM simulado |
| `engine/tests/test_profiles.py` | 13 | Unitaria | Cada perfil cambia el prompt del traductor y del corrector, proyectos antiguos → «Natural», validación, diccionario (prioridad del glosario del proyecto, limpieza, bloqueo, límite), ajustes antiguos | LLM simulado |
| `engine/tests/test_llm_stack.py` | 25 | Integración | Catálogo, HF falso, biblioteca, runtime con `llama-server` falso, ajustes | HF y `llama-server` falsos |
| `engine/tests/test_jobs_and_lang.py` | 9 | Unitaria | Trabajos con pausa en puntos de control, cancelación estando en pausa, idempotencia por estado de página, progreso y tiempo estimado, idioma por texto y por bloques | — |
| `engine/tests/test_vision_registry_export.py` | 1 | Paridad | El registro de modelos de visión exportado coincide con Python | — |
| `engine/tests/test_api_e2e.py` + `test_detector_tiling.py` | 14 | E2E (Python) | Recorrido completo con **detector y PP-OCR reales** (ver abajo) | HF y `llama-server` falsos |
| `NativeIoSelfTest.java` | 46 | Integración (JDK) | Descargas HTTP con reanudación y SHA-256, rutas seguras, exportación por trozos, proceso del servidor (arranque, parada, cancelación, tiempo de espera, opción rechazada) | Servidor HTTP local y `llama-server` falso; **no usa la API de Android** |

## E2E en Chromium (`apps/mobile/e2e/`)

Se carga la app compilada (la misma que va al APK, con un gancho de prueba) en un Chromium móvil (390×844, táctil),
servida con COOP/COEP como en el WebView.

**Escenario 1 — aplicación completa** (`e2e.mjs`). Real: interfaz, descarga del detector (95 MB) con verificación
SHA-256, importación de 2 imágenes, detector de texto y OCR PP-OCR en WebAssembly con hilos, proyecto procesado como un
solo trabajo, reconstrucción del fondo, lector, editor, edición manual guardada como «editada», hoja de exportación
(PDF/ZIP/JPG/PNG/WEBP). **Simulado:** el modelo de lenguaje (servidor compatible con OpenAI interceptado) y el plugin nativo.

| Comprobación | Resultado |
|---|---|
| Descarga e instalación del detector con SHA-256 | OK (~6 s) |
| Procesar 2 páginas como un solo trabajo | OK en ~31 s (2 vCPU, sin GPU), 0 errores |
| Globos detectados (real) | Página 1: 4 de 4; página 2: 3 de 3 |
| OCR japonés (real, PP-OCR) | Texto correcto en las 7 regiones de las páginas sintéticas |
| Fondo reconstruido | Contornos de globos intactos y sin restos de texto (revisado a ojo en captura) |
| Edición manual | Se guarda y marca como «editada» |
| Errores de consola | 0 |

**Escenario 2 — camino de Android** (`worker.mjs`). Real: el mismo `visionWorker.entry` del APK en un Web Worker con
ONNX Runtime con hilos (página aislada), modelos leídos por URL como en la app, análisis y reconstrucción. Detector
4/4 globos, PP-OCR leyendo japonés (~16 s por página con 2 hilos en este contenedor), reconstrucción PNG, 0 errores.

**Defectos reales que encontró la E2E y que ya están corregidos**

1. *Cuelgue con hilos de WebAssembly*: el runtime de ONNX Runtime iba incrustado en el paquete; con la página aislada
   cada hilo arrancaba la aplicación entera (`document is not defined`) y el análisis se quedaba esperando sin fin (0 regiones
   tras 7 min). Habría ocurrido igual en Android. Ahora `.mjs` y `.wasm` se sirven como archivos propios (`ort/`), con
   tiempo máximo de inicialización de 60 s para que un fallo sea un error visible.
2. *Cabecera de «Páginas» desordenada*: el selector Original/Traducido heredaba un ancho del 100 %.
3. Fallos de arranque, navegación «Atrás» sin historial y textos de Ajustes inexactos (ya corregidos antes).

## Con modelos y páginas reales (Python, escritorio)

Resultados de sesiones anteriores sobre una página de manga japonés en blanco y negro (muestra de investigación de
Manga109, solo para pruebas, no incluida en el repositorio); **no se repitieron en esta sesión**:

| Fase | Resultado | Tiempo (CPU, 2 vCPU) |
|---|---|---|
| Detección (comic-text-detector) | Todos los globos y la narración detectados; columnas verticales separadas | ~46 s (en GPU se espera 1–2 s) |
| Viñetas y orden de lectura | Orden correcto derecha→izquierda, arriba→abajo | < 0,1 s |
| OCR PP-OCRv6 (respaldo japonés) | Correcto salvo kanji poco comunes (marcados `ocr_suspect`) | ~1 s para 12 bloques |
| Limpieza (relleno de papel) | Sin restos de trazo ni manchas; contornos intactos | ~1 s |

### Ejecución de esta sesión: detector y OCR reales sobre una página sintética

Se ejecutaron las 14 pruebas que normalmente se omiten (13 de API extremo a extremo + 1 de teselado con el modelo real)
junto a las 3 de teselado sin modelo, con el detector real (`comictextdetector.onnx`), el OCR real y
un `llama-server` y un Hugging Face **simulados**. La página de entrada es una **página sintética** generada para la prueba
(texto japonés en globos dibujados; no es una página de manga real), así que estas pruebas validan el **flujo** (instalar
desde HF, proyecto como una sola tarea, estados por página, pausa/reanudación, recuperación tras interrupción, rechazo
del modelo, idioma automático, seguridad de la API) y no la calidad de detección/OCR sobre manga real.

| Resultado | Detalle |
|---|---|
| 17 de 17 pasan | 16 a la primera; `test_real_model_on_webtoon_strip` falló por un supuesto del propio test (recortaba la «mitad derecha» de una doble página, pero la página de prueba es una sola) y se corrigió el test: ahora usa la página entera si es vertical y la mitad derecha si es apaisada; exige ≥ 3 bloques seguros (la página sintética tiene 4, todos con confianza ≥ 0,9). Las aserciones sobre cortes (cada bloque una sola vez por copia, sin recortes) no se tocaron |
| Total Python | 90 de 90 (76 sin modelos + las 14 omitidas), ejecutadas en dos tandas: no hubo una única ejecución de las 90 |
| Tiempos en CPU (2 vCPU) | proyecto completo con estados en vivo ≈ 11,6 min; pausa/reanudar/cancelar ≈ 12 min; recuperación tras interrupción ≈ 6,5 min; reprocesar sin repetir ≈ 1,9 min; tira de 3 páginas ≈ 4,9 min. En GPU/NPU se esperan órdenes de magnitud menos, pero **no está medido** |


## Compilación

- `scripts/build-windows.sh` / `build-installer.sh`: compilados en sesiones anteriores (portátil de ~0,7 GB en la
  carpeta del proyecto del PC). **No se recompilaron en esta sesión**: se actualizó el portátil existente con los cambios
  de interfaz y motor.
- Web móvil: `vite build` correcto; `cap sync android` correcto (plugins, `ort/` y `models/` en los assets).
- **APK: no compilado** (sin acceso a Google Maven/Gradle). Revisión estática del proyecto: manifiesto, permisos, seguridad
  de red, `abiFilters`, `minSdk 28`, firma por variables de entorno y registro del plugin.
