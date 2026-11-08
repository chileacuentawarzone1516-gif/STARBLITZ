# Historial de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y versionado [SemVer](https://semver.org/lang/es/).

> Las entradas describen **código implementado**, no funcionalidad validada. El estado de validación de cada
> parte está en [docs/PRUEBAS.md](docs/PRUEBAS.md), [docs/LIMITACIONES.md](docs/LIMITACIONES.md) y
> [docs/PRUEBAS-HARDWARE.md](docs/PRUEBAS-HARDWARE.md).

## [1.0.0] — sin publicar

Primera versión del código. **No hay ninguna Release publicada**: antes de publicarla deben completarse y documentarse
las pruebas de [docs/PRUEBAS-HARDWARE.md](docs/PRUEBAS-HARDWARE.md).

### Añadido

- **Auditoría de la visión y control térmico (móvil):** desglose de tiempos del análisis por página (decodificar, detector, viñetas, OCR, tramos) en el informe exportable;
  `ThermalPacer`: descansos adaptativos según el estado térmico y el margen térmico de Android (o solo la batería si no hay API), con estadísticas de throttling; el plugin nativo
  informa `thermal_headroom`. **Medido en PC:** el detector de texto es ~80–86 % del análisis; el detector ligero de PP-OCRv6 Manga es ~14–19× más rápido en inferencia
  (no integrado: falta validar precisión con páginas reales). Parámetros térmicos **sin calibrar** y sin medir en el teléfono. Ver [docs/OPTIMIZACION-ANDROID.md](docs/OPTIMIZACION-ANDROID.md).

- **Traducción en texto plano por lotes (móvil y PC):** `PlainTranslator` para modelos de traducción dedicados (PLaMo 3 Translate, Hy-MT2): una llamada por
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
