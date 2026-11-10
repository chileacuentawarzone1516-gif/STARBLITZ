# Benchmark de traducción (PC, CPU) — 2026-11-08

> **PLaMo retirado del código (2026-11-09, D3 no autorizado).** STARBLITZ ya no reconoce, busca, describe, instala ni usa
> PLaMo 3 Translate (bloqueo en `apps/shared/src/llm/hf.ts` y `engine/starblitz_engine/llm/hf.py`; el procesador rechaza un PLaMo ya
> instalado). Las medidas de PLaMo que aparecen abajo son un **registro histórico** del benchmark del 2026-11-08, no una opción.

**Qué es y qué NO es.** Mediciones **reales y reproducibles** hechas en un PC (Intel i7-13620H, 32 GB, **solo CPU**, 6 hilos, `llama-server`
b12017 = la misma versión que se empaqueta en Android), con el corpus propio de [`tools/bench`](../tools/bench/README.md). **No hay ninguna
medición del Redmi Note 8 Pro ni de ningún teléfono**: los **tiempos y la RAM** de abajo son de este PC; los **recuentos de tokens y de
llamadas** son independientes del dispositivo. Las «comprobaciones automáticas» son heurísticas (ver el README del banco): **no son una nota
de calidad literaria**. Resultados crudos en `tools/bench/results/2026-11-08-pc-i7-13620H-cpu6/` (todas las salidas incluidas, para
revisión humana). Verificación de los modelos: SHA-256 de cada GGUF igual al publicado por su repositorio.

Estados: **CONFIRMADO** (medido y repetible) · **NO VERIFICADO** (sin medir) · **PENDIENTE**.

## 1. Coste por llamada: el formato actual de STARBLITZ frente a pedir solo la traducción

«app» = el prompt y el esquema JSON **reales** de STARBLITZ (sin el contexto de páginas vecinas, que lo encarecería: es un **límite
inferior**). «batch» = una llamada por escena/página con las líneas numeradas. Una llamada ≈ una página de 2–5 globos.

| Configuración | Llamadas | Tokens de entrada / llamada | Tokens de **salida** / llamada | s / llamada (PC) | OK | ja | ko |
|---|---:|---:|---:|---:|---:|---:|---:|
| Qwen3.5-0.8B-Q4_K_M.gguf · app · batch | 19 | 1068 | 1097 | 37.0 | 8/56 | 5/36 | 3/20 |
| Qwen3.5-0.8B-Q4_K_M.gguf · qwen · batch | 19 | 198 | 97 | 3.1 | 11/56 | 6/36 | 5/20 |
| Qwen3.5-0.8B-Q4_K_M.gguf · qwen · per | 56 | 144 | 12 | 0.6 | 18/56 | 12/36 | 6/20 |
| Qwen3.5-2B-Q4_K_M.gguf · app · batch | 19 | 1068 | 386 | 23.6 | 14/56 | 8/36 | 6/20 |
| Qwen3.5-2B-Q4_K_M.gguf · qwen · batch | 19 | 198 | 150 | 9.0 | 30/56 | 19/36 | 11/20 |
| Qwen3.5-2B-Q4_K_M.gguf · qwen · per +glosario | 56 | 149 | 31 | 2.2 | 30/56 | 19/36 | 11/20 |
| Qwen3.5-2B-Q4_K_M.gguf · qwen · per | 56 | 144 | 31 | 2.1 | 26/56 | 15/36 | 11/20 |
| Qwen3.5-4B-Q4_K_M.gguf · app · batch | 19 | 1068 | 353 | 57.8 | 39/56 | 23/36 | 16/20 |
| Qwen3.5-4B-Q4_K_M.gguf · qwen · batch | 19 | 198 | 45 | 9.1 | 37/56 | 24/36 | 13/20 |
| Qwen3.5-4B-Q4_K_M.gguf · qwen · per +glosario | 56 | 149 | 13 | 3.0 | 41/56 | 26/36 | 15/20 |
| Qwen3.5-4B-Q4_K_M.gguf · qwen · per | 56 | 144 | 13 | 3.0 | 36/56 | 21/36 | 15/20 |
| Hy-MT2-1.8B-Q4_K_M.gguf · hymt2 · batch +glosario | 19 | 111 | 52 | 2.9 | 39/56 | 27/36 | 12/20 |
| Hy-MT2-1.8B-Q4_K_M.gguf · hymt2 · batch | 19 | 107 | 52 | 2.9 | 35/56 | 22/36 | 13/20 |
| Hy-MT2-1.8B-Q4_K_M.gguf · hymt2 · per +glosario | 56 | 44 | 15 | 0.9 | 35/56 | 22/36 | 13/20 |
| Hy-MT2-1.8B-Q4_K_M.gguf · hymt2 · per | 56 | 37 | 14 | 0.9 | 30/56 | 17/36 | 13/20 |
| plamo-3-translate-0.8b-Q4_K_M.gguf · plamo · batch | 19 | 55 | 42 | 1.0 | 46/56 | 30/36 | 16/20 |
| plamo-3-translate-0.8b-Q4_K_M.gguf · plamo · per +glosario | 56 | 35 | 14 | 0.5 | 45/56 | 30/36 | 15/20 |
| plamo-3-translate-0.8b-Q4_K_M.gguf · plamo · per | 56 | 30 | 14 | 0.5 | 43/56 | 28/36 | 15/20 |
| plamo-3-translate-2b-Q4_K_M.gguf · plamo · batch | 19 | 55 | 42 | 3.6 | 43/56 | 29/36 | 14/20 |
| plamo-3-translate-2b-Q4_K_M.gguf · plamo · per +glosario | 56 | 35 | 14 | 1.7 | 48/56 | 34/36 | 14/20 |
| plamo-3-translate-2b-Q4_K_M.gguf · plamo · per | 56 | 30 | 14 | 1.7 | 45/56 | 31/36 | 14/20 |

