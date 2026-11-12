# Historial de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y versionado [SemVer](https://semver.org/lang/es/).

> Las entradas describen **código implementado**, no funcionalidad validada. El estado de validación de cada
> parte está en [docs/PRUEBAS.md](docs/PRUEBAS.md), [docs/LIMITACIONES.md](docs/LIMITACIONES.md) y
> [docs/PRUEBAS-HARDWARE.md](docs/PRUEBAS-HARDWARE.md).

## [1.0.0] — sin publicar

Primera versión del código. **No hay ninguna Release publicada**: antes de publicarla deben completarse y documentarse
las pruebas de [docs/PRUEBAS-HARDWARE.md](docs/PRUEBAS-HARDWARE.md).

### Corregido (auditoría de estabilización — 2026-11-12)

Detalle, causas raíz y pendientes en [docs/AUDITORIA-ESTABILIZACION.md](docs/AUDITORIA-ESTABILIZACION.md).

- **Pérdida de datos:** las ediciones hechas durante una traducción ya no se sobrescriben (PC y móvil); volver a analizar conserva
  lo revisado aunque el detector no lo encuentre; un ZIP con una entrada dañada importa el resto; un ajuste no válido ya no borra
  todos los ajustes (diccionario y token) y un `settings.json` truncado ya no impide arrancar; cerrar la ventana guarda lo
  pendiente y los guardados fallidos se reintentan; guardar la «Memoria» ya no borra lo que la IA añadió mientras tanto.
