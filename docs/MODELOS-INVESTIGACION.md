# Investigación de modelos de OCR y traducción

> **Actualización 2026-11-12:** investigación de candidatos nuevos (PC y Android), licencias verificadas, benchmark común y diseño de los
> dos apartados en [MODELOS-TRADUCCION-PC-ANDROID](MODELOS-TRADUCCION-PC-ANDROID.md). Lo de abajo queda como registro de las fases anteriores.

> **PLaMo retirado del código (2026-11-09, D3 no autorizado).** STARBLITZ ya no reconoce, busca, describe, instala ni usa
> PLaMo 3 Translate (bloqueo en `apps/shared/src/llm/hf.ts` y `engine/starblitz_engine/llm/hf.py`; el procesador rechaza un PLaMo ya
> instalado). Las medidas de PLaMo que aparecen abajo son un **registro histórico** del benchmark del 2026-11-08, no una opción.

Metadatos (tamaños, licencias declaradas, idiomas) consultados en la API pública de Hugging Face el **2026-11-08**. La parte de **OCR** sigue **sin medir**. La de **traducción** tiene medidas en un PC (no en el teléfono): ver más abajo y
[BENCHMARK-TRADUCCION](BENCHMARK-TRADUCCION.md). **Aún no se declara ningún ganador definitivo**: falta la medición en el Redmi. Las licencias son las
**declaradas por quien publica el repositorio**; no son asesoramiento legal.

Leyenda: ✅ comprobado en el repositorio del modelo · 📖 documentado por el autor (no verificado por nosotros) ·
❓ no verificado · — no aplica.

## OCR

| Modelo | Descarga | Licencia (código / pesos) | Idiomas | Calidad documentada (📖 por el autor) |
|---|---|---|---|---|
| **PP-OCRv6 Manga v0.3** · `Kellenok/PP-OCRv6_manga` · detector + reconocedor **FP16** | ✅ 0,92 MB + 10,71 MB ≈ **11,6 MB** (FP32: 1,73 + 21,33 MB; opcional LM 3,4 MB «experimental, no recomendado para producción») | ✅ Apache-2.0 declarada para el repositorio (ajuste fino de PP-OCRv6 *tiny det* y *small rec*, de PaddlePaddle). ❓ Se entrenó con **Manga109-s**: hay que revisar si sus condiciones afectan a la redistribución de los pesos | ✅ ja, zh | 📖 CER de la tubería completa (v0.3): manga 5,98 %, webtoons 2,74 %, ilustraciones 14,92 %, total 7,57 %; FP16 vs FP32: 0,02 pp |
| **PP-OCRv6 small rec manga** · `fumetodev/PP-OCRv6_small_rec_manga_ONNX` (solo reconocedor) | ✅ 20 MB | ✅ Apache-2.0 (ajuste de `PaddlePaddle/PP-OCRv6_small_rec`) | ✅ solo ja | 📖 422 globos propios retenidos: CER 4,02 % frente a 6,15 % del modelo base; 75,1 % de globos exactos. Sustituto directo del reconocedor; el autor avisa de que no elimina furigana |
| **PP-OCRv6 small** (original) · `PaddlePaddle/PP-OCRv6_small_{det,rec}_onnx` | ✅ 9 MB + 20 MB | ✅ Apache-2.0 | ✅ en, zh | 📖 modelo de uso general; el que ya se incluye como «PP-OCR» |
| **PaddleOCR coreano** · `PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx` | ❓ tamaño no consultado | ✅ (mismo ecosistema PaddleOCR) ❓ licencia exacta por confirmar | ko | ❓ |
| **manga-ocr** (kha-white) | ✅ 424 MB (PyTorch); ONNX (`onnx-community`): codificador 327 MB (FP16 164, int8 83) + decodificador 112 MB (FP16 56) ≈ **439 MB** en FP32 | ✅ Apache-2.0 | ✅ solo ja | 📖 referencia para manga (texto vertical y furigana); autorregresivo, más lento por bloque. Es el que se usa hoy |
| manga-ocr 2025 ONNX (`l0wgear/…`) | ✅ 134 MB (codificador 21 + decodificador 113) | ❌ **sin licencia declarada** → no utilizable hasta aclararlo | ja | ❓ |

