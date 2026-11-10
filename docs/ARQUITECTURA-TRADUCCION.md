# Arquitectura de traducción: por qué era lenta y qué cambia

> **PLaMo retirado del código (2026-11-09, D3 no autorizado).** STARBLITZ ya no reconoce, busca, describe, instala ni usa
> PLaMo 3 Translate (bloqueo en `apps/shared/src/llm/hf.ts` y `engine/starblitz_engine/llm/hf.py`; el procesador rechaza un PLaMo ya
> instalado). Las medidas de PLaMo que aparecen abajo son un **registro histórico** del benchmark del 2026-11-08, no una opción.

Resume la causa de la lentitud, las opciones de arquitectura evaluadas y lo que está implementado. Datos y método:
[BENCHMARK-TRADUCCION](BENCHMARK-TRADUCCION.md) (PC, CPU; **ninguna medida del teléfono**). Estados: **CONFIRMADO** (medido o comprobado en el código) ·
**IMPLEMENTADO** (código + pruebas con modelo simulado) · **NO VERIFICADO** (sin medir en el Redmi) · **DISEÑO** (no implementado).

## 1. Causas de la lentitud

### Confirmadas

1. **El formato de la petición/respuesta, no solo el modelo.** CONFIRMADO (recuento de tokens, independiente del dispositivo).
   El traductor contextual envía ~1 070 tokens de prompt por página y exige una **respuesta JSON** con, por cada texto, hablante, emoción, confianza, banderas,
   nota, incidencia y corrección de OCR, más un resumen de página, términos nuevos y personajes. Medido con la misma entrada:

   | Modelo | Formato actual (tokens ent./sal. por página) | Solo traducción en lote | Solo traducción con PLaMo-0.8B |
   |---|---|---|---|
   | Qwen3.5-4B | 1 068 / **353** → 57,8 s (PC) | 198 / 45 → 9,1 s | 55 / 42 → 1,0 s |

   Esto es un **límite inferior**: el prompt real añade sinopsis, personajes, glosario, resumen y la página anterior. Como la generación y el *prefill* son lo más
   lento en un teléfono, el formato multiplica el trabajo por ~6 con el mismo modelo y por ~50 frente a un modelo dedicado. **La estimación en horas por capítulo del
   Redmi no se ha medido y no se publica.**
2. **El modelo recomendado al Redmi es el más pesado que cabe.** CONFIRMADO en el catálogo: un móvil con 6–8 GB es «gama media» y recibe Qwen3.5-4B (2,7 GB);
   RAM medida en PC ≈ 3,3 GB y 6,6 tokens/s en CPU de sobremesa. En ese perfil la calidad es «balanced» (sin segunda pasada) y sin imagen al modelo: **la segunda pasada
   de corrección y la visión NO son causa en el Redmi** (sí lo serían en gama alta).
3. **Con modelos pequeños, el formato JSON además daña la calidad.** CONFIRMADO: con Qwen-2B, 25 de 56 traducciones vacías y 14/56 aceptables en el formato actual, frente a
   30/56 en texto plano; Qwen-0.8B, 8/56 frente a 11–18/56.

### Hipótesis NO verificadas (siguen pendientes de medir en el teléfono)

- Hilos de `llama` (la fórmula da 5 en un Helio G90T, que mezcla núcleos rápidos y lentos).
- Hilos de WebAssembly (OCR/detección) si el `WebView` no está aislado (`crossOriginIsolated`).
- Coste de Manga OCR por bloque en WASM y competencia entre OCR y modelo (mitigada por el gobernador de la Fase 4, sin medir).
- Térmica y reducción de frecuencia en procesamientos largos.

## 2. Opciones de arquitectura evaluadas

| Opción | Evaluación | Estado |
|---|---|---|
| **Una llamada por página, no por globo** | Sin pérdida de fidelidad si el modelo conserva el orden: con líneas numeradas (Hy-MT2) o una por línea (PLaMo) el reparto fue correcto en el corpus; si el recuento no cuadra se **reintenta solo lo que falta**, nunca se adivina | **IMPLEMENTADO** (`translate/plain.ts` y `.py`) |
| **Por globo, uno a uno** | Máxima precisión de asignación, más llamadas; en el corpus PLaMo por segmento y por lote dieron resultados equivalentes (45 vs 46/56) | usado como **reintento** |
| **Contexto compartido entre diálogos** | PLaMo admite historial (pares fuente→traducción previos) y contexto; se envían los últimos 4 diálogos ya traducidos de la página anterior. Hy-MT2/genérico: glosario y numeración en la propia página | **IMPLEMENTADO** (PLaMo: historial; el efecto sobre la calidad **no está medido**) |
| **Glosarios por obra** | El glosario del proyecto y el diccionario personal se pasan al modelo en su formato nativo (solo los términos que aparecen en la página/anterior). Medido: sube los aciertos de terminología de 0–2/5 a 5/5 en PLaMo y Hy-MT2 | **IMPLEMENTADO** y medido (PC) |
| **Caché** | Misma clave que ya usa el traductor contextual (mensajes completos + modelo + parámetros); solo se guarda lo completo y sano | **IMPLEMENTADO** |
| **Traducción incremental** | Ya existía por páginas con progreso guardado y cola persistente (Fase 4); el modo texto plano la respeta | existente |
| **Modelos especializados por idioma** | Medidos: ja → PLaMo es lo mejor (34/36 con 2B); ko → ningún candidato es bueno (12–16/20), PLaMo-2B el más legible. Enrutar por idioma de la obra es posible (`project.lang`) | **DISEÑO** (no implementado; falta un modelo mejor para coreano) |
| **Eliminar segundas pasadas redundantes** | La pasada de corrección solo se activa en «calidad máxima» (gama alta). El modo texto plano **no tiene segunda pasada** (los modelos dedicados no están hechos para revisar). Sin pérdida de contexto | **IMPLEMENTADO** (por construcción) |
| **Aprender personajes/términos automáticamente** | El formato JSON lo hacía; los modelos dedicados **no** producen esos campos. Se pierde ese aprendizaje automático (el glosario manual sí se respeta) | **Compromiso declarado**, no oculto |