- **Android:** la exportación ya no cierra imágenes que usa el lector (segunda exportación y páginas en blanco); nombres de
  proyecto que empiezan por «(», «-» o «.» ya se exportan; LaMa se libera al cambiar ajustes; activar o borrar un modelo ya no corta
  una traducción en curso; Configuración ya no carga todas las imágenes en memoria.
- **Traducción:** `"n": null` o decimal en la respuesta ya no tumba la página ni lleva el texto al globo equivocado (paridad
  Python ↔ TS); «Cancelar» corta al momento las peticiones a Ollama y servidores externos; el contexto de «Retraducir» ya no
  incluye páginas posteriores; «Probar la traducción» ya no caduca a los 30 s.
- **Modelos:** reanudar una descarga descuenta lo ya bajado al comprobar el espacio; las descargas sin terminar aparecen, cuentan
  en el disco y se pueden borrar.
- **Importación:** los JPG ya no se recodifican a PNG (3–5× más disco) salvo que la orientación EXIF lo exija.
- **Compilación y CI:** SHA-256 de Electron, Python embebido y NSIS; dependencias del motor fijadas; el APK de `build.yml` pasa la
  verificación estática; CI en la rama de trabajo, tipos de Electron, guarda de paridad de los 4 exportadores y pruebas de la app de
  escritorio; las pruebas del servidor de modelos funcionan en Windows; Python mínimo 3.12 (lo exige numpy 2.5).

### Corregido (fase 3: robustez, calidad de traducción y reconstrucción — 2026-11-10)

- **Respuesta JSON inválida del modelo:** antes hacía fallar la página entera en el PC y, en el móvil, detenía **todo el capítulo**
  (`LLMUnavailableError`). Ahora `InvalidJSONError`/`InvalidJsonError` conserva las respuestas en bruto; si la respuesta se cortó por el tope
  de tokens no se reintenta igual (se volvería a cortar); se **rescatan** los elementos completos que traigan el eco de SU original y los que
  faltan se piden **uno a uno** (2 intentos, tope de 512 tokens, como máximo 24 textos por página). Lo que no se recupera conserva el
  original con una nota. Cuentas nuevas en el trabajo: `json_invalid`, `json_salvaged`, `json_recovered`, `json_lost`. Paridad Python ↔ TS.
- **Globos llenos de texto no se reconocían (93 de 301 en el capítulo real):** la dispersión del papel entre letras se medía con la media,
  que inflaba el antialias; ahora es robusta (mediana de la desviación máxima por canal). La cola del globo rompía la prueba de convexidad:
  ahora se corta con una apertura del tamaño de la letra. Un globo debe **contener** su texto (si no, no es su globo).
- **Texto rotulado en BLANCO dentro de globos blancos (14 textos ilegibles) y manchas oscuras al borrar:** el color de la letra se decidía
  con el anillo exterior; ahora con el papel entre letras (`text_tone`/`textTone`).
- **Traducciones basura** («¡¡¡¡¡¡») y **«vosotros» monosílabo** («veis», «sois», «vais», «dais») no se detectaban: nuevo control `garbled`
  (bloqueante) y patrón de es-419 ampliado.
- **Textos que no caben:** comprobación de encaje con las **métricas reales de las tipografías** (`translate/fit.py`/`fit.ts`, tablas generadas
  por `tools/export_glyph_metrics.py`), y **reformulación breve** (una llamada por página) solo para lo que no cabe: la versión corta se
  acepta únicamente si cabe, conserva al menos el 55 % del contenido, no pierde nombres ni añade problemas; la versión completa queda en la
  nota (`condensed`). El maquetador prueba al final un margen interior más estrecho dentro del globo. El tope fijo del cuerpo mínimo baja
  del 0,8 % al 0,72 % de la página (21,6 px en 3 000; el 10 % de la letra de diálogo del propio cómic de prueba ya mide ≤ 22 px). La
  estimación de caracteres usa exactamente el mismo cuerpo mínimo que el maquetador.
- **Traducciones montadas en globos pegados:** si los textos originales apenas se rozan (≤ 25 % del menor), las cajas se cortan por el
  centro del solape (antes no se separaban); si después no cabe, se exporta el original. 21 → 5 pares en el capítulo real.
- **Controles de calidad nuevos:** `incomplete` (traducción cortada a media frase; pide reparación) y la reformulación no puede dejar la
  frase colgando; «vosotros» no se marca si el original ya contiene esa forma (texto copiado).
- **Herramientas de evaluación:** `tools/bench/translate_models.py` (mismas regiones traducidas por varios modelos, con tiempos, tokens,
  RAM y VRAM), `tools/bench/translate_compare.py` (métricas y frases sonda lado a lado), `tools/export_glyph_metrics.py`;
  `corpus_eval.py` guarda las cifras del trabajo y la VRAM; `golden_vision.py` reproduce ahora `analyze_page` (búsqueda ampliada y
  separación de cajas) y `run_parity.py` acepta `PW_CHANNEL` y sirve los `.wasm` de ONNX Runtime.

### Corregido (fase 2: causas generales encontradas con el capítulo real)

- **Globos ajustados al texto no se reconocían:** el color de fondo se estimaba con un anillo alrededor del texto, que en los globos
  ajustados (cómic occidental) cae sobre el dibujo; el «globo» resultaba ser la silueta del propio texto. Ahora se usa el papel visible
  entre las letras (`paper_stats`/`paperStats`) y el anillo solo como respaldo.
- **Globos grandes con poco texto** (una línea, estilo manga) se descartaban por medir más de 6× el bloque: segundo intento con búsqueda
  ampliada, aceptado solo si el globo no contiene el texto de otra región.
- **Traducciones superpuestas:** las cajas de rotulado de globos pegados se pisaban; ahora se cortan por la línea media entre los textos
  originales, sin encoger nunca por debajo del texto original (`separate_layouts`/`separateLayouts`).
- **Textos que no cabían:** letra mínima fija (0,8 % de la página) mayor que el rotulado condensado original; ahora puede bajar hasta el
  75 % del cuerpo original, se prueba la tipografía condensada incluida antes de rendirse y, en globos, el margen se aplica al contorno y no
  dos veces. Al **exportar**, lo que aun así no cabe se deja con el **texto original restaurado** (nunca desbordado); el editor sigue
  mostrando el desbordamiento para corregirlo a mano.
- **`too_long` en 7 de cada 10 textos:** la estimación de caracteres suponía una letra mayor que el mínimo del maquetador; ahora usa el mismo.
- **Traducción:** cada respuesta del modelo trae el eco de las primeras palabras de su original (`src_start`); se comprueban desalineación,
  texto inventado, «vosotros» en es-419 y nombres propios perdidos, y los textos con problemas se piden de nuevo en **una** llamada de
  reparación. Si siguen desalineados o inventados, no se usan (el original se conserva). Mayúsculas iguales que en el original. Instrucciones
  reforzadas: nombres propios sin traducir, concordancia de género, es-419 sin «vosotros». Igual en móvil y PC (casos de paridad).
- **Detector experimental:** agrupación de líneas por globo y descarte de ruido (líneas sueltas diminutas fuera de globo).

### Añadido

- **Detector de texto experimental PP-OCRv6 Manga (PC y móvil), desactivado por defecto:** `processing.detector = "manga-det"`
  (Ajustes → Procesamiento) y modelo opcional `text-detector-manga` (1,8 MB, revisión v0.3 fijada con SHA-256). El modelo solo detecta
  líneas; la agrupación en bloques y la máscara de trazos las hace STARBLITZ, con paridad Python ↔ TypeScript. El detector predeterminado
  **no cambia**. Ver [docs/DETECTOR-EXPERIMENTAL.md](docs/DETECTOR-EXPERIMENTAL.md).
- **Evaluación con un capítulo real** (`tools/bench/corpus_eval.py`, `corpus_compare.py`, `export_render.mjs`): pipeline completo del motor de
  escritorio con desglose por etapa y página, RAM/CPU y exportación con el renderizador compartido. Resultados en
  [docs/EVALUACION-CORPUS-USM.md](docs/EVALUACION-CORPUS-USM.md) (cómic en inglés; sin japonés ni coreano).

### Corregido

- **Escritorio en CPU ~100× más lento de lo debido:** los pesos de `comic-text-detector` contienen números desnormalizados; ONNX Runtime 1.31
  en CPU tardaba 103 s por página. Ahora las sesiones tratan los desnormalizados como cero (0,9 s; salida idéntica bit a bit).
- **Traducción desbocada con servidores externos** (compatibles con OpenAI y Ollama): la petición JSON no limitaba la salida ni desactivaba el
  razonamiento; Qwen3.5 llegó a generar más de 8 500 tokens para una página. Ahora: tope de 4 096 tokens y `enable_thinking=false`, como el
  motor integrado.

### Retirado

- **PLaMo 3 Translate** (decisión D3, no autorizado): sin reconocimiento por nombre ni plantilla propia; búsqueda, descripción, instalación y
  uso bloqueados en móvil y PC; fuera del banco de pruebas (sus medidas del 2026-11-08 quedan como registro histórico).

### Añadido (anterior)

- **Auditoría de la visión y control térmico (móvil):** desglose de tiempos del análisis por página (decodificar, detector, viñetas, OCR, tramos) en el informe exportable;
  `ThermalPacer`: descansos adaptativos según el estado térmico y el margen térmico de Android (o solo la batería si no hay API), con estadísticas de throttling; el plugin nativo
  informa `thermal_headroom`. **Medido en PC:** el detector de texto es ~80–86 % del análisis; el detector ligero de PP-OCRv6 Manga es ~14–19× más rápido en inferencia
  (no integrado: falta validar precisión con páginas reales). Parámetros térmicos **sin calibrar** y sin medir en el teléfono. Ver [docs/OPTIMIZACION-ANDROID.md](docs/OPTIMIZACION-ANDROID.md).

- **Traducción en texto plano por lotes (móvil y PC):** `PlainTranslator` para modelos de traducción dedicados (Hy-MT2; el soporte de PLaMo se retiró el 2026-11-09, D3): una llamada por
  página con el formato nativo del modelo, glosario como contexto (el historial de diálogos solo lo usaba PLaMo, retirado), reintento solo de lo que falte y nada vacío ni aceptado si el modelo se niega.
  Medido en PC: el formato actual cuesta ~1 070 tokens de entrada y ~350 de salida por página con Qwen3.5-4B; en texto plano, ~200 y ~45; con PLaMo-0.8B, ~55 y ~42.
  Los demás modelos siguen con el traductor contextual. Catálogo: añadido Hy-MT2-1.8B (Apache-2.0); sin cambiar el modelo recomendado.
- **Banco de pruebas de traducción** (`tools/bench`): corpus inventado ja/ko de 56 segmentos en 10 categorías, arnés reproducible y resultados crudos;
  informe en [docs/BENCHMARK-TRADUCCION.md](docs/BENCHMARK-TRADUCCION.md). Solo en PC: **sin medidas del teléfono**.

- **Informe de rendimiento exportable (móvil):** menú del proyecto → «Exportar informe de rendimiento (JSON)». Reúne
  `project.last_job.timings`, un resumen calculado (tiempos, tokens/s, llamadas y aciertos de caché, batería, temperatura y
  memoria libre del sistema) y el estado del dispositivo; sin tokens, imágenes ni textos. Las muestras del dispositivo se toman
  al empezar, tras cada página y al terminar (solo lectura). Protocolo en
  [docs/VALIDACION-FASE4-ANDROID.md](docs/VALIDACION-FASE4-ANDROID.md).

- **Rendimiento y lotes (móvil, Fase 4):** cola persistente de procesamiento con recuperación tras un cierre (`queue()`,
  `resumeQueue()`, `dismissQueue()`); caché de OCR y de traducciones con claves que incluyen todo el contexto (nunca se
  reutiliza un resultado vacío, rechazado o con otro contexto; «forzar» las salta); gobernador de concurrencia por RAM y memoria
  libre (serie por defecto); precarga del modelo sin competir con el OCR; liberación de modelos opcionales de la visión con
  poca memoria; medidas por página y por capítulo en `last_job.timings`. Probado con piezas simuladas (195 pruebas móviles);
  **sin mediciones de tiempo real ni mejoras de velocidad afirmadas**.

- **STARBLITZ Desktop** (Windows 10/11 x64): aplicación Electron + React con motor propio en Python (FastAPI, ONNX Runtime
  con DirectML, llama.cpp con Vulkan), proyectos, procesamiento por lotes, editor, exportación y gestor de modelos.
- **STARBLITZ Mobile** (Android 9+, arm64): aplicación Capacitor con motor local en TypeScript, plugin nativo en Java y
  `llama-server` de llama.cpp (arm64) como proceso hijo; funciona sin PC.
- **Motor Python** (`engine/`): importación (ZIP, CBZ, PDF, imágenes), detección de texto, OCR (Manga OCR y PP-OCR),
  traducción contextual con modelos locales, reconstrucción del fondo (relleno de papel y LaMa) y trabajos con pausa y
  reanudación.
- **Código común** (`apps/shared`): tipos, cliente del motor, maquetación, exportación, catálogo de modelos y perfiles de
  traducción (Natural, Fiel, Coloquial, Formal y Adaptación narrativa).
- Ecosistema de modelos: búsqueda en Hugging Face, comparación con el dispositivo, descarga reanudable con SHA-256.
- Documentación técnica en `docs/` y automatización en `.github/workflows/` (integridad, pruebas, compilación,
  validación manual y borrador de Release).

### Corregido

- **Globos vacíos:** el original ya no se borra salvo donde hay una traducción válida (y, en el móvil, que quepa en el globo);
  si no, se conserva y se marca para revisión (`original_kept`, `no_fit`).
- **Textos omitidos por el OCR:** las lecturas vacías ya no se descartan en silencio; quedan como regiones en revisión (`ocr_empty`).
- La traducción de todo el proyecto al terminar de importar viene **marcada por defecto** en Android.
- Medición de segundos por etapa y por página en `project.last_job.timings`.

### Seguridad y privacidad

- Sin telemetría ni cuentas. Las conexiones salientes se limitan a la descarga de modelos que el usuario solicita.
- Motor de escritorio solo en `127.0.0.1` con token de sesión; Android con `allowBackup=false` y permisos mínimos.