Observación de licencias: hoy el detector `comic-text-detector` tiene pesos **GPL-3.0** (ver
[LICENCIAS-TERCEROS](LICENCIAS-TERCEROS.md)). El detector de línea de PP-OCRv6 Manga (`manga_det`, Apache-2.0 declarada)
sería una alternativa permisiva para la *detección de texto*, pero **no genera la máscara de texto ni agrupa globos** como
el detector actual, que alimentan el borrado: sustituirlo exige ingeniería y comparación de calidad. Es una oportunidad,
no una conclusión.

## Traducción

Revisado el **2026-11-08** en la API pública y las fichas oficiales de Hugging Face (tamaños de archivo y hash SHA-256 de los
GGUF descargados verificados contra el publicado por cada repositorio). Las licencias son las **declaradas por quien publica**; no son
asesoramiento legal. «Medido» = ejecutado en un PC (i7-13620H, CPU, 6 hilos) con
[`tools/bench`](../tools/bench/README.md); **ninguna medida es del Redmi Note 8 Pro**.

| Modelo | Descarga (Q4_K_M) | Licencia (declarada) | ¿Cabe en el reparto de STARBLITZ? | ja / ko → es | Estado |
|---|---|---|---|---|---|
| **PLaMo 3 Translate 0.8B** · `pfnet/plamo-3-translate-0.8b-GGUF` | ✅ **573 MB** (Q4_0 548, Q3_K_M 486, Q2_K 410) | ⚠️ **PLaMo Community License**: uso personal y no comercial gratis sin registro; uso comercial con condiciones (ingresos ≤ 1 000 M¥: gratis con registro previo; más: acuerdo aparte) — 📖 según la ficha, leer el texto completo | ❌ **No autorizado por el titular (D3, 2026-11-08)**: ni en el catálogo ni como descarga opcional | ja ✅ (53 idiomas en la ficha; coreano **sin** énfasis declarado) | 🧪 **medido en PC** (ver abajo) y **implementado** (formato nativo PFML3 vía plantilla) |
| **PLaMo 3 Translate 2B** | ✅ **1 807 MB** | ⚠️ igual | ⚠️ igual | ja ✅ | 🧪 medido en PC |
| **Hy-MT2-1.8B** (Tencent, 2026-05) · `tencent/Hy-MT2-1.8B-GGUF` | ✅ **1 133 MB** (Q6_K 1 475, Q8_0 1 909); variantes AngelSlim 2-bit 601 MB y 1,25-bit 462 MB | ✅ **Apache-2.0** declarada en el repositorio | ✅ **Sí** (permisiva) | 33 idiomas, incluye ja, ko, es (ficha) | 🧪 **medido en PC** e **implementado** (instrucción nativa + terminología) |
| Hy-MT2-7B / 30B-A3B | 4 625 MB / 18 237 MB | ✅ Apache-2.0 | ✅ pero **no caben** en un teléfono de 6–8 GB (7B) ni en uno cualquiera (30B) | ✅ | ⛔ descartados para móvil; el 7B queda como opción de PC (sin medir) |
| 2-bit / 1,25-bit de Hy-MT2 | 601 / 462 MB | ✅ Apache-2.0 | ❓ **requieren un núcleo «STQ» del PR nº 19357 de llama.cpp** (según su ficha): **no está en la versión b12017 que empaquetamos** | ✅ | ⛔ no utilizables hoy |
| **HY-MT1.5-1.8B** (Tencent, 2025-12) | ✅ 1 133 MB | ❌ **Tencent HY Community License: «no se aplica en la Unión Europea, el Reino Unido ni Corea del Sur»** (texto del archivo `License.txt`) | ❌ **Descartado**: excluiría a España (UE) y a hispanohablantes en el Reino Unido, y a coreano-hablantes en Corea del Sur | ✅ | ⛔ **no usar** (lo sustituye Hy-MT2, Apache-2.0) |
| **OPUS-MT ja→es** · `Helsinki-NLP/opus-mt-ja-es` | ≈ 306 MB (PyTorch/TF, sin ONNX ni CT2 oficial) | ✅ Apache-2.0 | ✅ | ja→es; Tatoeba BLEU 34,6 (📖, frases cortas) | ❓ **sin medir**: necesita otro runtime (Marian/CTranslate2/ONNX) que no está en la app; **sin glosario ni contexto** |
| **OPUS-MT ko→es** · `Helsinki-NLP/opus-mt-ko-es` | ≈ 298 MB; conversiones comunitarias: CT2 80 MB (`manancode/…-android`, Apache-2.0), ONNX int8 ≈ 236 MB (licencia no declarada) | ✅ Apache-2.0 (original) | ✅ | ko→es; Tatoeba BLEU 31,3 (📖) | ❓ **sin medir** (igual que el anterior) |
| OPUS-MT zh→es | ❌ no existe | — | — | — | pivotar por inglés (calidad menor) |
| **SMaLL-100** · `alirezamsh/small100` | ONNX 1 860 MB / PyTorch 1 331 MB (FP32; **no es ligero**) | ✅ MIT | ✅ | 100 idiomas, calidad inferior a NLLB (📖) | ❓ sin medir; la versión INT8 no está publicada por el autor |
| **Seed-X-PPO-7B** (ByteDance) | 15 029 MB (safetensors) | ⚠️ «OpenMDW» (otra licencia) | ❓ | 28 idiomas | ⛔ 7B: no cabe en móvil; sin medir |
| **TranslateGemma 4B** (Google) | ≈ 8 600 MB (safetensors; GGUF comunitarios) | ⚠️ **Gemma** (acceso restringido a aceptar en el repositorio) | ⚠️ con condiciones | multilingüe | ❓ sin medir; modelos con alineamiento de seguridad |
| **MADLAD-400-3B-MT** (Google) | GGUF Q4_K 1 578 MB | ✅ Apache-2.0 | ✅ | 400+ idiomas | ❓ T5 codificador-decodificador: **no verificado** que nuestro `llama-server` lo sirva por la API de chat |
| NLLB-200 | 2 346 MB (600M, FP32) | ❌ **CC-BY-NC-4.0** (no comercial) | ❌ descartado por licencia | 200 | ⛔ |
| **Qwen 3.5** 0.8B / 2B / 4B (la base actual) | 508 / 1 281 / 2 741 MB | ✅ Apache-2.0 | ✅ | generalista | 🧪 **medido en PC** (línea base) |
| Sugoi 14B/32B | GGUF grandes | ❓ | ❓ | **solo ja→en** | ⛔ no aplica (no es → español) |

