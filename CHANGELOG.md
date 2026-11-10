# Historial de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y versionado [SemVer](https://semver.org/lang/es/).

> Las entradas describen **código implementado**, no funcionalidad validada. El estado de validación de cada
> parte está en [docs/PRUEBAS.md](docs/PRUEBAS.md), [docs/LIMITACIONES.md](docs/LIMITACIONES.md) y
> [docs/PRUEBAS-HARDWARE.md](docs/PRUEBAS-HARDWARE.md).

## [1.0.0] — sin publicar

Primera versión del código. **No hay ninguna Release publicada**: antes de publicarla deben completarse y documentarse
las pruebas de [docs/PRUEBAS-HARDWARE.md](docs/PRUEBAS-HARDWARE.md).

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
  página con el formato nativo del modelo, glosario e historial como contexto, reintento solo de lo que falte y nada vacío ni aceptado si el modelo se niega.
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
