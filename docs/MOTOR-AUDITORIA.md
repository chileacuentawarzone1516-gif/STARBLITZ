# Auditoría del motor de traducción (Android y PC)

Auditoría hecha leyendo el código del motor móvil (`apps/mobile/src/engine/`), el motor de PC (`engine/`) y las pruebas.
**Todavía no hay mediciones en un teléfono real**: los tiempos por etapa se miden ya (ver [Medición](#medición-por-etapa)),
pero las cifras del Redmi Note 8 Pro hay que tomarlas en el dispositivo. Aquí se separa lo **comprobado** (leído o probado)
de lo **hipotético** (sin medir).

## Los 8 problemas reportados

| # | Problema | Diagnóstico | Estado |
|---|---|---|---|
| 1 | No hay traducción en segundo plano | El motor móvil vive en el `WebView` de la actividad; no hay servicio en primer plano ni `WorkManager` ([LIMITACIONES](LIMITACIONES.md)) | ⏳ Diseño en [DISENO-FASES-5-7](DISENO-FASES-5-7.md); sin implementar |
| 2 | 27 páginas tardan demasiado | Sin medir por etapa hasta ahora. Hay sospechosos concretos (abajo) | 🔨 Instrumentado; ⏳ falta medir en el teléfono |
| 3 | El OCR omite textos y se equivoca | **Confirmado un fallo de diseño:** una lectura OCR vacía se descartaba en silencio (`vision/service.ts`, `analyze_page` en Python): el texto desaparecía del análisis sin dejar rastro | ✅ Corregido: ahora queda como región «el OCR no leyó este texto» para revisarla. Los errores de lectura en sí dependen del modelo (ver [MODELOS-INVESTIGACION](MODELOS-INVESTIGACION.md)) |
| 4 | Un globo quedó vacío | **Causa raíz confirmada:** la reconstrucción borraba todo texto con `erase=true` aunque su traducción estuviera vacía, fuera una negativa del modelo, faltara o no cupiera; no se dibujaba nada encima | ✅ Corregido y probado (ver Fase 3) |
| 5 | Calidad de traducción insuficiente | Depende del modelo y del contexto; sin medir con un conjunto de referencia | ⏳ Protocolo en [MODELOS-INVESTIGACION](MODELOS-INVESTIGACION.md); sin ganador declarado |
| 6 | No hay traducción automática de todo | La función existía («Traducir todo el proyecto al terminar») pero la casilla estaba **desmarcada por defecto** | ✅ Ahora viene marcada por defecto |
| 7 | No se conserva el estilo visual | Hoy se infiere solo color claro/oscuro y contorno (`makeRegion`), con tipografías por rol; no cursiva, sombra ni grosor reales | ⏳ Fase 6 pendiente |
| 8 | No hay actualizador | No existe | ⏳ Diseño en [DISENO-FASES-5-7](DISENO-FASES-5-7.md) (el repositorio es privado: hay decisiones tuyas pendientes) |

## Cómo funciona hoy el pipeline (comprobado leyendo el código)

Un proyecto es **una tarea** (`Processor.run`) que recorre las páginas **en serie**: `analizar → traducir → reconstruir`.

1. **Analizar** (en un Worker de visión): detector de texto (ONNX, YOLOv5 + DBNet) → paneles y orden de lectura → **OCR por
   bloque** (Manga OCR para japonés si está instalado; si no, PP-OCR) → región.
2. **Traducir**: una llamada al modelo de lenguaje por página (`llama-server`, proceso hijo) con ficha de la obra,
   glosario, personajes, resumen, página anterior y siguiente; en «calidad máxima» hay una **segunda llamada** de corrección.
3. **Reconstruir**: borrado del texto original (relleno con papel o LaMa) y, al exportar/ver, rotulado con el lienzo compartido.

Se analiza **por adelantado la página siguiente** y el modelo se precarga (`warmUp`) mientras la visión analiza las primeras
páginas. El estado de cada página se guarda: una tarea interrumpida **se reanuda desde la última página terminada**. No hay
cola entre proyectos ni caché de OCR/traducciones (cada «forzar» repite todo).

## Sospechosos de la lentitud (hipótesis, **sin medir**)

No se atribuye la lentitud al modelo sin datos; hay al menos cinco candidatos con evidencia en el código:

1. **Generación del modelo de lenguaje en CPU.** `llama-server` corre en CPU en Android (`gpuLayers: 0`), con
   `llamaThreads = clamp(round(threads × 0,6), 2, 6)`. En un Helio G90T de 8 núcleos (2 rápidos + 6 lentos) salen **5 hilos**,
   y usar los núcleos lentos puede *empeorar* la velocidad. El prompt incluye contexto de dos páginas, resumen (hasta 12
   líneas) y glosario: la evaluación del prompt (*prefill*) puede pesar tanto como la generación.
2. **Segunda pasada de corrección** (`quality = max`): duplica las llamadas al modelo.
3. **Competencia por la CPU:** `warmUp` del modelo y la visión (WASM) corren a la vez en un teléfono con pocos núcleos rápidos.
4. **Manga OCR** (decodificador autorregresivo, ~440 MB) ejecutado por cada bloque en WebAssembly.
5. **Hilos de WASM:** solo se usan si la página está aislada (COOP/COEP, `crossOriginIsolated`); si no, el OCR y el detector
   corren con **1 hilo**. No está verificado que el `WebView` de Android lo active (ver [LIMITACIONES](LIMITACIONES.md)).

Nada de esto se da por cierto hasta medirlo: la siguiente sección explica cómo.

## Medición por etapa

Desde esta versión cada tarea guarda en `project.last_job.timings` los **segundos de análisis, traducción y reconstrucción de
cada página**, el número de textos, cuántos conservaron su original y los tokens/s del modelo (última llamada). El primer
trabajo sobre el Redmi Note 8 Pro debería ejecutarse con estos datos para decidir dónde optimizar (hilos de `llama`,
prefill, OCR, resolución del detector).

## Fase 3: protección de los diálogos (implementada y probada)

Regla: **el original solo se borra donde hay una traducción válida** (y, en el móvil, si cabe en el globo).

- `planClean` / `hasValidTranslation` (móvil) y `plan_clean` / `has_valid_translation` (PC): sin traducción, con traducción
  vacía, negativa del modelo (`refused`) o «sin traducir» (`untranslated`) → el texto **se conserva**.
- En el móvil, si la traducción no cabe en el globo con un tamaño legible (`regionFits`, el mismo cálculo del editor) →
  se conserva el original, se marca `no_fit` y queda en revisión (la traducción se guarda para que la acortes).
- Lo que la persona aprobó o editó **manda** (es una decisión suya, también si borró el texto a propósito).
- Los textos conservados reciben la marca `original_kept` y el rotulador **no dibuja** una traducción sobre ellos
  (se solaparían). La marca se recalcula en cada reconstrucción: corrige la traducción y vuelve a reconstruir.
- El original nunca se modifica (la página limpia es otro archivo) y, si falla una etapa, la página conserva su original.
- Las lecturas OCR vacías ya no se descartan: aparecen como regiones en revisión (`ocr_empty`).

**Pruebas ejecutadas** (todas automáticas, con visión y modelo simulados): 8 pruebas móviles nuevas y 4 del motor de PC, más
la suite completa: móvil 157/157, compartido 23/23, motor 73 pasan (14 se omiten por requerir modelos reales; 7 fallan
por un problema conocido de Windows con el servidor de lenguaje simulado, ajeno a este cambio). Lo que **no** está
probado: el comportamiento con el detector, el OCR y el rotulador **reales** en un teléfono (E2E en Chromium en CI, y
la prueba en el dispositivo).

## Fase 4: rendimiento y procesamiento por lotes (implementada y probada con piezas simuladas)

Estado honesto: **todo lo de abajo está implementado y verificado por pruebas automáticas con visión y modelo SIMULADOS**.
**No hay ninguna medición de tiempo real** (ni antes ni después) en el Redmi Note 8 Pro ni en otro equipo, así que **no se
afirma ninguna mejora de velocidad**: lo que sí está demostrado es *qué trabajo deja de hacerse* (llamadas al OCR y al modelo
evitadas) y que nada se pierde ni se estropea al hacerlo.

| Pieza | Qué hace | Estado |
|---|---|---|
| **Cola persistente** (`pipeline/queue.ts`, `LocalEngine.queue/resumeQueue/dismissQueue`) | Cada petición de procesar se guarda en disco (`queue/main`) y sigue el estado real de la tarea. Tras un cierre de la app, lo que estaba en cola o en ejecución pasa a *interrumpido* y `resumeQueue()` lo retoma **en el orden en que se pidió**; el progreso por página sigue en `RunState`. Cancelar (también una tarea aún no iniciada) no la deja pendiente; los proyectos borrados se descartan; historial acotado a 30 | 🧪 probado (5 pruebas de la cola + 4 de `LocalEngine`: cierre brusco con 2 proyectos, cancelación, error, descarte) |
| **Caché de OCR** (`pipeline/cache.ts`) | Clave = SHA-1 de la imagen + idioma + dirección + SFX + alto + **motor de lectura** (`fingerprint`: Manga OCR / PP-OCR por idioma). Guarda regiones, viñetas y máscara. «Forzar» la salta; un fallo de lectura **no se guarda**; entrada dañada o sin máscara → se vuelve a leer; tope de 400 entradas (las más antiguas se descartan) | 🧪 probado |
| **Caché de traducciones** (`translate/contextual.ts`) | Clave = hash de **los mensajes completos enviados al modelo** (incluye contexto de páginas, resumen, glosario, sinopsis) + modelo + temperatura + proveedor + calidad + imágenes. Un cambio de contexto es un fallo de caché. Solo se guardan respuestas **completas y sanas** (nada vacío ni rechazado). «Forzar» y retraducir a propósito la saltan. Tope de 1500 | 🧪 probado |
| **Gobernador de concurrencia** (`pipeline/governor.ts`) | Por defecto **todo en serie**. Solo se analiza la página siguiente mientras el modelo traduce la actual con ≥ 10,5 GB de RAM (móvil) / ≥ 16 GB (PC) **y** ≥ 2500 MB libres; con memoria baja vuelve a serie sin interrumpir. Nunca hay dos análisis ni dos peticiones al modelo a la vez. Resultado idéntico al de serie | 🧪 probado · ⚠ umbrales **sin calibrar** |
| **Precarga del modelo sin competir con el OCR** | En serie, el modelo se carga **después** de analizar la primera página (visión libre) y antes de traducir; con solapado permitido se precarga ya al principio. Una sola carga por tarea | 🧪 probado (orden de eventos) |
| **Llamadas redundantes eliminadas** | La decisión «enviar imagen al modelo» se toma una vez por tarea (antes, página a página); las respuestas idénticas salen de la caché; el análisis de la página siguiente no se repite | 🧪 probado |
| **Liberación de memoria** | Las páginas terminadas se sueltan del mapa en memoria; con poca memoria (aviso del sistema o `DeviceStatusGuard`) la visión descarta Manga OCR y LaMa (se recargan solos si hacen falta) y la tarea sigue sin perder páginas | 🧪 probado con el hook `trim` simulado · ⏳ efecto real sin medir |
| **Medición por etapa, página y capítulo** | `last_job.timings`: segundos por etapa y página, `ocr_cached`, `llm_calls`, `tr_cache_hits`; y `chapter`: total, carga del modelo, espera en cola, llamadas al modelo, aciertos/fallos de caché, páginas solapadas, recortes de memoria, mínimo de memoria libre y última decisión del gobernador | 🧪 probado |

**Reglas de integridad comprobadas con las cachés activas:** el original no se modifica nunca (imagen original idéntica tras
procesar; la reconstruida es otro archivo); un rechazo del modelo o una respuesta vacía no se guardan ni se reutilizan (se
vuelve a intentar y puede acertar); lo reutilizado pasa por las mismas reglas de borrado (`planClean`) que lo nuevo; una página
dañada se marca con error y no detiene el capítulo; una página sin textos no se toca.

**Pruebas añadidas** (`apps/mobile/test/unit/performance.test.ts`, 34, y 4 en `localengine.test.ts`): gobernador, orden de la
precarga, caché de OCR y de traducciones (aciertos, fallos por cambio de idioma/motor/contexto/calidad, fallos no guardados,
«forzar», tope), cola, memoria, capítulo de 40 páginas, 12 páginas con cancelación y reanudación (solo se rehace lo que falta),
capítulo con página dañada + rechazo + página vacía, reproceso de una copia sin OCR ni modelo, y dos proyectos simultáneos
(se serializan). Suite móvil completa: 195/195; compartido: 30/30; `tsc` sin errores.

**Lo que NO está hecho / NO verificado (no se marca como completado):**

- ⏳ **Ninguna medición de tiempo real** (ni antes/después). Las hipótesis de lentitud de arriba siguen sin confirmar.
- ⏳ Los umbrales del gobernador (10,5 GB, 16 GB, 2500 MB) y los tamaños de caché (400/1500) son **conservadores y sin calibrar**.
- ⏳ El efecto real de `trim` en el consumo de memoria del `WebView` y de Android no se ha medido.
- ⏳ Interfaz: el motor expone `queue()/resumeQueue()/dismissQueue()`, pero **no hay todavía un aviso en la pantalla de inicio**
  para peticiones que quedaron en cola sin llegar a empezar (las ejecuciones con progreso guardado ya ofrecen «Reanudar»).
  La reanudación **no** es automática al abrir la app, para no consumir batería sin que la persona lo decida.
- ⏳ El **motor de PC (Python)** no se ha tocado en esta fase: la cola y las cachés son del motor móvil.
- ⏳ No se ha optimizado la resolución del detector ni los recortes (sin datos que lo justifiquen aún).

## Pendiente (siguientes etapas)

Servicio en segundo plano (Fase 5, solo diseño: ver [DISENO-FASES-5-7](DISENO-FASES-5-7.md)); estilo visual (Fase 6);
actualizador (Fase 7); conjunto de pruebas reproducible y **medición en el Redmi Note 8 Pro** (Fase 8), que es lo que
permitirá decidir hilos de `llama`, prefill, resolución y los umbrales del gobernador.