### Resultados medidos (PC, sin dispositivo) — ver [BENCHMARK-TRADUCCION](BENCHMARK-TRADUCCION.md)

56 segmentos inventados (36 ja, 20 ko) en 10 categorías (normal, coloquial, insultos, doble sentido, humor, frases incompletas,
onomatopeyas, adulto, violencia, terminología). «OK» = pasa **todas** las comprobaciones automáticas (sin vacío, sin negativa, sin
inglés ni texto sin traducir, sin omisión/adición por longitud y **conserva el contenido** esperado: insultos, términos adultos,
violencia y nombres/glosario).

| Configuración (CPU, 6 hilos) | MB | OK /56 | ja | ko | s/segmento | RAM pico |
|---|---:|---:|---:|---:|---:|---:|
| Qwen3.5-0.8B · texto plano | 533 | 18 | — | — | 0,61 | 946 MB |
| Qwen3.5-2B · texto plano + glosario | 1 281 | 30 | 19/36 | 11/20 | 2,17 | 1 786 MB |
| **Hy-MT2-1.8B · lote + glosario** | 1 133 | **39** | 27/36 | 12/20 | 0,99 | 1 794 MB |
| **PLaMo-3-Translate-0.8B · segmento + glosario** | **573** | **45** | 30/36 | 15/20 | **0,51** | **776 MB** |
| **PLaMo-3-Translate-2B · segmento + glosario** | 1 807 | **48** | **34/36** | 14/20 | 1,67 | 2 205 MB |