**CONFIRMADO (independiente del dispositivo):** con Qwen3.5-4B (el modelo que la app recomienda a un móvil de 6–8 GB como el Redmi), el formato
actual cuesta **~1 070 tokens de entrada y ~350 de salida por página**; pidiendo solo la traducción baja a **~200 y ~45**; con PLaMo-0.8B, a **~55 y ~42**.
La generación es lo más lento de un teléfono, y la lectura del prompt (*prefill*) también pesa. En este PC eso son **57,8 s → 9,1 s → 1,0 s por página**.
Con modelos pequeños, además, el formato JSON de la app **empeora la calidad** (Qwen-2B: 25 de 56 traducciones vacías; Qwen-0.8B: 21 vacías o sin
traducir) y desperdicia salida (Qwen-0.8B llega a ~1 100 tokens de salida por página).

## 2. Todas las configuraciones

| Configuración | MB | Seg. | Llamadas | Tokens ent./sal. | tok/s gen. | s/seg. | s total | RAM pico MB | OK | Vacías | Rechazos | Sin traducir | Inglés | Omisión? | Adición? | Contenido perdido |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Qwen3.5-0.8B-Q4_K_M.gguf · app · batch | 533 | 56 | 19 | 20291/20845 | 31.3 | 12.545 | 702.51 | 2078 | 8/56 | 6 | 0 | 15 | 0 | 17 | 0 | 48 |
| Qwen3.5-0.8B-Q4_K_M.gguf · qwen · batch | 533 | 56 | 19 | 3754/1835 | 37.7 | 1.043 | 58.4 | 1021 | 11/56 | 1 | 0 | 7 | 0 | 5 | 0 | 44 |
| Qwen3.5-0.8B-Q4_K_M.gguf · qwen · per | 533 | 56 | 56 | 8070/692 | 37.2 | 0.607 | 34.02 | 946 | 18/56 | 0 | 0 | 1 | 0 | 4 | 0 | 38 |
| Qwen3.5-2B-Q4_K_M.gguf · app · batch | 1281 | 56 | 19 | 20291/7331 | 17.2 | 8.008 | 448.44 | 1871 | 14/56 | 25 | 0 | 0 | 0 | 25 | 0 | 42 |
| Qwen3.5-2B-Q4_K_M.gguf · qwen · batch | 1281 | 56 | 19 | 3754/2846 | 18.9 | 3.041 | 170.31 | 1858 | 30/56 | 0 | 0 | 0 | 0 | 1 | 2 | 26 |
| Qwen3.5-2B-Q4_K_M.gguf · qwen · per +glosario | 1281 | 56 | 56 | 8370/1760 | 19.2 | 2.17 | 121.5 | 1786 | 30/56 | 0 | 0 | 0 | 0 | 1 | 1 | 25 |
| Qwen3.5-2B-Q4_K_M.gguf · qwen · per | 1281 | 56 | 56 | 8070/1753 | 19.4 | 2.127 | 119.14 | 1773 | 26/56 | 0 | 0 | 0 | 0 | 1 | 1 | 29 |
| Qwen3.5-4B-Q4_K_M.gguf · app · batch | 2741 | 56 | 19 | 20291/6700 | 6.4 | 19.608 | 1098.06 | 3560 | 39/56 | 0 | 0 | 0 | 0 | 1 | 0 | 16 |
| Qwen3.5-4B-Q4_K_M.gguf · qwen · batch | 2741 | 56 | 19 | 3754/858 | 6.8 | 3.102 | 173.69 | 3462 | 37/56 | 0 | 0 | 0 | 0 | 1 | 0 | 18 |
| Qwen3.5-4B-Q4_K_M.gguf · qwen · per +glosario | 2741 | 56 | 56 | 8370/728 | 6.9 | 2.988 | 167.34 | 3466 | 41/56 | 0 | 0 | 0 | 0 | 1 | 0 | 15 |
| Qwen3.5-4B-Q4_K_M.gguf · qwen · per | 2741 | 56 | 56 | 8070/732 | 6.6 | 3.021 | 169.18 | 3295 | 36/56 | 0 | 0 | 0 | 0 | 1 | 0 | 20 |
| Hy-MT2-1.8B-Q4_K_M.gguf · hymt2 · batch +glosario | 1133 | 56 | 19 | 2103/987 | 23.8 | 0.993 | 55.59 | 1794 | 39/56 | 0 | 0 | 0 | 0 | 1 | 0 | 17 |
| Hy-MT2-1.8B-Q4_K_M.gguf · hymt2 · batch | 1133 | 56 | 19 | 2032/984 | 23.6 | 0.989 | 55.36 | 1789 | 35/56 | 0 | 0 | 0 | 0 | 1 | 0 | 21 |
| Hy-MT2-1.8B-Q4_K_M.gguf · hymt2 · per +glosario | 1133 | 56 | 56 | 2445/814 | 23.8 | 0.926 | 51.86 | 1761 | 35/56 | 0 | 0 | 0 | 0 | 1 | 0 | 21 |
| Hy-MT2-1.8B-Q4_K_M.gguf · hymt2 · per | 1133 | 56 | 56 | 2090/809 | 24.2 | 0.854 | 47.85 | 1706 | 30/56 | 0 | 0 | 0 | 0 | 1 | 0 | 26 |
| plamo-3-translate-0.8b-Q4_K_M.gguf · plamo · batch | 573 | 56 | 19 | 1038/793 | 56.1 | 0.345 | 19.34 | 768 | 46/56 | 0 | 0 | 0 | 0 | 1 | 0 | 10 |
| plamo-3-translate-0.8b-Q4_K_M.gguf · plamo · per +glosario | 573 | 56 | 56 | 1964/802 | 56.3 | 0.506 | 28.34 | 776 | 45/56 | 0 | 0 | 1 | 0 | 1 | 0 | 9 |
| plamo-3-translate-0.8b-Q4_K_M.gguf · plamo · per | 573 | 56 | 56 | 1704/798 | 56.6 | 0.478 | 26.78 | 777 | 43/56 | 0 | 0 | 1 | 0 | 1 | 0 | 11 |
| plamo-3-translate-2b-Q4_K_M.gguf · plamo · batch | 1807 | 56 | 19 | 1038/797 | 18.5 | 1.236 | 69.21 | 2164 | 43/56 | 0 | 0 | 0 | 0 | 1 | 0 | 12 |
| plamo-3-translate-2b-Q4_K_M.gguf · plamo · per +glosario | 1807 | 56 | 56 | 1964/805 | 17.7 | 1.671 | 93.56 | 2205 | 48/56 | 0 | 0 | 0 | 0 | 1 | 0 | 7 |
| plamo-3-translate-2b-Q4_K_M.gguf · plamo · per | 1807 | 56 | 56 | 1704/804 | 16.8 | 1.733 | 97.03 | 2217 | 45/56 | 0 | 0 | 0 | 0 | 1 | 0 | 10 |

