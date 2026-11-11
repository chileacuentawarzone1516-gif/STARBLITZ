# Evaluación con un cómic real: *Ultimate Spider-Man* n.º 1 (2026-11-09)

Primera medición de STARBLITZ con un capítulo **real** de principio a fin en el PC del titular. Leyenda: **CONFIRMADO** (medido aquí,
con la salida guardada) · **PENDIENTE** · **NO VERIFICADO** · **ESTIMACIÓN** (cálculo a partir de medidas, no medido directamente).

> **Límites que condicionan todo lo de abajo.** (1) El cómic está **en inglés**, con rotulación occidental horizontal: **no** hay
> japonés vertical, coreano ni onomatopeyas japonesas. Nada de esto valida el detector experimental para manga o manhwa.
> (2) **No hay verdad de terreno humana.** Como referencia independiente se usa la **capa de texto OCR que trae el propio PDF**
> (la hizo quien lo escaneó; ruidosa e incompleta): solo es un **indicador** de cobertura, no una precisión. (3) La revisión de
> calidad (OCR, traducción, reconstrucción) la hice yo, Claude, mirando las páginas: **no es una evaluación humana ni nativa**.
> (4) Tiempos de **este PC** (i7-13620H, 16 hilos, 32 GB; visión en CPU con ONNX Runtime 1.31; Qwen3.5-4B en la RTX 4060 con
> `llama-server` b12017 Vulkan). **No representan al Redmi Note 8 Pro.**

> **Tres versiones.** §3–§10 describen la **línea base** (commit `42cde69`) y se conservan tal cual. §11 describe la **fase 2** (causas
> generales corregidas) y §12 la **fase 3** (robustez ante JSON inválido, globos, rotulado y comparación de modelos); cada una compara
> antes/después con el mismo capítulo, los mismos ajustes y el mismo modelo.

## 1. Corpus e integridad del original

| Dato | Valor |
|---|---|
| Archivo del titular | `01 - Ultimate Spider-Man v01 - Power & Responsibility (2009).pdf`, 27 526 264 bytes, 187 páginas |
| SHA-256 del original | `50439db049668db4d03addae461b1c7c56a6a5116c7515c1c8ceda4f36dd37b5` — **idéntico antes y después** (CONFIRMADO) |
| Copias de trabajo | fuera del repositorio (carpeta temporal de la sesión); el original no se abrió para escribir |
| Capítulo evaluado | n.º 1 = páginas **4–49** del PDF (46 páginas; 3 dobles páginas de 3000×2307 px y 43 de 1952×3000 px tras la importación) |
| Corpus reproducible | `tools/bench/corpus_eval.py` + el manifiesto con el SHA-256 de cada página importada (en `_evaluacion/`, fuera de Git). El cómic **no se sube** |
| No usado | El ZIP «DBZ» adjuntado antes: contenido sexual explícito; además estaba en inglés y no aportaba japonés/coreano |

## 2. Método

- **Pipeline real** del motor de escritorio a través de su **API** (FastAPI en el mismo proceso): importar el PDF → analizar → traducir →
  reconstruir. Se añadieron solo cronómetros alrededor de las funciones (no cambian resultados) y un muestreador de RAM/CPU cada 0,5 s.
- **Ajustes:** perfil `mid` (el del Redmi de 6 GB), reconstrucción `fast` (sin LaMa, como en el teléfono), dispositivo CPU, idioma `en`.
- **Comparación de detectores** en **pasadas solo de visión** (por defecto; experimental a 960 px y a 1600 px) con las mismas páginas, los mismos
  ajustes y el equipo sin otra carga: así los tiempos de visión no se mezclan con la generación del modelo de lenguaje (ver §6, P8).
- **Pipeline completo con traducción** (Qwen3.5-4B, el modelo por defecto del Redmi) con el detector **por defecto**.
- **Exportación** con el renderizador compartido de las apps (`renderPageBlob`, el mismo de «Exportar») en Chromium.
- **Tiempos de detección** con una medición A/B **intercalada** aparte (los dos detectores alternándose en cada página), porque el equipo
  cambia de velocidad durante las pasadas largas.
- **Paridad** del detector experimental entre el motor de PC (Python) y el móvil (TypeScript + WebAssembly, en Edge) sobre las 46 páginas.
- En las pasadas solo de visión el motor **no borra** nada (no hay traducción válida: protección de diálogos), así que el borrado se compara
  en una ejecución completa de 10 páginas con cada detector.

## 3. Rendimiento del pipeline completo (detector por defecto + Qwen3.5-4B) — CONFIRMADO

46/46 páginas importadas, analizadas, traducidas, reconstruidas y exportadas; **0 páginas con error**, ninguna interrupción.

| Etapa | Mediana por página | p90 | Máx. | Total capítulo |
|---|---|---|---|---|
| Importación (PDF → 46 PNG) | — | — | — | **246,5 s** (5,4 s/pág.; 189 s en una pasada sin el modelo de lenguaje cargado) |
| Detección | 5,37 s | 5,48 | 5,63 | 229 s |
| Viñetas + orden de lectura | 0,08 s | 0,09 | 0,10 | 3 s |
| OCR (PP-OCR inglés) | 6,44 s | 16,0 | 19,7 | 319 s |
| Asociación con globos | 1,22 s | 2,7 | 4,3 | 61 s |
| **Análisis total** | 12,9 s | 26,3 | 30,7 | 673 s |
| **Traducción** (Qwen3.5-4B en GPU) | 21,1 s | 40,9 | 54,8 | 960 s |
| Reconstrucción (relleno, sin LaMa) | 5,4 s | 11,8 | 13,7 | 262 s |
| **Total por página** | **38,0 s** | — | 94,7 | **1 906 s (31,8 min)** + importación |
| Rotulación y exportación (renderizador de las apps, Edge) | 0,56 s | — | 1,0 | ≈ 25 s |

- **Páginas complejas frente a simples:** las 5 más lentas (16–27 regiones con mucho texto) tardan 73–95 s; las páginas con ≤ 5 regiones,
  19 s de mediana; sin texto, 6–11 s (solo detección).
