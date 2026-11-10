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

`cap01.pdf` = páginas 4–49 del PDF del titular (SHA-256 del original en §1; el de cada página importada, en el manifiesto local).