**Qwen3.5-0.8B-Q4_K_M.gguf · app · batch** — por categoría (OK/total): normal 0/7, coloquial 0/6, insulto 0/7, doble_sentido 0/5, humor 0/5, incompleta 0/5, onomatopeya 5/5, adulto 1/6, violencia 2/5, terminologia 0/5
**Qwen3.5-0.8B-Q4_K_M.gguf · qwen · batch** — por categoría (OK/total): normal 1/7, coloquial 0/6, insulto 2/7, doble_sentido 1/5, humor 0/5, incompleta 0/5, onomatopeya 4/5, adulto 1/6, violencia 2/5, terminologia 0/5
**Qwen3.5-0.8B-Q4_K_M.gguf · qwen · per** — por categoría (OK/total): normal 3/7, coloquial 1/6, insulto 1/7, doble_sentido 1/5, humor 0/5, incompleta 3/5, onomatopeya 5/5, adulto 3/6, violencia 1/5, terminologia 0/5
**Qwen3.5-2B-Q4_K_M.gguf · app · batch** — por categoría (OK/total): normal 1/7, coloquial 1/6, insulto 1/7, doble_sentido 1/5, humor 0/5, incompleta 1/5, onomatopeya 5/5, adulto 1/6, violencia 3/5, terminologia 0/5
**Qwen3.5-2B-Q4_K_M.gguf · qwen · batch** — por categoría (OK/total): normal 4/7, coloquial 3/6, insulto 0/7, doble_sentido 3/5, humor 1/5, incompleta 3/5, onomatopeya 5/5, adulto 5/6, violencia 5/5, terminologia 1/5
**Qwen3.5-2B-Q4_K_M.gguf · qwen · per +glosario** — por categoría (OK/total): normal 3/7, coloquial 2/6, insulto 0/7, doble_sentido 2/5, humor 1/5, incompleta 5/5, onomatopeya 5/5, adulto 4/6, violencia 4/5, terminologia 4/5
**Qwen3.5-2B-Q4_K_M.gguf · qwen · per** — por categoría (OK/total): normal 3/7, coloquial 2/6, insulto 0/7, doble_sentido 2/5, humor 1/5, incompleta 5/5, onomatopeya 5/5, adulto 4/6, violencia 4/5, terminologia 0/5
**Qwen3.5-4B-Q4_K_M.gguf · app · batch** — por categoría (OK/total): normal 5/7, coloquial 3/6, insulto 3/7, doble_sentido 4/5, humor 3/5, incompleta 5/5, onomatopeya 5/5, adulto 6/6, violencia 4/5, terminologia 1/5
**Qwen3.5-4B-Q4_K_M.gguf · qwen · batch** — por categoría (OK/total): normal 5/7, coloquial 4/6, insulto 4/7, doble_sentido 4/5, humor 2/5, incompleta 5/5, onomatopeya 5/5, adulto 6/6, violencia 2/5, terminologia 0/5
**Qwen3.5-4B-Q4_K_M.gguf · qwen · per +glosario** — por categoría (OK/total): normal 3/7, coloquial 4/6, insulto 4/7, doble_sentido 3/5, humor 3/5, incompleta 5/5, onomatopeya 5/5, adulto 5/6, violencia 4/5, terminologia 5/5
**Qwen3.5-4B-Q4_K_M.gguf · qwen · per** — por categoría (OK/total): normal 3/7, coloquial 4/6, insulto 4/7, doble_sentido 3/5, humor 3/5, incompleta 5/5, onomatopeya 5/5, adulto 5/6, violencia 4/5, terminologia 0/5
**Hy-MT2-1.8B-Q4_K_M.gguf · hymt2 · batch +glosario** — por categoría (OK/total): normal 3/7, coloquial 4/6, insulto 2/7, doble_sentido 4/5, humor 1/5, incompleta 5/5, onomatopeya 5/5, adulto 6/6, violencia 4/5, terminologia 5/5
**Hy-MT2-1.8B-Q4_K_M.gguf · hymt2 · batch** — por categoría (OK/total): normal 3/7, coloquial 4/6, insulto 3/7, doble_sentido 4/5, humor 1/5, incompleta 5/5, onomatopeya 5/5, adulto 6/6, violencia 4/5, terminologia 0/5
**Hy-MT2-1.8B-Q4_K_M.gguf · hymt2 · per +glosario** — por categoría (OK/total): normal 3/7, coloquial 5/6, insulto 0/7, doble_sentido 3/5, humor 1/5, incompleta 5/5, onomatopeya 5/5, adulto 4/6, violencia 4/5, terminologia 5/5
**Hy-MT2-1.8B-Q4_K_M.gguf · hymt2 · per** — por categoría (OK/total): normal 3/7, coloquial 5/6, insulto 0/7, doble_sentido 3/5, humor 1/5, incompleta 5/5, onomatopeya 5/5, adulto 4/6, violencia 4/5, terminologia 0/5
**plamo-3-translate-0.8b-Q4_K_M.gguf · plamo · batch** — por categoría (OK/total): normal 7/7, coloquial 6/6, insulto 5/7, doble_sentido 4/5, humor 0/5, incompleta 5/5, onomatopeya 5/5, adulto 6/6, violencia 5/5, terminologia 3/5
**plamo-3-translate-0.8b-Q4_K_M.gguf · plamo · per +glosario** — por categoría (OK/total): normal 7/7, coloquial 6/6, insulto 5/7, doble_sentido 3/5, humor 0/5, incompleta 4/5, onomatopeya 5/5, adulto 5/6, violencia 5/5, terminologia 5/5
**plamo-3-translate-0.8b-Q4_K_M.gguf · plamo · per** — por categoría (OK/total): normal 7/7, coloquial 6/6, insulto 5/7, doble_sentido 3/5, humor 0/5, incompleta 4/5, onomatopeya 5/5, adulto 5/6, violencia 5/5, terminologia 3/5
**plamo-3-translate-2b-Q4_K_M.gguf · plamo · batch** — por categoría (OK/total): normal 7/7, coloquial 6/6, insulto 4/7, doble_sentido 5/5, humor 1/5, incompleta 5/5, onomatopeya 5/5, adulto 5/6, violencia 4/5, terminologia 1/5
**plamo-3-translate-2b-Q4_K_M.gguf · plamo · per +glosario** — por categoría (OK/total): normal 7/7, coloquial 6/6, insulto 5/7, doble_sentido 5/5, humor 2/5, incompleta 5/5, onomatopeya 5/5, adulto 4/6, violencia 4/5, terminologia 5/5
**plamo-3-translate-2b-Q4_K_M.gguf · plamo · per** — por categoría (OK/total): normal 7/7, coloquial 6/6, insulto 5/7, doble_sentido 5/5, humor 2/5, incompleta 5/5, onomatopeya 5/5, adulto 4/6, violencia 4/5, terminologia 2/5