- **P8 — visión y traducción compiten por la CPU (CONFIRMADO):** con el modelo de lenguaje generando a la vez, la reconstrucción pasa de
  1,5 s a 5,4 s de mediana y la detección se queda en el régimen lento todo el capítulo. El motor solapa el análisis de una página con
  la traducción de otra; en un PC con GPU convendría fijar menos hilos de CPU a `llama-server` o bajar la prioridad del análisis.
- **Inestabilidad del equipo (CONFIRMADO, causa NO VERIFICADA):** la misma detección tarda 0,85 s o 5,4 s según el momento, para ambos
  detectores por igual (§5). Patrón compatible con la limitación de CPU de Windows a procesos en segundo plano (núcleos de eficiencia /
  EcoQoS). Si se confirma, afectaría al motor de escritorio cuando la ventana no está en primer plano.

## 4. Consumo de recursos — CONFIRMADO (muestreo cada 0,5 s)

| Proceso | RAM (RSS) máx. | RAM media | CPU media (100 % = 1 núcleo) |
|---|---|---|---|
| Motor, pasada solo visión, detector por defecto | **1 232 MB** | 924 MB | 316 % |
| Motor, pasada solo visión, detector experimental (1600 px) | **668 MB** | 493 MB | 314 % |
| Motor, pipeline completo | 1 303 MB | 1 056 MB | 152 % |
| `llama-server` (Qwen3.5-4B, `-c 16384`, 4 ranuras, Vulkan) | 11 407 MB* | 7 751 MB | 35 % |

\* RSS que informa Windows; incluye memoria compartida/mapeada con la GPU y depende de **mi** configuración de lanzamiento (contexto 16 384 ×
4 ranuras), no de la que usa la app. **Sin fuga apreciable:** la RAM del motor se estabiliza tras cargar los modelos y crece solo
9–30 MB entre el segundo y el último cuarto del capítulo (46 páginas). Cachés y concurrencia del **motor móvil** no intervienen aquí (son del motor TypeScript).

## 5. Comparación de detectores (mismas 46 páginas, mismos ajustes) — CONFIRMADO

| Métrica | Por defecto (`comic-text-detector`) | Experimental 960 px (ficha) | **Experimental 1600 px (adoptado)** |
|---|---|---|---|
| Páginas sin error | 46/46 | 46/46 | 46/46 |
| Regiones / líneas | 428 / 1 309 | 673 / 1 653 | 637 / 1 606 |
| Regiones asociadas a un globo | 299 | 319 | 292 |
| **Cobertura de la capa de texto del PDF** (1 478 palabras; indicador, no verdad de terreno) | **85,8 %** | 77,0 % | **85,5 %** |
| Regiones sin lectura del OCR | 1 | 7 | 27 |
| Fragmentos de ≤ 3 caracteres (solo en el experimental) | — | 141 | 173 |
| Regiones emparejadas con el otro detector / similitud del OCR | — | 398 / 0,76 | 394 / **0,91** |
| **Detección, A/B intercalado** (mediana; mínimo de 3 repeticiones) | **5,37 s** | — | **1,63 s (3,3× más rápido)** |
| Régimen rápido del equipo (págs. 13–15, 20–23) | 0,85–1,06 s | — | 0,20–0,44 s (≈ 4×) |
| RAM máx. del motor | 1 232 MB | 417 MB | 668 MB |
| Motor móvil (TypeScript + WASM 4 hilos en Edge) | ≈ 3,9 s (medida previa, página sintética) | — | **1,06 s** de mediana |
| Paridad Python ↔ TypeScript | (ya existente) | — | **1 606/1 607 líneas**, máscara IoU 0,9999 |

**Por qué 1600 px y no 960:** en la doble página «Powerless» (pág. 6 del PDF) a 960 px el modelo no veía la mitad de las líneas
(106/208 palabras de referencia); a 1 280 px, 202; a 1 600 px, 207 (= el detector por defecto). Ninguna otra página empeoró.

**Diagnóstico de la fragmentación (CONFIRMADO):** las líneas de PP-OCRv6 son más ajustadas al texto (≈ 25 px de grosor para una letra de
34 px) que las del detector por defecto, así que el hueco entre líneas de un mismo globo supera la regla de agrupación (0,8× el grosor).
Subir el umbral a 1,2× reduce poco las regiones (637 → 587) y **mezcla globos distintos** (9 → 21 casos): no sirve. Además, un bloque de
una sola línea no encuentra su globo (`find_bubble` descarta un globo de más de 6× el área del bloque). Ambas cosas quedan como
**fallos esperados** en `engine/tests/test_manga_det.py` hasta que se agrupe por globo.

**Pipeline completo con ambos detectores en las mismas 10 páginas** (págs. 6, 9, 12, 14, 17, 19, 24, 26, 31 y 42 del PDF; misma
traducción con Qwen3.5-4B; CONFIRMADO):

| Métrica (10 páginas) | Por defecto | Experimental 1600 px |
|---|---|---|
| Regiones / asociadas a globo | 139 / 102 | 197 / 116 |
| Regiones con el original conservado (sin traducción válida) | 13 (todas en la pág. 17, por el fallo de traducción de §7) | 7 |
| Textos rotulados que no caben | 40 | 43 |
| Tiempo total (análisis + traducción + reconstrucción) | 549 s | 557 s |
| Pico de RAM del motor | 1 303 MB (capítulo entero) | 707 MB |

Con traducción, el ahorro de la detección se compensa con las regiones extra (más llamadas y más texto partido): **el tiempo total no
mejora** hoy. El borrado y el rotulado se ven equivalentes en las páginas revisadas (comparativas en `_evaluacion/…/comparativas/`).
La pág. 17 no repitió el desplazamiento de traducciones con el experimental: ese fallo es del modelo de lenguaje (no determinista), no
del detector.

