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

## Pendiente (siguientes etapas)

Cola persistente multi-proyecto, caché de OCR y traducciones, concurrencia limitada por RAM, optimización de resolución y
recortes (Fase 4); servicio en segundo plano (Fase 5); estilo visual (Fase 6); actualizador (Fase 7); conjunto de
pruebas reproducible y medición en el Redmi Note 8 Pro (Fase 8).