**Lectura (preliminar, hecha por mí, no por una persona nativa):** en japonés, PLaMo traduce con fidelidad notable y **no suaviza**
insultos, escenas adultas ni violencia (todos los textos del corpus se conservaron); Hy-MT2 también conserva el contenido pero comete más
errores léxicos; Qwen 2B inventa palabras («Trome», «¡MADURO!») aunque no censura. **El coreano es el punto débil de todos** (errores de
sentido en sufijos de insulto, «arma de fuego» por «cuchillo», «Lo mataré de cuello»…); PLaMo-2B es el más legible. **Nada de esto
sustituye una evaluación humana ni la medición en el teléfono**; y las comprobaciones automáticas son heurísticas (palabras esperadas),
no una nota de calidad literaria.

### Insultos, contenido adulto y expresiones explícitas

- **Medido** (corpus propio, PC): ninguno de los cuatro modelos medidos **se negó** a traducir (0 rechazos en 56 × 14 configuraciones) y
  ninguno omitió líneas adultas o violentas. Hy-MT2 mostró un **suavizado leve** en un insulto (クソ野郎 → «idiota»); Qwen-0.8B tradujo
  mal más que censuró. Es una muestra pequeña: **no demuestra** ausencia de censura en general.
- Los modelos **instruidos** de uso general (Qwen, Gemma) pueden negarse o suavizar según el texto; STARBLITZ detecta las negativas
  (`isRefusal`) y **conserva el original** en lugar de borrarlo.
- «Sin filtros conversacionales» ≠ «fidelidad probada»: lo segundo solo se afirma donde hay medida (tabla anterior).

### RAM estimada y medida

Medida en PC (RSS del proceso `llama-server`, pico): 0,8B ≈ 0,8–1,0 GB; 1,8–2B ≈ 1,8–2,2 GB; 4B ≈ 3,3 GB. En el Redmi (6–8 GB, ~3,5–5 GB
útiles para la app tras el sistema) caben PLaMo-0.8B y Hy-MT2-1.8B con holgura; el 4B queda justo. **Sin medir en el teléfono.**

## Modelos mayores que Qwen3.5-4B en el PC (RTX 4060 Laptop, 8 GB) — 2026-11-10

**Mismo corpus y mismas condiciones para todos:** las 427 regiones ya analizadas del capítulo real (*Ultimate Spider-Man* n.º 1,
46 páginas, inglés → es-419; ver [EVALUACION-CORPUS-USM](EVALUACION-CORPUS-USM.md)), el **traductor real del motor**
(`ContextualTranslator`, con contexto entre páginas, reparación, recuperación ante JSON inválido y reformulación breve), sin imagen,
`llama-server` b12017 Vulkan lanzado **como lo lanza la app** (`-c 12288 --parallel 1 -ngl 99 --jinja --reasoning-budget 0`).
Herramientas: `tools/bench/translate_models.py` y `tools/bench/translate_compare.py`. Archivos GGUF de los repositorios del catálogo,
SHA-256 comprobado contra Hugging Face; **licencia declarada Apache-2.0 en los cuatro** (ficha del repositorio, comprobada el 2026-11-10).