Columnas: Tokens ent./sal. = totales del corpus; tok/s gen. = velocidad de generación que informa `llama-server`; OK = pasa todas las
comprobaciones; «Contenido perdido» = segmentos cuyo insulto/término adulto/violento/nombre/glosario esperado **no** aparece en la salida.

## 3. Lectura (preliminar)

- **Mejor relación fidelidad / velocidad / memoria (PC), solo como referencia (PLaMo NO está autorizado, D3):** PLaMo-3-Translate-0.8B (573 MB, 0,5 s/segmento, 0,8 GB de RAM, 45–46 de 56). PLaMo-2B es el más
  fiel en japonés (34/36) pero ~3× más lento. Hy-MT2-1.8B (Apache-2.0) queda en medio (35–39 de 56). Qwen3.5-4B en texto plano (36–41) iguala a
  Hy-MT2 pero es ~3× más lento y ocupa 3,3 GB.
- **Glosario:** todos los modelos mejoran con glosario; PLaMo y Hy-MT2 lo respetan en 5/5 de la categoría de terminología (Qwen-2B, 4/5 con glosario en el prompt).
- **Contenido sin suavizar:** ninguna configuración dio una sola negativa (0 rechazos). Lo que sí aparece son **errores de traducción** (palabras inventadas, «arma de fuego» por
  «cuchillo») sobre todo en coreano y en los modelos más pequeños de propósito general.
- **Coreano:** el punto débil de todos (12–16 de 20). Ningún candidato lo resuelve; PLaMo-2B es el más legible. **Sin resolver**: evaluar OPUS-MT ko→es (necesita otro runtime) y modelos mayores.
- **No concluyente:** humor y juegos de palabras (0–3 de 5 en todos), y el corpus es pequeño (56 segmentos). **Hace falta evaluación humana** de las salidas.

## 4. Limitaciones

1. PC con CPU potente: **no** representa la velocidad ni el calor ni la memoria de un Helio G90T. Cualquier cifra de tiempo del teléfono sería una invención.
2. Corpus pequeño, inventado y con una sola referencia por segmento; las listas «keep» son mías y pueden penalizar traducciones válidas con otras palabras.
3. Evaluación preliminar hecha por una IA, no por una persona nativa de japonés o coreano.
4. No medidos: OPUS-MT (ja/ko→es), SMaLL-100, Seed-X, TranslateGemma, MADLAD (ver [MODELOS-INVESTIGACION](MODELOS-INVESTIGACION.md) por qué).
5. No medidos la batería ni la temperatura (solo posible en el teléfono; el informe exportable de la app los registra).