**Conclusión:** el experimental es claramente más rápido y ligero y, a 1 600 px, cubre el mismo texto de referencia, pero **todavía no
puede sustituir al predeterminado**: trocea los globos, pierde la asociación con el globo en bloques de una línea y deja más regiones sin
lectura. Además, este corpus no tiene japonés, coreano ni texto vertical. **El predeterminado no cambia.**

## 6. Calidad del reconocimiento (OCR) — revisión de Claude, NO humana

Sin verdad de terreno no se da un porcentaje de acierto. Observado en la salida (PP-OCR inglés):
- **Confusiones de letras frecuentes** en la rotulación de cómic: «TWC» (TWO), «TOTALL» (TOTALLY), «DEFINITELS», «WELI», «DESTROYEI»,
  «SAU» (SAW), «LIKEA» (palabras pegadas). El modelo de lenguaje corrige muchas, pero no todas (ver §7).
- **Texto inventado a partir de ruido:** «CEREDE» → traducido como «Cerebro»; el logo «STAN LEE PRESENTS» se clasificó como onomatopeya.
- **Texto sobre dibujo y logotipos:** el título «POWERLESS» se leyó y se tradujo (mal: «¡IMPOTENTE!»).
- **Onomatopeyas:** detectadas pocas (15 regiones `sfx` con el experimental); las dibujadas grandes («BLUUAAG», «BLAAHH!») solo las vio el
  detector por defecto.
- Texto vertical y japonés/coreano: **NO VERIFICADO** (no hay en el corpus).

## 7. Calidad de la traducción (Qwen3.5-4B, es-419) — revisión de Claude, NO humana

| Aspecto | Observado |
|---|---|
| Fidelidad general | Buena en diálogos sencillos y narración larga (mito de Aracne, discurso de Osborn) |
| **Errores graves** | **Pág. 17 del PDF: traducciones desplazadas e inventadas** — al cartel «PARKER HOME, FOREST HILLS, QUEENS» le asigna «¿Peter? ¿Peter?… ¿Qué dijimos sobre leer en la mesa?», y otras 12 regiones de la página quedan sin traducir (`original_kept`). El texto inventado acabaría rotulado en el globo equivocado |
| Nombres propios | «Queens» → «REYES»; «Mary Jane» → «MARÍA-JANE» en unas páginas y «Mary Jane» en otras (inconsistente) |
| Género | «ARE YOU SWEET ON HIM, HARRY?» → «¿ESTÁS **ENAMORADA** DE ÉL, HARRY?» (Harry es varón) |
| Modismos | «I'M HUGE IN THE DOGHOUSE» → «¡Soy gigante en casa!»; «DON'T YOU LOOK LIKE A MILLION DOLLARS» → «¿NO TE VUELVES A MILLÓN DE DÓLARES?»; «YOU DID GREAT» → «¡ESTÁS GENIAL!» |
| Variante de español | Aparece **voseo peninsular** pese a es-419: «¿NO TENÉIS PRÁCTICAS? ¡ID A JUGAR!» |
| Palabras inexistentes / erratas | «CUENTARTE», «BÚLMEME», «ENOYARLO», «PROYECTUCIÓN», «DESCUBRIIMIENTO» |
| Mayúsculas | Unas páginas salen en MAYÚSCULAS y otras en minúsculas (el original es todo mayúsculas) |
| Insultos / tono | «JERKHOLE TEAM MATES» → «tóxicos» (suavizado); «WHAT A DOG» → «¡Qué perro!» (literal) |
| Marcas | 323 de 428 regiones quedaron «en revisión»; **296 por `too_long`**: la traducción española supera el límite de caracteres estimado en casi todas las regiones, así que la marca deja de ser útil |

## 8. Reconstrucción y rotulado — CONFIRMADO en las imágenes exportadas

- **Borrado:** en globos blancos queda limpio, sin restos visibles en las páginas revisadas (págs. 9, 12, 17, 19, 27 y 45 del PDF).
  Las 14 regiones sin traducción válida **conservan el original** (protección de diálogos, correcto).
- **Rotulado:** 405 textos dibujados con las tipografías incluidas; **146 (36 %) no caben** en su caja ni al tamaño mínimo (desbordan).
  Se ven **superposiciones** de dos textos cuando dos globos están pegados (pág. 12 del PDF: «¿QUÉ HACES AQUÍ?» sobre «CREÍ QUE ME
  ESTABAS DEJANDO AQUÍ»; un recuadro de narración pisado por un diálogo vecino).
- Globos vacíos o pérdida de contenido: no observados en las páginas revisadas; las páginas sin texto se exportan iguales al original.
- Comparativas visuales (solo en el equipo del titular, **no** en el repositorio): `_evaluacion/2026-11-09-usm-cap01/comparativas/` y
  las 46 páginas traducidas en `…/traducidas/`.

## 9. Integridad y estabilidad — CONFIRMADO

- Original intacto (SHA-256 igual antes y después); copias de trabajo fuera del repositorio; nada del cómic se sube.
- 4 ejecuciones completas del capítulo (2 de visión, 1 a 1 600 px, 1 con traducción) + 1 de 10 páginas: **0 páginas fallidas, 0 cuelgues**.
- Una ejecución anterior se **interrumpió a propósito** por el fallo P7 (generación desbocada): el motor lo dejó registrado como ejecución en
  curso y una ejecución nueva empezó de cero sin problemas. La reanudación tras interrupción ya está cubierta por pruebas automáticas; no se
  repitió aquí.

## 10. Recomendaciones técnicas (por prioridad, basadas en lo medido)

1. **Agrupar las líneas del detector experimental por globo** antes de evaluarlo con manga y manhwa (resolvería la fragmentación y la
   asociación con globos). Después, corpus **real** en japonés y coreano.
2. **Traducción:** detectar respuestas desalineadas (el número de textos devueltos no cuadra o el contenido no se parece al origen) y
   reintentar la página; forzar es-419 (prohibir vosotros) y mantener nombres propios con el glosario automático.
3. **Recalibrar `too_long`** para traducciones al español (la marca salta en 7 de cada 10 regiones) y mejorar el ajuste del rotulado
   (36 % no cabe): permitir usar más área del globo o reducir más el cuerpo antes de desbordar.