| Métrica (427 textos) | Qwen3.5-4B Q4_K_M (actual) | Qwen3.5-9B Q4_K_M | **Gemma 4 E4B QAT Q4_0** | Gemma 4 12B QAT Q4_0 |
|---|---|---|---|---|
| Páginas con error | 0 | 0 | 0 | 0 |
| Sin traducir / en revisión | 1 / 44 | 0 / 39 | **0 / 22** | 0 / 24 |
| JSON inválido (cortes por tope) → rescatados / recuperados / perdidos | 3 → 11 / 30 / 0 | 1 → 0 / 16 / 0 | **0** | 0 |
| Tiempo del capítulo (solo traducción) | 21,4 min | 33,2 min | **19,4 min** | 90,9 min (con desalojo de VRAM, ver nota) |
| Mediana por página | 23,1 s | 45,0 s | 25,4 s | 78,3 s |
| Generación | 48,7 tok/s | 33,4 tok/s | 45,9 tok/s | 19–27 tok/s con el modelo entero en la GPU; ≈ 4 tras el desalojo (media 8,4) |
| VRAM pico (toda la GPU) | 3,4 GB | 5,7 GB | **3,3 GB** | 7,9 GB (de 8,0) |
| RSS pico de `llama-server`* | 11,4 GB | 13,7 GB | 7,9 GB | 17,4 GB |
| Muestra aleatoria de 30 textos: traducciones con error de sentido o forma (revisión de Claude) | ≈ 13 | ≈ 9–10 | **≈ 3–4** | ≈ 2–4 |
| Regionalismos de España no pedidos (revisión manual) | «JODER» por *whoa* | «TÍOS» ×3, «¿QUÉ COÑO…?» (inventado) | «TÍO» por *yo, man* | ninguno visto |

\* RSS que informa Windows: incluye memoria mapeada del archivo y compartida con la GPU; no es RAM exclusiva.

**Frases con errores ya documentados** (revisión de Claude, **no humana ni nativa**):

| Original | Qwen3.5-4B | Qwen3.5-9B | Gemma 4 E4B |
|---|---|---|---|
| ARE YOU SWEET ON HIM, HARRY? (Harry es varón) | ¿ESTÁS ENAMORADA DE ÉL? ❌ | ¿TE GUSTAS DE ÉL? ❌ | ¿TE GUSTA ÉL, HARRY? ✅ |
| NO, I'M SWEET ON YOU. (habla un chico) | ESTOY ENAMORADA DE TI ❌ | ME GUSTAS A TI ✅ | ME SIENTO ATRAÍDO POR TI ✅ |
| I'M HUGE IN THE DOGHOUSE AT HOME | SOY GRANDE EN EL JARDÍN ❌ | ESTOY EN LA PEOR SITUACIÓN EN CASA ≈ | ESTOY MUY MAL EN CASA ≈ |
| DON'T YOU LOOK LIKE A MILLION DOLLARS | literal ❌ | literal ❌ | literal ❌ |
| WILL YOU LEAVE THE KID ALONE? | ¿QUIERES QUE DEJES A ESE CHICO SOLO? ❌ | ¿VAS A DEJAR AL NIÑO EN PAZ? ✅ | ¿VAS A DEJAR AL NIÑO EN PAZ? ✅ |
| P.S. 163 QUEENS DISTRICT | DISTRICT DE QUES ❌ | DISTRITO DE QUEENS ✅ | DISTRITO DE QUEENS ✅ |
| WHY ISN'T MARY JANE SITTING OVER HERE? | ✅ | NO ESTÁ SIENDO AQUÍ ❌ | ✅ |
| OH FORGET ABOUT THEM, ROLL IT OFF | ¡OLVÍDELOS! ¡DALE! ≈ | OLVIDA CON ELLOS ❌ | OLVÍDATE DE ELLOS, DÉJALO PASAR ✅ |
| JERKHOLE TEAM MATES (insulto) | JODIDOS COMPAÑEROS ✅ | TÍOS DE TU EQUIO ❌ | IDIOTAS DE TU EQUIPO ≈ (suavizado leve) |
| YOU COULDA FOOLED ME | literal ❌ | ME HABRÍAS MENTIDO ❌ | literal ❌ |
| POWERLESS (título) | POWERLESS ≈ | ¡IMPOTENTE! ❌ | SIN PODER ✅ |