## 3. Qué está implementado

- `PlainTranslator` (TypeScript y Python): una llamada por página con el formato nativo de la familia del modelo (
  **Hy-MT2/HY-MT** por instrucción + terminología; **genérico** por instrucción de fidelidad total), reintento individual de lo que falte o sea una negativa, marcado
  para revisión (nunca vacío ni aceptado) si sigue sin haber traducción, y aviso si la salida conserva caracteres del idioma original.
- **Selección automática por familia de modelo**: los modelos dedicados usan texto plano; **Qwen/Gemma y el resto siguen con el traductor contextual** (comportamiento por defecto
  **sin cambios**). El soporte de PLaMo (plantilla propia, mensaje `[plamo-translate]`, historial) se **retiró del código el 2026-11-09** (D3).
- Catálogo curado: **Hy-MT2-1.8B** (Apache-2.0), seleccionable, **no recomendado por defecto**. PLaMo **no** se ofrece (decisión D3, §4).
- Pruebas: 22 nuevas en móvil (TS; suite móvil 226/226) y 13 en el motor Python, con modelo simulado: verifican el protocolo (qué se pide, qué se reintenta, qué se conserva, qué se cachea), **no la
  calidad real**.

## 4. Decisiones del titular

- **D3 — RESUELTA (2026-11-08): PLaMo 3 Translate NO se incorpora al catálogo, ni siquiera como descarga opcional.** Se conservan solo las
  medidas de investigación (BENCHMARK-TRADUCCION) como referencia; **no se recomienda, no se ofrece y no se usa**. El código reconoce su formato
  por nombre (inofensivo), pero la app no lo propone en ningún sitio.
- **Hy-MT2-1.8B (Apache-2.0)** se mantiene como **candidato alternativo**: seleccionable, **no predeterminado**. **Qwen sigue siendo el modelo por defecto.**
- **HY-MT1.5** queda **descartado**: su licencia excluye la UE, el Reino Unido y Corea del Sur (texto de `License.txt`).
- Criterio vigente para nuevos candidatos: licencia **permisiva compatible con distribución y uso comercial**.

## 5. Qué NO se ha hecho (y por qué no se afirma)

- **No se sustituye Qwen**: sigue siendo el modelo recomendado por defecto. Hasta medir en el Redmi (tiempo por página, RAM, batería, temperatura) y revisar a mano las salidas, no hay
  base para cambiar el valor por defecto. Con los datos de PC, el candidato alternativo a probar en el teléfono es **Hy-MT2-1.8B** (Apache-2.0) frente a Qwen-4B.
- **No hay selector en la interfaz** del modo de traducción: se elige por el modelo. `PlainTranslator` ya sabe tratar modelos genéricos (Qwen, Gemma), pero hoy **no hay ninguna ruta que lo active**
  para ellos: un interruptor «modo rápido» para Qwen queda por decidir (con Qwen-4B el texto plano da 6× menos tokens y calidad automática equivalente, 37–41 frente a 39/56).
- **No está medido**: tiempo por capítulo en el Redmi, calidad con personas nativas, coreano mejorado, OPUS-MT ko/ja→es, comportamiento con páginas largas (más de ~10 globos).

## 6. Procedimiento para decidir con datos reales (lo ejecuta el titular)

1. Instalar el APK de pruebas y, en *Modelos*, instalar Hy-MT2-1.8B (PLaMo no: D3, bloqueado en la app); usar **Comparar modelos** (existente) con Qwen-4B.
2. Procesar un capítulo de 27 páginas con cada uno y **exportar el informe de rendimiento** (menú del proyecto): tiempo por etapa y página, tokens/s, RAM libre, batería y temperatura
   ([VALIDACION-FASE4-ANDROID](VALIDACION-FASE4-ANDROID.md)).
3. Revisar a mano globos y diálogos (¿suavizado?, ¿omisiones?, ¿coherencia entre globos?).
4. Solo entonces fijar el modelo por defecto del perfil «gama media».