4. **P8:** separar recursos de visión y del modelo de lenguaje en el PC (menos hilos para `llama-server` cuando usa la GPU).
5. Comprobar la hipótesis de limitación de CPU de Windows en segundo plano y, si se confirma, pedir al sistema que no limite el motor.
6. OCR inglés: probar el reconocedor `manga_rec` de PP-OCRv6 u otro entrenado con rotulación de cómic (las confusiones C/O, L/I son el
   origen de varios errores de traducción).

## 11. Fase 2 (2026-11-09): causas generales y antes/después — CONFIRMADO

Mismo capítulo (46 páginas), mismos ajustes (perfil `mid`, reconstrucción `fast`, CPU para visión) y mismo modelo (Qwen3.5-4B en la GPU).
Se buscaron **causas generales**, no arreglos por página; cada una tiene pruebas automáticas y, cuando afecta a los dos motores, la misma
lógica en Python y TypeScript (casos de paridad).

### 11.1 Causas encontradas y corregidas

| Problema observado | Causa general | Corrección |
|---|---|---|
| El «globo» era la silueta del texto; la traducción no podía usar el globo | El color de fondo se medía en un anillo exterior que, en globos ajustados al texto, cae sobre el dibujo | Fondo = papel visible **entre las letras** del propio bloque; el anillo, solo como respaldo |
| Globos grandes con poco texto sin asociar | La búsqueda descarta globos de más de 6× el bloque | Segundo intento con búsqueda ampliada, aceptado **solo si no contiene el texto de otra región** |
| Traducciones superpuestas | Las cajas de rotulado de globos pegados se pisaban | Corte por la línea media entre los textos originales; nunca por debajo del texto original |
| 36 % de textos que no cabían, exportados desbordados | Letra mínima fija (0,8 % de la página) mayor que el rotulado condensado original; margen interior aplicado dos veces | Mínimo hasta el 75 % del cuerpo original (suelo 0,5 % de la página), tipografía condensada de reserva, margen solo contra el contorno del globo; al exportar, lo que no cabe se deja con el **original restaurado** |
| `too_long` en 7 de cada 10 textos | La estimación de caracteres suponía una letra más grande que la mínima del maquetador | Misma letra mínima en la estimación |
| Traducciones desplazadas o inventadas (pág. 17: el modelo tradujo la página siguiente) | Las respuestas se asignaban solo por número, sin comprobar nada | Eco `src_start` + comprobaciones (desalineación, invención, «vosotros» en es-419, nombres propios) + **una** llamada de reparación; si sigue mal, no se usa y se conserva el original |
| Mayúsculas al azar | Dependía del modelo | Se copia el uso de mayúsculas del original |
| Nombres traducidos, género, es-419 | Instrucciones insuficientes | Instrucciones explícitas (nombres propios sin traducir, concordancia de género, sin «vosotros»), con ejemplos genéricos |

### 11.2 Pipeline completo con el detector por defecto (46 páginas) — antes → después

| Métrica | Línea base | Fase 2 |
|---|---|---|
| Páginas con error | 0 | 0 |
| Textos **en revisión** / traducidos sin marcas | 323 / 105 | **95 / 333** |
| Marca `too_long` | 296 | **67** |
| Sin traducción (`untranslated`) | 13 | **0** |
| Original conservado en el dibujo (`original_kept`) | 14 | **1** |
| «vosotros» en la salida final (es-419) | 1 | 1 (detectado y **marcado para revisión**: la reparación no lo corrigió) |
| Traducciones con mayúsculas distintas del original | 316 | **0** |
| Pares de cajas de rotulado solapadas | 77 | **21** (quedan los de textos que ya se solapan en el original) |
| Límite de caracteres (mediana) | 12 | 27 |
| Globos mayores que su texto (globo real) | 189 | 205 |
| **Textos que no caben** al exportar | 146 (dibujados desbordados) | **51** (exportados con el **original restaurado**) |
| Textos rotulados | 405 (incl. 146 desbordados) | 367, todos dentro de su caja |
| Llamadas de reparación | — | ≈ 2 páginas de 41 (ESTIMACIÓN a partir del registro de `llama-server`) |
| Traducción (mediana por página) | 21,1 s | 22,3 s |
| Pico de RAM del motor | 1 303 MB | 1 308 MB |

Los **tiempos totales no son comparables** entre ejecuciones (el equipo cambió de régimen de velocidad: la detección de la línea base corrió
en el régimen lento, 5,4 s, y la nueva en el rápido, 0,86 s); la comparación de detectores usa el A/B intercalado (§11.3).