**Gemma 4 12B en las mismas frases:** acierta *doghouse* («ESTOY EN GRAVES PROBLEMAS EN CASA»), *million dollars* («¿NO TE VES DE MARAVILLA?», con el sentido), *coulda fooled me* («CASI ME ENGAÑAS»), *wigged out* («ME DIO UN ATAQUE DE PÁNICO… ¡ERA ENORME!») y *Powerless* («SIN PODER»); erratas sueltas («OLVÍDATES»). Es el que mejor entiende los modismos de este corpus, pero ver el coste abajo.

**Conclusiones (PC, este corpus, revisión no humana):**
- **Gemma 4 E4B** es la mejor relación calidad/coste medida: menos errores de comprensión, género y gramática que los dos Qwen,
  la más rápida del grupo y la que menos memoria usa; 0 respuestas JSON inválidas. Sigue fallando modismos idiomáticos
  (*million dollars*, *coulda fooled me*) y algún regionalismo.
- **Qwen3.5-9B** mejora algunos sentidos frente al 4B, pero introduce errores nuevos (gramática, erratas, españolismos y hasta un
  taco inventado) y es 1,55× más lento con 2,3 GB más de VRAM: **no compensa**.
- **Gemma 4 12B** es el que mejor resuelve los modismos y su calidad general es parecida a la de Gemma E4B, pero ocupa la GPU
  entera (7,9 GB de 8,0): durante la ejecución completa Windows desalojó parte del modelo a memoria compartida y la generación cayó de
  19–27 a ≈ 4 tok/s (capítulo en 91 min frente a 19 min de E4B). Aun a plena velocidad es ~2× más lento que E4B. En esta GPU
  **no es utilizable de forma fiable**; tendría sentido con ≥ 10–12 GB de VRAM.
- **Decisión (no tomada aquí):** el titular pidió no cambiar el modelo predeterminado ni retirar Qwen/Gemma. La recomendación con datos
  es **proponer Gemma 4 E4B como modelo recomendado para PC con GPU** tras una evaluación humana nativa sobre más corpus (manga y
  manhwa reales, otros géneros). Qwen3.5-4B sigue siendo el predeterminado (y el del móvil, donde Gemma E4B pesa 5,2 GB en disco
  y no se ha medido).

## Protocolo de comparación

Reproducible y **sin páginas con derechos de autor en el repositorio**:

1. **Páginas:** generadas por `engine/tests` (sintéticas, con texto conocido) y un conjunto **local y privado** de páginas del
   titular (manga, manhwa, manhua y cómic) que no se sube a Git. Cada página con transcripción de referencia hecha por una persona.
2. **OCR:** CER por globo (estricta y tolerante), % de globos exactos, **textos omitidos** (regiones sin leer), tiempo por
   bloque, RAM máxima y tamaño del modelo.
3. **Traducción:** evaluación humana (adecuación y fluidez, 1–5) por una persona que lea el idioma, % de líneas marcadas para
   revisión, **negativas y suavizados** (frases con insultos y contenido adulto), tokens/s, tiempo por página y por lote.
4. **Sistema:** tiempo total de un capítulo de 27 páginas, RAM máxima, temperatura y batería, almacenamiento, continuidad en segundo plano.
5. **Dispositivo:** Redmi Note 8 Pro (Helio G90T) del titular, cuando esté disponible. **Sin simulaciones de hardware.**
6. **Decisión:** solo con estas tablas rellenas. Hoy: **sin ganador**.

## Siguientes candidatos a probar primero (por riesgo/beneficio, no por resultado)

- **OCR:** PP-OCRv6 Manga v0.3 FP16 (11,6 MB frente a ~439 MB de Manga OCR) y el reconocedor ajustado de `fumetodev`: si la
  precisión se confirma, reducirían mucho tamaño y tiempo. Falta comprobar el FP16 en el runtime web (ONNX Runtime WASM) y
  las condiciones de Manga109-s.
- **Traducción:** Qwen3.5-2B/4B Q4 frente a 0,8B (mismo runtime); MADLAD-400-3B solo si se demuestra que `llama-server` lo sirve.
- **Descartados por licencia:** NLLB-200 (no comercial) y `l0wgear/manga-ocr-2025-onnx` (sin licencia).