**Calidad de traducción (revisión de Claude, no humana):** desaparecen las traducciones desplazadas e inventadas de la pág. 17 (ahora cada
globo lleva la suya) y los cambios de nombres en las páginas revisadas; las mayúsculas son coherentes. **Persisten** los errores de
comprensión del modelo de 4B: concordancia de género («¿TE VA A DEJAR A LA NIÑA SOLO?»), modismos («¡SOY UN MONSTRUO EN CASA!» por
*I'm in the doghouse*), palabras inventadas («CUENTARTE») y errores heredados del OCR («HE PARKER HOME» → «PETER PARKER ESTÁ EN CASA»).
Eso ya no es estructural: depende del modelo y del OCR.

**Visual:** comparativas original / antes / después en `_evaluacion/2026-11-09-usm-cap01/fase2/comparativas/` (págs. 9, 12, 17, 19, 27 y 45
del PDF) y las 46 páginas nuevas en `…/fase2/traducidas/`. Solo en el equipo del titular.

### 11.3 Detector experimental (PP-OCRv6 Manga) — antes → después

| Métrica (46 páginas) | Fase 1 (1600 px) | Fase 2 | Detector por defecto (fase 2) |
|---|---|---|---|
| Regiones | 637 | **544** | 428 |
| Fragmentos de ≤ 3 caracteres | 173 | **129** | — |
| Regiones sin lectura del OCR (solo visión) | 27 | **20** | 1 |
| Pares de cajas de rotulado solapadas | 127 | **33** | 22 |
| Cobertura de la capa de texto del PDF (indicador) | 85,5 % | **85,8 %** | 85,8 % |
| Paridad Python ↔ TypeScript | 1 606/1 607 líneas | **1 576/1 576** líneas, 544/544 bloques (±1 en 2 páginas), máscara IoU 0,9999 | — |
| Memoria WebAssembly en el motor móvil (46 páginas seguidas) | — | **plana** (OpenCV.js 128 MB, JS ≈ 37 MB) | — |
| Detección, A/B intercalado (mediana) | 1,63 s frente a 5,37 s (**3,3×**) | 1,07 s frente a 1,30 s (**1,24×**) | — |
| Pico de RAM del motor, pipeline completo | — | **942 MB** | 1 308 MB |
| Pipeline completo: páginas con error | — | **1** (JSON inválido del modelo tras el reintento; el capítulo siguió y la página conservó el original) | 0 |
| Pipeline completo: textos en revisión / OCR sospechoso / sin lectura / original conservado | — | 143 / 74 / 20 / 21 | 95 / 7 / 1 / 1 |
| Textos que no caben al exportar | — | 37 | 51 |

- La **agrupación por globo** une las líneas sueltas de un mismo globo y el **filtro de ruido** quita líneas diminutas fuera de globo;
  ambas reducen la fragmentación, pero **cuestan tiempo**: la ventaja de velocidad baja de 3,3× a 1,24×. Una segmentación de toda la
  página por color de papel se probó y se descartó (igual de lenta y peor agrupación).
- Con traducción, el texto más troceado da **más OCR sospechoso** y más regiones sin traducción segura. **Veredicto: sigue
  desactivado por defecto**; no supera al detector por defecto en calidad.
- Incidencia **no reproducida**: en una primera pasada de paridad, Edge cerró la página tras 25 de 46 (el equipo estaba ejecutando a
  la vez el pipeline completo). Al repetirla, las 46 páginas pasaron con la memoria plana.

### 11.4 Lo que queda (PENDIENTE)

1. Errores de comprensión del modelo de 4B (género, modismos, palabras inventadas): probar un modelo mayor en el PC (Qwen 9B) y
   evaluación humana.
2. 51 textos (12 %) no caben ni con letra condensada y se exportan con el original: revisar el ajuste de globos muy estrechos y la
   reescritura más corta por parte del modelo.
3. Una respuesta JSON inválida tras el reintento hace fallar la página entera: falta una alternativa (p. ej. traducir esa página por
   textos sueltos o en texto plano).
4. Manga y manhwa reales (japonés vertical, coreano) para valorar el detector experimental donde importa.

## 12. Fase 3 (2026-11-10): robustez, calidad de traducción y reconstrucción — CONFIRMADO salvo lo marcado

Mismo capítulo (46 páginas), mismos ajustes (perfil `mid`, reconstrucción `fast`, CPU para la visión) y mismo modelo (Qwen3.5-4B, mismo
lanzamiento de `llama-server` que la línea base). La línea base de la fase 2 se conserva (§11, datos en `_evaluacion/…/fase2/`).

### 12.1 Causas encontradas y corregidas (generales, con pruebas y paridad Python ↔ TypeScript)

| Problema | Causa | Corrección |
|---|---|---|
| Una respuesta JSON inválida hacía fallar la página (PC) y **detenía todo el capítulo** (móvil) | Error genérico tras un único reintento; en el móvil, `LLMUnavailableError` | `InvalidJSONError` con las respuestas en bruto; sin reintento si se cortó por el tope; rescate de los elementos completos con el eco de SU original; los que faltan, **uno a uno** (2 intentos, 512 tokens, ≤ 24 por página); lo no recuperado conserva el original |
| **93 de 301 «globos» eran la silueta del texto** (globos llenos de texto) | Dispersión del papel medida con la media (el antialias la inflaba: 23 > 22) y la cola del globo rompía la prueba de convexidad | Dispersión robusta (mediana) y apertura del tamaño de la letra antes de medir la convexidad; un globo debe **contener** su texto |
| **14 textos rotulados en blanco dentro de globos blancos** (ilegibles) y manchas oscuras al borrar | El color de la letra y del relleno salía del anillo exterior, que en esos globos cae sobre la viñeta | Tono del fondo = papel entre letras (`text_tone`); con globos bien detectados el relleno es su color real |
| Traducciones basura («¡¡¡¡¡¡») y frases cortadas («ASEGÚRATE DE QUE») rotuladas | Sin control | Controles `garbled` (bloqueante) e `incomplete` (pide reparación) |
| «VEIS» (vosotros sin tilde) no se detectaba; falso positivo con «SPINF.OS» | Patrón incompleto; texto copiado del original | Monosílabos añadidos; no se marca si el original ya contiene la forma |
| 21 pares de traducciones montadas | Si los textos originales se tocaban, la separación de cajas no actuaba | Si solo se rozan (≤ 25 % del menor), corte por el centro del solape; si después no cabe, se exporta el original |
| 51 textos no cabían | Globos mal detectados (caja = texto original), margen interior fijo y tope del cuerpo mínimo (24 px) por encima de la letra pequeña del propio cómic | Globos reales; último intento con margen estrecho; tope 0,72 % de la página (el 10 % de la letra de diálogo del cómic ya mide ≤ 22 px); **comprobación de encaje con las métricas reales de las tipografías** y **reformulación breve** solo de lo que no cabe, aceptada solo si cabe y no pierde contenido |

### 12.2 Pipeline completo, detector por defecto, 46 páginas — fase 2 → fase 3

| Métrica | Fase 2 (línea base) | Fase 3 |
|---|---|---|
| Páginas con error | 0 | **0** |
| «Globos» que eran la silueta del texto (de 428 regiones) | 93 | **7** |
| Regiones con globo real asociado | 301 | **386** |
| Textos en revisión | 95 | **25** |
| Marca `too_long` | 67 | **5** |
| Sin traducir / original conservado sin borrar | 0 / 1 | 0 / 1 |
| Textos rotulados | 367 | **415** |
| **Textos que no caben** (exportados con el original restaurado) | **51** | **7** |
| Pares de cajas de rotulado solapadas | 21 | **5** |
| Texto blanco dentro de un globo claro (ilegible) | 14 | **0** |
| «vosotros» en la salida (es-419) | 0 | 2 (detectados y **marcados para revisión**; el modelo los repitió tras la reparación) |
| Respuestas JSON inválidas / rescatados / recuperados / perdidos | — (no se contaba) | 3 / 3 / 17 / 0 |
| Traducción: mediana por página / p90 / total | 22,3 s / 34,7 s / 922 s | 21,0 s / 37,2 s / 1 075 s |
| Pico de RAM del motor / `llama-server` (RSS) | 1 308 / 11 393 MB | 1 292 / 11 317 MB |
| VRAM usada (toda la GPU) | no medida | 3,5 GB |
| Rotulado y exportación, mediana por página | 0,45 s | 0,37 s |

Cómo se midió la última columna: pipeline completo con el código final salvo la regla de «textos que apenas se rozan» de
`separate_layouts`, que se añadió tras la inspección visual; su efecto se midió aplicándola a las mismas 46 páginas ya traducidas y
volviendo a exportar (las traducciones no cambian): solapes 21 → 5 y un texto más con el original conservado (6 → 7: «¿POR QUÉ?»,
que deja «WHY?»). Una primera pasada de la fase 3, sin los cambios posteriores a la inspección, dio 11 textos que no caben.

Tiempos: el equipo alterna regímenes de velocidad (§3); la visión no es comparable entre ejecuciones. La traducción sí (mismo modelo y
servidor): el total sube un 17 % (922 → 1 075 s) por las llamadas de recuperación (17 textos pedidos uno a uno tras 3 respuestas cortadas) y de reparación; la mediana por página baja.

### 12.3 Recuperación ante JSON inválido en ejecuciones reales — CONFIRMADO

| Ejecución (46 páginas) | Respuestas inválidas | Textos rescatados | Recuperados uno a uno | Perdidos | Páginas con error |
|---|---|---|---|---|---|
| Fase 2, detector experimental (antes de esta fase) | 1 | — | — | página entera | **1** |
| Qwen3.5-4B, configuración de la app, detector por defecto | 3 (cortadas por el tope) | 11 | 30 | 0 | 0 |
| Qwen3.5-4B, análisis del detector experimental | 2 (cortadas) | 24 | 13 | 0 | 0 |
| Qwen3.5-9B | 1 (cortada) | 0 | 16 | 0 | 0 |
| Gemma 4 E4B / 12B | 0 | — | — | — | 0 |
| Pipeline completo final (§12.2) | 3 (cortadas) → 3 rescatados, 17 recuperados, 0 perdidos, 0 páginas con error | | | | |

Causa observada en los casos reales: la respuesta llega al tope de 4 096 tokens (`finish_reason = length`); repetir la misma petición
volvería a cortarse, por eso se rescata y se recupera por textos.

### 12.4 Inspección visual de las 46 páginas (Claude, no humana)

Revisadas las 46 páginas exportadas, lado a lado con la fase 2 (láminas fuera del repositorio). **Mejoras vistas:** globos que antes quedaban
en blanco (texto blanco sobre blanco: págs. 6, 14, 18, 28, 29 del PDF) ahora legibles; desaparecen las manchas oscuras del borrado (págs. 22,
29) y los textos montados (págs. 20, 42); muchos globos que se dejaban en inglés por no caber ahora se traducen con letra mayor (págs. 5, 6, 12,
13, 19, 27–29, 33–35, 46). **Defectos vistos en la primera pasada de la fase 3, corregidos después:** una onomatopeya enorme (pág. 24
«HHUAGGH!») se tomó por diálogo y se borró a medias (regla de contención del globo); «¡¡¡¡¡¡» rotulado (pág. 9, control `garbled`).
Ejecución final, revisadas otra vez las 46 páginas: la onomatopeya de la pág. 24 queda intacta; **quedan** «¡GOOOOAL!» de la pág. 13
(onomatopeya cuyo «globo» es su propia silueta: se borra y se rotula como diálogo; igual que en la fase 2 — una regla para tratarla como
onomatopeya convertía también en onomatopeyas dos diálogos gritados, «STOP. IT.» y «FINE», y se descartó), 5 pares de textos que comparten
globo y 2 «vosotros» marcados para revisión. Las páginas sin texto se exportan idénticas al original (comprobado píxel a píxel en la pág. 4).

### 12.5 Calidad de la traducción (Qwen3.5-4B; revisión de Claude, no humana)

Lo estructural está resuelto (asociación, recuperación, controles). Siguen los errores **del modelo de 4B**: modismos literales
(*million dollars*, *doghouse*, *coulda fooled me*), palabras inexistentes («LO SEO», «PUSSELO», «SUCIENO», «PUEZES»), algún cambio de
sentido y nombres alterados por el OCR («LA OZA»). No se corrigen con reglas sin un modelo mejor: ver la comparación de modelos en
[MODELOS-INVESTIGACION](MODELOS-INVESTIGACION.md#modelos-mayores-que-qwen35-4b-en-el-pc-rtx-4060-laptop-8-gb--2026-11-10)
(Gemma 4 E4B: ≈ 3–4 errores en una muestra de 30 frente a ≈ 13 del 4B, más rápida; no se cambia el predeterminado sin decisión del titular).

### 12.6 Lo que queda (PENDIENTE)

1. Errores de comprensión y erratas del modelo de 4B (§12.5). Con datos, el candidato es **Gemma 4 E4B** en PC con GPU; requiere
   evaluación humana nativa y decisión del titular (no se cambia el predeterminado).
2. 7 textos siguen sin caber (letra mínima legible alcanzada; se exporta el original, nunca recortado ni desbordado).
3. Onomatopeyas grandes cuyo «globo» es su silueta (1 caso: «GOOOOAL»), 7 «globos» degenerados en total.
4. «vosotros» que el modelo repite tras la reparación: se marca para revisión pero se rotula; decidir si debe bloquear.
5. Manga y manhwa reales (japonés vertical, coreano) y otros cómics: este corpus es uno solo, en inglés.
6. Teléfono real: nada de esta fase se ha medido en el Redmi (lo hace el titular).

## Anexo A. Tabla por página

Página del PDF; «Ref.» = palabras de la capa de texto del PDF (indicador); detección A/B = mínimo de 3 repeticiones intercaladas;
análisis, traducción, reconstrucción y total = pipeline completo (detector por defecto + Qwen3.5-4B); «Revisión» = regiones en revisión /
total; «No caben» = textos rotulados que desbordan su caja. Las páginas sin texto no tienen traducción ni reconstrucción.

| Pág. (PDF) | Tamaño | Ref. | Regiones def./exp. | Cubre ref. def./exp. | Detección A/B (s) def./exp. | Análisis (s) | Traducción (s) | Reconstr. (s) | Total (s) | Revisión | No caben |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 4 | 1952×3000 | 0 | 0/6 | 0/0 | 5.38/1.68 | 11.4 | — | — | 11.4 | 0/0 | 0 |
| 5 | 1952×3000 | 167 | 16/19 | 154/153 | 5.52/1.67 | 30.7 | 44.9 | 11.7 | 87.3 | 15/16 | 4 |
| 6 | 3000×2307 | 208 | 14/33 | 207/207 | 5.42/2.03 | 27.2 | 42.9 | 8.7 | 78.8 | 14/14 | 9 |
| 7 | 1952×3000 | 0 | 0/3 | 0/0 | 5.33/1.47 | 6.4 | — | — | 6.4 | 0/0 | 0 |
| 8 | 1952×3000 | 15 | 5/9 | 10/10 | 5.33/1.51 | 10.4 | 14.0 | 4.4 | 28.7 | 3/5 | 2 |
| 9 | 1952×3000 | 12 | 20/21 | 11/11 | 5.43/1.59 | 23.9 | 32.7 | 12.4 | 69.0 | 13/20 | 6 |
| 10 | 1952×3000 | 1 | 5/6 | 0/0 | 5.32/1.64 | 12.0 | 14.0 | 5.4 | 31.3 | 5/5 | 1 |
| 11 | 1952×3000 | 0 | 4/12 | 0/0 | 5.28/1.56 | 10.6 | 14.7 | 3.5 | 28.8 | 4/4 | 0 |
| 12 | 1952×3000 | 73 | 16/17 | 71/71 | 5.31/1.64 | 22.1 | 32.0 | 10.9 | 65.0 | 14/16 | 7 |
| 13 | 1952×3000 | 15 | 16/17 | 11/11 | 1.06/0.27 | 22.9 | 38.8 | 10.5 | 72.1 | 14/16 | 5 |
| 14 | 1952×3000 | 123 | 18/21 | 109/108 | 0.84/0.26 | 29.7 | 37.9 | 10.5 | 78.2 | 14/18 | 4 |
| 15 | 1952×3000 | 1 | 8/10 | 0/0 | 0.85/0.21 | 12.1 | 18.9 | 5.1 | 36.2 | 6/8 | 1 |
| 16 | 1952×3000 | 0 | 6/8 | 0/0 | 5.47/1.57 | 13.1 | 15.8 | 2.9 | 31.9 | 3/6 | 1 |
| 17 | 1952×3000 | 40 | 17/25 | 35/35 | 5.57/1.70 | 19.5 | 14.8 | 3.3 | 37.6 | 17/17 | 4 |
| 18 | 1952×3000 | 18 | 11/16 | 17/17 | 5.36/1.71 | 15.0 | 21.1 | 8.4 | 44.5 | 7/11 | 4 |
| 19 | 3000×2307 | 63 | 27/34 | 25/25 | 5.51/1.68 | 26.2 | 54.8 | 13.7 | 94.7 | 14/27 | 5 |
| 20 | 1952×3000 | 48 | 12/24 | 42/42 | 0.99/0.44 | 22.1 | 28.6 | 6.8 | 57.4 | 10/12 | 6 |
| 21 | 1952×3000 | 21 | 11/8 | 21/21 | 0.87/0.21 | 18.9 | 19.8 | 6.9 | 45.6 | 6/11 | 3 |
| 22 | 1952×3000 | 50 | 6/6 | 46/46 | 0.89/0.20 | 18.5 | 15.2 | 4.7 | 38.4 | 6/6 | 1 |
| 23 | 1952×3000 | 1 | 2/8 | 0/0 | 0.87/0.21 | 9.4 | 8.9 | 13.5 | 31.7 | 0/2 | 0 |
| 24 | 1952×3000 | 0 | 10/18 | 0/0 | 5.38/1.66 | 12.8 | 20.3 | 7.2 | 40.3 | 4/10 | 0 |
| 25 | 1952×3000 | 35 | 7/10 | 35/35 | 5.45/1.62 | 14.6 | 18.2 | 4.4 | 37.1 | 5/7 | 1 |
| 26 | 1952×3000 | 59 | 9/21 | 23/21 | 5.31/1.68 | 17.3 | 19.8 | 6.7 | 43.8 | 7/9 | 2 |
| 27 | 1952×3000 | 106 | 18/16 | 96/96 | 5.57/1.71 | 26.6 | 36.1 | 9.9 | 72.6 | 15/18 | 9 |
| 28 | 1952×3000 | 4 | 8/9 | 4/4 | 5.41/1.61 | 13.9 | 26.9 | 5.4 | 46.2 | 8/8 | 5 |
| 29 | 1952×3000 | 99 | 14/14 | 99/99 | 5.43/1.72 | 23.5 | 28.9 | 6.3 | 58.7 | 12/14 | 9 |
| 30 | 1952×3000 | 6 | 17/20 | 6/6 | 5.38/1.76 | 21.0 | 32.0 | 6.8 | 59.8 | 16/17 | 4 |
| 31 | 1952×3000 | 0 | 0/0 | 0/0 | 5.36/1.46 | 6.3 | — | — | 6.3 | 0/0 | 0 |
| 32 | 1952×3000 | 10 | 4/17 | 0/2 | 5.35/1.68 | 10.1 | 10.7 | 4.4 | 25.2 | 1/4 | 0 |
| 33 | 1952×3000 | 16 | 7/11 | 16/16 | 6.09/1.65 | 12.7 | 21.8 | 1.5 | 36.0 | 7/7 | 3 |
| 34 | 1952×3000 | 42 | 17/21 | 30/30 | 5.36/1.64 | 20.0 | 30.0 | 3.9 | 53.9 | 15/17 | 8 |
| 35 | 1952×3000 | 62 | 9/11 | 49/47 | 5.50/1.62 | 2.9 | 16.4 | 2.2 | 21.5 | 7/9 | 8 |
| 36 | 1952×3000 | 0 | 4/9 | 0/0 | 5.33/1.67 | 1.7 | 9.8 | 2.0 | 13.5 | 3/4 | 1 |
| 37 | 1952×3000 | 31 | 15/16 | 19/19 | 5.47/1.55 | 2.8 | 25.8 | 3.6 | 32.2 | 9/15 | 5 |
| 38 | 1952×3000 | 14 | 11/10 | 14/14 | 5.39/1.70 | 14.4 | 21.5 | 8.1 | 44.0 | 7/11 | 4 |
| 39 | 1952×3000 | 0 | 3/4 | 0/0 | 5.41/1.54 | 9.1 | 9.3 | 2.9 | 21.4 | 3/3 | 3 |
| 40 | 1952×3000 | 0 | 1/9 | 0/0 | 5.36/1.68 | 8.4 | 7.2 | 2.1 | 17.6 | 1/1 | 0 |
| 41 | 1952×3000 | 0 | 0/15 | 0/0 | 5.30/1.58 | 6.2 | — | — | 6.2 | 0/0 | 0 |
| 42 | 1952×3000 | 8 | 8/7 | 6/5 | 5.31/1.66 | 11.3 | 18.7 | 5.2 | 35.1 | 2/8 | 3 |
| 43 | 1952×3000 | 1 | 4/5 | 0/0 | 5.39/1.66 | 11.0 | 13.8 | 4.1 | 28.9 | 3/4 | 1 |
| 44 | 3000×2307 | 21 | 13/22 | 21/21 | 5.33/1.94 | 3.3 | 41.5 | 11.8 | 56.6 | 9/13 | 1 |
| 45 | 1952×3000 | 50 | 12/26 | 49/49 | 5.39/1.66 | 17.4 | 25.4 | 8.9 | 51.6 | 10/12 | 8 |
| 46 | 1952×3000 | 18 | 11/18 | 18/18 | 5.30/1.60 | 16.0 | 21.2 | 5.6 | 42.8 | 7/11 | 5 |
| 47 | 1952×3000 | 35 | 10/11 | 24/24 | 5.44/1.61 | 12.5 | 26.7 | 4.2 | 43.5 | 7/10 | 2 |
| 48 | 1952×3000 | 0 | 0/7 | 0/0 | 5.44/1.55 | 6.2 | — | — | 6.2 | 0/0 | 0 |
| 49 | 1951×3000 | 5 | 2/7 | 0/0 | 5.47/1.54 | 9.2 | 8.6 | 1.6 | 19.4 | 0/2 | 1 |

## Anexo B. Reproducir

```bash
# 1. Servidor de lenguaje (el de la app): llama-server -m Qwen3.5-4B-Q4_K_M.gguf --port 8081 -ngl 99 -c 16384 --jinja
# 2. Visión (sin traducción), cada detector:
PYTHONPATH=engine python tools/bench/corpus_eval.py --source cap01.pdf --lang en --detector default \n    --model text-detector=comictextdetector.onnx --keep-images --out res/vision-default
PYTHONPATH=engine python tools/bench/corpus_eval.py --source cap01.pdf --lang en --detector manga-det \n    --model text-detector-manga=manga_det.onnx --keep-images --out res/vision-manga
# 3. Pipeline completo:
PYTHONPATH=engine python tools/bench/corpus_eval.py --source cap01.pdf --lang en --detector default \n    --model text-detector=comictextdetector.onnx --llm-url http://127.0.0.1:8081/v1 --llm-model qwen3.5-4b --keep-images --out res/e2e
# 4. Comparar, medir A/B, exportar y paridad:
python tools/bench/corpus_compare.py cap01.pdf res/vision-default res/vision-manga cmp.json --names defecto manga
PYTHONPATH=engine python tools/bench/detector_ab.py paginas/ comictextdetector.onnx manga_det.onnx ab.json
(cd apps/mobile && SB_TEST_OUT=dist-test npx vite build -c test/engine/vite.config.ts)
node tools/bench/export_render.mjs apps/mobile/test/engine/dist-test res/e2e/img res/export
node tools/bench/manga_det_parity.mjs apps/mobile/test/engine/dist-test paginas/ manga_det.onnx res/ts
PYTHONPATH=engine python tools/bench/manga_det_compare.py paginas/ res/ts manga_det.onnx paridad.json
```

Fase 3 (comparación de modelos con las mismas regiones; `llama-server` lanzado como la app, `-c 12288 --parallel 1 -ngl 99`):

```bash
PYTHONPATH=engine python tools/bench/translate_models.py --pages res/e2e/img --llm-url http://127.0.0.1:8082/v1     --llm-model qwen3.5-9b --llm-pid <pid de llama-server> --out res/modelos/qwen3.5-9b.json
python tools/bench/translate_compare.py res/modelos/qwen3.5-4b.json res/modelos/qwen3.5-9b.json res/modelos/gemma4-e4b.json
```

`cap01.pdf` = páginas 4–49 del PDF del titular (SHA-256 del original en §1; el de cada página importada, en el manifiesto local).
