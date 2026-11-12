# Modelos de traducción para STARBLITZ PC y STARBLITZ Android — investigación y diseño (2026-11-12)

> **Fase de investigación: no se ha cambiado código, catálogo, modelo predeterminado ni se ha descargado ningún peso.**
> Qwen y Gemma siguen disponibles y como están. **PLaMo 3 Translate queda excluido** (decisión D3): no se evalúa ni se recomienda.
> Ninguna cifra de calidad de este documento es una evaluación humana; las de terceros llevan su fuente.

**Etiquetas de evidencia:** **[AUTOR]** dato de quien publica el modelo · **[TERCERO]** evaluación independiente · **[NUESTRO]** medido
por STARBLITZ (con el dispositivo indicado) · **[EST]** estimación teórica · **NV** no verificado. Metadatos de Hugging Face (licencia,
acceso, revisión `sha`) consultados por API el **2026-11-12**; las licencias son las **declaradas** por quien publica (no es asesoramiento legal).

## 1. Estado general

- La calidad actual está limitada por el **tamaño y el tipo de modelo**, no por el motor: el traductor contextual, el glosario, la memoria de
  personajes, los controles (eco, `garbled`, `incomplete`, es-419, negativas) y la reformulación ya son comunes a PC y Android con paridad.
- Hay **un candidato claramente superior para PC** que no está en el catálogo: **Hy-MT2-7B** (traducción dedicada, Apache-2.0 comprobada,
  4,62 GB, cabe entero en 8 GB de VRAM). Su ventaja sobre Gemma 4 E4B es **de su propio autor** y no está medida por nosotros.
- Para **Android modesto** (Redmi Note 8 Pro) los únicos candidatos razonables siguen siendo **≤ 2B**; el cambio más prometedor no es de
  modelo sino de **formato**: **Q4_0** (el `llama-server` b12017 empaquetado lo reordena con dotprod en el A76) en lugar de Q4_K_M.
- No hay ninguna medida en teléfono. **Nada se puede declarar ganador** hasta pasar el benchmark común (§8) con revisión humana.

## 2. Auditoría del sistema actual (código `73c5ae4`)

| Aspecto | Estado real | Consecuencia |
|---|---|---|
| Catálogo | **Uno solo** para PC y Android (`engine/starblitz_engine/llm/catalog.py` → `apps/shared/src/llm/catalog.json`). La plataforma se deduce de `tiers` (`low/mid/high/pc-gpu`) y del indicador `mobile` del asesor. | El móvil lista modelos de 7–15 GB como «no cabe»; no hay entradas exclusivas por plataforma ni cuantización distinta por plataforma. |
| Entradas | Qwen3.5 2B/4B (Q4 y Q5)/9B, Gemma 4 E2B/E4B/12B/26B‑A4B (QAT Q4_0), Hy‑MT2‑1.8B (Q4_K_M, `tiers=()`). Todas Apache‑2.0 declarada. | Dos familias generalistas y un dedicado que nunca se recomienda. |
| Recomendación PC con GPU de 8 GB | `pick_default("pc-gpu", 8)` → **`qwen3.5-9b-q4km`**. | **Contradice la medida del 2026-11-10** ([MODELOS-INVESTIGACION](MODELOS-INVESTIGACION.md)): Qwen 9B «no compensa»; Gemma 4 E4B fue la mejor relación calidad/coste. No se cambia en esta fase. |
| Recomendación del Redmi | Perfil `mid` → Qwen3.5‑4B Q4_K_M (2,7 GB). | Medido solo en PC; por analogía (§4.3) es poco práctico en un G90T. |
| Cuantización Android | Q4_K_M (Qwen, Hy-MT2). | En ARM, llama.cpp solo reordena **Q4_0** (y Q8_0/IQ4_NL) en tiempo de carga; Q4_K_M pierde la ruta rápida [TEO]. |
| Datos de calidad/velocidad | El catálogo no guarda calidad ni velocidad medidas. | Correcto (no se inventan), pero no hay dónde registrar resultados reales con procedencia. |
| Texto del asesor | En PC dice «…y sin GPU dedicada» aunque haya GPU (`advisor.ts`/`advisor.py`). | Defecto menor de UX, para la fase de implementación. |
| «Comparar modelos» | `llm/benchmark.py`: 4 frases, segundos y tok/s. | Solo velocidad. |
| Banco de pruebas | `tools/bench/` (corpus 56 ja/ko, `bench_translate.py`, `translate_models.py`, `translate_compare.py`). | Base reutilizable para el benchmark común. |
| `llama-server` | b12017 (2026-10-30): Windows Vulkan; Android arm64 solo CPU (`-ngl 0`), con todas las variantes de CPU (`GGML_CPU_ALL_VARIANTS`). | Arquitecturas recientes pueden exigir actualizar llama.cpp: se verifica por candidato. |

## 3. Candidatos para PC (RTX 4060 Laptop 8 GB · i7-13620H · 32 GB)

### 3.1 Recomendados para pruebas reales

**① Hy-MT2-7B (Tencent, traducción dedicada)** — [`tencent/Hy-MT2-7B`](https://huggingface.co/tencent/Hy-MT2-7B) (sha `9b0eb4e8f0`, 2026-05-26) · GGUF oficial [`tencent/Hy-MT2-7B-GGUF`](https://huggingface.co/tencent/Hy-MT2-7B-GGUF) (sha `ab8472660a`): Q4_K_M 4,62 GB, Q8_0 7,98 GB.
- **Licencia:** Apache-2.0 en código **y pesos** (comprobado: `LICENSE.txt` dice «Hy-MT2-7B is licensed under the Apache License, Version 2.0»; sin cláusula territorial, a diferencia de Hunyuan-MT y HY-MT1.5). Sin acceso restringido.
- **Idiomas:** 33, incluidos ja, en, ko, zh, es [AUTOR].
- **Evidencia:** [AUTOR] [arXiv 2605.22064](https://arxiv.org/abs/2605.22064) (v2, 2026-05-25), WMT25 (XCOMET-XXL / CometKiwi / GEMBA): Hy-MT2-7B **63,86 / 71,21 / 82,24** frente a Gemma 4 E4B sin razonamiento 38,36 / 55,45 / 59,95, Gemma 4 26B-A4B 49,62 / 64,22 / 74,36 y Qwen3.6-35B-A3B 51,11 / 66,70 / 75,28. [TERCERO] su predecesor fue el mejor sistema restringido de [WMT25](https://aclanthology.org/2025.wmt-1.22/). **No hay cifras desglosadas ja→es ni en→es.** Métricas automáticas de un autor que compite: hay que confirmarlo con nuestro corpus.
- **Requisitos [EST]:** misma arquitectura que Hy‑MT2‑1.8B (ya soportada por b12017); KV f16 ≈ 1,6 GB con 12k tokens (≈ 0,8 GB en q8_0) → ≈ 6,3–6,8 GB: **cabe entero en GPU**. 35–45 tok/s esperables (Gemma E4B medido: 46).
- **Ventajas:** el autor publica plantillas de **glosario, contexto («Background Information») y datos estructurados (JSON con claves preservadas)**, que encajan con el traductor contextual.
- **Riesgos:** sin datos de es-419 frente a es-ES (pedir «Latin American Spanish» y medir españolismos); no rellena hablante/emoción si se usa `PlainTranslator`; posible suavizado (la 1.8B suavizó un insulto en nuestro corpus [NUESTRO, PC]).

**② Gemma 4 26B-A4B (MoE, 3,8B activos)** — [`google/gemma-4-26B-A4B-it`](https://huggingface.co/google/gemma-4-26B-A4B-it) (sha `4d7ae4984b`) · ya está en el catálogo (QAT Q4_0 14,4 GB); alternativa [`unsloth/gemma-4-26B-A4B-it-GGUF`](https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF) UD-Q4_K_M 16,95 GB.
- **Licencia:** Apache-2.0 (comprobado), sin acceso restringido. Misma familia que Gemma 4 E4B, el mejor medido por nosotros.
- **Evidencia:** [TERCERO, autor rival] WMT25 49,62 / 64,22 / 74,36 (vs E4B 38,36 / 55,45 / 59,95). [AUTOR] MMMLU 86,3 % vs 76,6 % de E4B.
- **Requisitos [EST]:** no cabe en 8 GB → **híbrido**: atención y KV en GPU, expertos en RAM (`--n-cpu-moe N`); 15–30 tok/s según ancho de banda de la RAM; ≈ 17 GB entre RAM y VRAM. **Con Vulkan en Windows: NV.**
- **Riesgos:** prefill lento con contexto de capítulo; 32 GB de RAM justos con OCR, detector y Electron; desactivar razonamiento.

**③ Hy-MT2-30B-A3B (MoE)** — [`tencent/Hy-MT2-30B-A3B`](https://huggingface.co/tencent/Hy-MT2-30B-A3B) (sha `d3ead4dba6`) · GGUF oficial Q4_K_M 18,24 GB (resubido 2026-07-23).
- **Licencia:** Apache-2.0 (comprobado). **Evidencia** [AUTOR]: WMT25 62,89 / 71,08 / **84,34**; FLORES XX⇔XX 87,47 (el 7B saca más XCOMET en WMT25).
- **Requisitos:** híbrido como ②. Arquitectura `hy_v3` fusionada en llama.cpp el 2026-07-13 ([PR #25395](https://github.com/ggml-org/llama.cpp/pull/25395)); GGUF previos fallaban ([#25657](https://github.com/ggml-org/llama.cpp/issues/25657)). **Que cargue en b12017: NV.** Probar solo si ① se queda corto en modismos.

**④ Qwen3.6-35B-A3B (MoE generalista)** — [`Qwen/Qwen3.6-35B-A3B`](https://huggingface.co/Qwen/Qwen3.6-35B-A3B) (sha `345d467b11`) · [`unsloth/Qwen3.6-35B-A3B-GGUF`](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF) UD-Q4_K_M 22,13 GB. Apache-2.0 (comprobado).
- **Evidencia:** [TERCERO] WMT25 51,11 / 66,70 / 75,28 (tabla de Hy-MT2); [TERCERO] ~33 tok/s con `-ncmoe 28` en una RTX 3070 Laptop 8 GB ([fuente](https://windowsforum.com/news/llama-cpp-n-cpu-moe-run-qwen3-35b-faster-on-8gb-rtx-laptop-gpus.449607/?amp=1); probablemente CUDA).
- **Riesgos:** razona por defecto (hay que desactivarlo); 22 GB de RAM para el modelo; la familia Qwen fue la peor medida por nosotros en el capítulo real (Qwen3.5-4B: ≈ 13 errores/30). Referencia generalista, no favorito.

### 3.2 Experimentales (con un freno concreto)

| Modelo | Licencia de los pesos | Por qué no es prioritario |
|---|---|---|
| TranslateGemma-12B / 4B ([`google/translategemma-12b-it`](https://huggingface.co/google/translategemma-12b-it), sha `d1b225e1ca`) | **Gemma Terms**, acceso restringido (manual) | Plantilla rígida con códigos de idioma: sin contexto, glosario ni JSON; 12B tiene el mismo problema de VRAM que Gemma 4 12B. [AUTOR] [arXiv 2601.09012](https://arxiv.org/abs/2601.09012) |
| Seed-X-PPO-7B ([`ByteDance-Seed/Seed-X-PPO-7B`](https://huggingface.co/ByteDance-Seed/Seed-X-PPO-7B)) | OpenMDW-1.0 (permisiva; declarada «other» en HF) | Sin plantilla de chat, frase a frase con etiqueta `<es>`: solo valdría como `PlainTranslator` sin contexto |
| Tower-Plus-9B ([`Unbabel/Tower-Plus-9B`](https://huggingface.co/Unbabel/Tower-Plus-9B)) | **CC-BY-NC-SA-4.0** (comprobado) | Único que declara «Spanish (Latin America)», pero no comercial y share-alike |
| EuroLLM-22B-Instruct-2512 | Apache-2.0 | Denso de 22B: híbrido lento [EST 4–8 tok/s]; fuerte en lenguas de la UE, sin datos ja→es |
| Ministral-3-14B-Instruct-2512 | Apache-2.0 | No cabe con contexto en 8 GB; sin benchmark de traducción |
| YanoljaNEXT-Rosetta-12B | Gemma (base Gemma 3) | Orientado a datos estructurados, sin evidencia sólida |
| SalamandraTA-7B | **GPL-3.0** en los pesos | Débil en CJK; la GPL complica la redistribución |

### 3.3 Descartados

Hunyuan-MT-7B y Chimera (licencia Tencent Hunyuan con **exclusión de UE, Reino Unido y Corea del Sur**; los sustituye Hy-MT2) · Aya
Expanse, tiny-aya, Command R7B (**CC-BY-NC**) · gpt-oss-20b (formato «harmony» y razonamiento obligatorio) · Qwen3-Swallow y llm-jp-4.1
(razonamiento obligatorio, solo ja/en) · GLM-4.7-Flash, Phi-4, Llama 3.1 (no cubren ja/ko/zh/es) · MADLAD-400 (frase a frase, sin
contexto) · VNTL y ajustes de novela visual (solo ja→en; **no se encontró ningún ajuste serio de manga hacia español**) · Qwen3.6-27B
denso (< 5 tok/s [EST]) · NLLB (CC-BY-NC) · **PLaMo 3 Translate (D3)**.

## 4. Candidatos para Android

### 4.1 Hechos técnicos que condicionan todo (Redmi Note 8 Pro: Helio G90T, 2× A76 + 6× A55, Mali-G76, 6–8 GB)

- **Q4_0 en lugar de Q4_K_M** [TEO, código de llama.cpp]: la release `android-arm64` de b12017 se compila con `GGML_CPU_ALL_VARIANTS` y
  `tools/prepare_llama_android.sh` copia todas las variantes; en carga, `repack.cpp` reordena **Q4_0** a `q4_0_4x4` con NEON+dotprod (A76)
  y a `q4_0_4x8` con i8mm (A78C/X2+). Q4_K_M no tiene esa ruta. **Hay que medirlo en el Redmi.**
- **GPU Mali no sirve**: el backend OpenCL de llama.cpp solo verifica Adreno ([OPENCL.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/OPENCL.md)); en Vulkan hay informes de rendimiento muy bajo y más RAM en Mali [PUB]. CPU con 2 o 4 hilos.
- **Hy-MT2 en 2 bits y 1,25 bits no funciona con b12017**: necesitan PR sin fusionar ([#19357](https://github.com/ggml-org/llama.cpp/pull/19357), solo SME2; [#22836](https://github.com/ggml-org/llama.cpp/pull/22836), STQ1_0).
- **No existe ninguna medida publicada del G90T con llama.cpp.** Lo más cercano: Raspberry Pi 5 (4× A76 a 2,4 GHz): Qwen2.5-0.5B Q4_0 pp512 290 / tg 34 tok/s ([#30069](https://github.com/ggml-org/llama.cpp/discussions/30069)); Gemma 4 E2B/E4B con LiteRT 8 / 3 tok/s de generación ([Google](https://developers.google.com/edge/litert-lm/models/gemma-4)); 7B en A76: 2–4 tok/s ([arXiv 2410.03613](https://arxiv.org/html/2410.03613v3)). El G90T tiene solo **2** A76 a 2,05 GHz: esperar **menos**.
- **Temperatura** [PUB, arXiv 2410.03613]: 42,6 → 66,8 °C en una inferencia de 7B (Kirin 9000E); en el 8 Gen 3 la frecuencia de los núcleos grandes casi se reduce a la mitad hacia la ronda 99. El OCR compite por la CPU: `ThermalPacer` es imprescindible.

### 4.2 Candidatos

| Modelo · repositorio | Licencia pesos (comprobada) | GGUF Q4_0 | KV f16 6k [EST] | Evidencia de traducción | Valoración |
|---|---|---|---|---|---|
| **Hy-MT2-1.8B** · [`tencent/Hy-MT2-1.8B`](https://huggingface.co/tencent/Hy-MT2-1.8B); Q4_0 en [`unsloth/Hy-MT2-1.8B-GGUF`](https://huggingface.co/unsloth/Hy-MT2-1.8B-GGUF) (sha `0378cc2780`) | Apache-2.0 | **1,08 GB** | 403 MB (la mayor; q8_0 la reduce a la mitad) | [AUTOR] supera a las API de Microsoft y Doubao en conjunto; [NUESTRO, PC CPU] 39/56 frente a 30/56 de Qwen3.5-2B en ja/ko | **Recomendado para pruebas** (dedicado, texto plano por lotes) |
| **Qwen3.5-2B** · [`Qwen/Qwen3.5-2B`](https://huggingface.co/Qwen/Qwen3.5-2B); unsloth Q4_0 | Apache-2.0 | 1,21 GB | 75 MB | [AUTOR] WMT24++ XCOMET 45,8 (0.8B 27,2; 4B 66,6) | **Recomendado para pruebas** en modo JSON contextual (ya en catálogo; cambiar a Q4_0) |
| **Gemma 4 E2B** · [`google/gemma-4-E2B-it`](https://huggingface.co/google/gemma-4-E2B-it) · QAT Q4_0 oficial 3,35 GB (ggml-org Q4_0 2,84) | **Apache-2.0** (comprobado; ya no es Gemma Terms) | 2,84–3,35 GB* | ≈ 44 MB | [AUTOR] sin WMT/FLORES publicados; misma familia que E4B (la mejor medida en PC) | Experimental en 6 GB (lento [EST]); recomendado para 8 GB+ |
| Qwen3.5-4B | Apache-2.0 | 2,58 GB | 201 MB | [AUTOR] WMT24++ 66,6; [NUESTRO, PC] ≈13 errores/30 en el capítulo real | Gama ≥ 8 GB; poco práctico en el Redmi [EST] |
| Gemma 4 E4B | Apache-2.0 | 5,15 GB (QAT) | ≈ 88 MB | [NUESTRO, PC GPU] la mejor de las medidas en PC | Solo ≥ 12 GB (S26 Ultra: 18 tok/s en CPU, [AUTOR] LiteRT) |
| LFM3-1.7B · [`LiquidAI/LFM3-1.7B-GGUF`](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF) (2026-11-09) | **LFM Open License v1.0** («other»: comercial solo < 10 M USD de ingresos) | QAD-Q4_0 1,05 GB | 75 MB | No encontrada | Experimental (licencia: decide el titular; soporte en llama.cpp antes de b12017, NV) |
| LFM2.5-1.2B | LFM Open License v1.0 | QAD-Q4_0 0,70 GB | 75 MB | No encontrada; [AUTOR] 70 tok/s en S25 Ultra | Experimental para ≤ 4 GB |
| Qwen3.5-0.8B | Apache-2.0 | 0,51 GB | — | [AUTOR] WMT24++ 27,2; [NUESTRO] 18/56 | Solo como último recurso (≤ 4 GB) |
| TranslateGemma-4B | Gemma Terms (restringido) | Q4_K_M 2,49 GB (tercero) | — | [AUTOR] WMT24++ | Experimental: plantilla sin contexto ni glosario |
| SmolLM3-3B / Llama 3.2 / Salamandra 2B / Granite 4 | Apache-2.0 / Llama / Apache / Apache | 1,9–2,0 GB | 300+ MB | — | **Descartados**: no declaran japonés/coreano |
| Phi-4-mini / Ministral-3-3B | MIT / Apache-2.0 | 2,2–2,5 GB | 650–800 MB | — | Descartados para el Redmi (KV grande); posibles en ≥ 8 GB |
| OPUS-MT ja→es / ko→es (Marian) | Apache-2.0 | CT2/ONNX, no GGUF | — | [AUTOR] Tatoeba BLEU 34,6 / 31,3 (frases cortas) | Descartado: otro motor, sin contexto ni glosario; no hay zh→es |
| Tower+ 2B, tiny-aya | CC-BY-NC(-SA) | — | — | — | Descartados (no comerciales) |

\* En Gemma 4, ~50–55 % del archivo son *Per-Layer Embeddings*; LiteRT declara 1,7 GB de pico en CPU para E2B. Con llama.cpp: no encontrado.

### 4.3 Qué puede ejecutar cada gama (todo [EST] salvo lo marcado)

| Gama | Recomendado para pruebas | Posible con límites | Descartado |
|---|---|---|---|
| ≤ 4 GB | Hy-MT2-1.8B Q4_0 (contexto ≤ 4k, KV q8_0) | LFM2.5-1.2B (licencia), Qwen3.5-0.8B | ≥ 3B, Gemma 4 |
| **6 GB (Redmi Note 8 Pro)** | **Hy-MT2-1.8B Q4_0** (texto plano por lotes) y **Qwen3.5-2B Q4_0** (JSON contextual). Generación esperada ≲ 10 tok/s, prefill de decenas a ~100 tok/s | Gemma 4 E2B (lento y caliente), LFM3-1.7B (licencia, sin datos) | Qwen3.5-4B (≈ 3 tok/s por analogía), Gemma 4 E4B, ≥ 7B, GPU Mali |
| 8 GB (A76/A78, a veces i8mm) | Lo anterior + Gemma 4 E2B / Qwen3.5-4B | TranslateGemma-4B, Phi-4-mini, Ministral-3B | ≥ 7B |
| ≥ 12 GB (8 Gen 2/3/Elite, D9300+, Tensor G3+) | Gemma 4 E4B QAT, Qwen3.5-4B, Hy-MT2-1.8B | Hy-MT2-7B Q4_K_M (lento), OpenCL en Adreno | — |

## 5. Tabla comparativa (candidatos que merecen prueba)

| Modelo | Plataforma | Tipo | Licencia pesos | Descarga | Memoria [EST] | Velocidad | Calidad (fuente) | Encaje con el motor |
|---|---|---|---|---|---|---|---|---|
| Hy-MT2-7B Q4_K_M | PC | dedicado | Apache-2.0 ✅ | 4,62 GB | 6,3–6,8 GB VRAM | 35–45 tok/s [EST] | WMT25 muy por encima de E4B [AUTOR] | JSON/glosario/contexto con plantilla propia (por validar) |
| Gemma 4 26B-A4B | PC | generalista MoE | Apache-2.0 ✅ | 14,4–17 GB | híbrido ~17 GB | 15–30 tok/s [EST] | WMT25 > E4B [TERCERO rival] | JSON actual (misma familia que E4B) |
| Hy-MT2-30B-A3B | PC | dedicado MoE | Apache-2.0 ✅ | 18,24 GB | híbrido ~19 GB | 20–33 tok/s [EST] | mejor GEMBA WMT25 [AUTOR] | como el 7B; carga en b12017 NV |
| Qwen3.6-35B-A3B | PC | generalista MoE | Apache-2.0 ✅ | 22,13 GB | híbrido ~23 GB | ~33 tok/s [TERCERO, CUDA] | WMT25 < Hy-MT2 [TERCERO] | JSON; desactivar razonamiento |
| Gemma 4 E4B (actual) | PC | generalista | Apache-2.0 ✅ | 5,15 GB | 3,3 GB VRAM [NUESTRO] | 46 tok/s [NUESTRO] | ≈ 3–4 errores/30 [NUESTRO, revisión no humana] | **línea base PC** |
| Hy-MT2-1.8B Q4_0 | Android (y PC CPU) | dedicado | Apache-2.0 ✅ | 1,08 GB | ≈ 1,5 GB | ≲ 10 tok/s en G90T [EST] | 39/56 [NUESTRO, PC] | `PlainTranslator` |
| Qwen3.5-2B Q4_0 | Android | generalista | Apache-2.0 ✅ | 1,21 GB | ≈ 1,3 GB | ≲ 10 tok/s [EST] | 30/56 [NUESTRO, PC] | JSON contextual (**línea base Android**) |
| Gemma 4 E2B QAT | Android ≥ 8 GB | generalista | Apache-2.0 ✅ | 3,35 GB | ≈ 2–3,4 GB | 8 tok/s en Pi 5 con LiteRT [AUTOR] | sin datos de traducción | JSON contextual |

## 6. Licencias verificadas (API de Hugging Face, 2026-11-12)

| Repositorio | `license` declarada | Acceso | sha | Comprobación adicional |
|---|---|---|---|---|
| tencent/Hy-MT2-7B · -GGUF | apache-2.0 | libre | 9b0eb4e8f0 · ab8472660a | `LICENSE.txt`: Apache-2.0, sin cláusula territorial |
| tencent/Hy-MT2-30B-A3B · -GGUF | apache-2.0 | libre | d3ead4dba6 · fd3dcbb6b3 | `LICENSE.txt`: Apache-2.0, sin cláusula territorial |
| tencent/Hy-MT2-1.8B-GGUF · unsloth/Hy-MT2-1.8B-GGUF | apache-2.0 | libre | a0c709d9fa · 0378cc2780 | Q4_0 1 080 MB existe |
| google/gemma-4-26B-A4B-it · gemma-4-E2B-it (+ QAT GGUF) | apache-2.0 | libre | 4d7ae4984b · 4adf15748d · 675cff42a7 | Gemma 4 publicada con Apache-2.0 |
| Qwen/Qwen3.6-35B-A3B · unsloth GGUF · Qwen/Qwen3.5-2B | apache-2.0 | libre | 345d467b11 · a483e9e6cb · 15852e8c16 | — |
| google/translategemma-12b-it · gemma-3n-E2B-it | gemma | **manual** | d1b225e1ca · 5e092ebca1 | Gemma Terms (no Apache) |
| ByteDance-Seed/Seed-X-PPO-7B | other (OpenMDW-1.0 según ficha) | libre | 6ef78fc034 | leer OpenMDW antes de usar |
| Unbabel/Tower-Plus-9B | **cc-by-nc-sa-4.0** | libre | c59d17c5bb | no comercial |
| LiquidAI/LFM3-1.7B · -GGUF | other (LFM Open License v1.0) | libre | 1da06bec6a · cd0c74c575 | comercial solo < 10 M USD |
| HuggingFaceTB/SmolLM3-3B · ibm-granite/granite-4.0-micro · EuroLLM-1.7B · salamandra-2b | apache-2.0 | libre | a07cc9a04f · 56111ae135 · a25c7fa65f · 66b2be1e98 | sin ja/ko declarados (descartados por idioma) |

Regla aplicada: «Apache-2.0» solo cuando lo declaran **los pesos** (archivo de licencia o `license` del repositorio de pesos), no el código.

## 7. Requisitos de hardware (resumen)

- **PC, todo en GPU (8 GB):** modelos densos ≤ 7–8B en Q4 con contexto 12k (Hy-MT2-7B, Gemma 4 E4B). 12B+ densos se desbordan a memoria compartida (medido con Gemma 4 12B: 25 → 4 tok/s [NUESTRO]).
- **PC, híbrido:** MoE de 3–4B activos (Gemma 26B-A4B, Hy-MT2-30B-A3B, Qwen3.6-35B-A3B) con `--n-cpu-moe`; limita el ancho de banda de la RAM y el prefill en CPU; 17–23 GB de RAM solo para el modelo.
- **PC sin GPU (32 GB):** Hy-MT2-7B y Gemma 4 E4B en CPU (lentos pero viables); MoE en CPU, velocidad NV.
- **Android 6 GB:** ≤ 2B en Q4_0, contexto ≤ 4–6k, 2–4 hilos en los núcleos grandes, KV q8_0 para Hy-MT2.
- **Android ≥ 12 GB:** hasta E4B; 7B posible pero lento y caliente.

## 8. Benchmark lingüístico común (PC y Android)

### 8.1 Corpus
- **`docs/benchmark/corpus-es419-v1.jsonl`** (nuevo): **233 segmentos inventados** (122 ja, 101 en —62 en mayúsculas de cómic—, 10 ko) en
  7 capítulos y 29 escenas con personajes recurrentes; glosario por capítulo (58 términos); referencia es-419 profesional,
  `must_keep`, `must_not`, contexto para el evaluador. Etiquetas: continuidad 93, humor 56, modismo 28, referencia cultural 27, onomatopeya 25,
  narración 19, pensamiento 17, insulto 17, ambiguo 14, sarcasmo 14, doble sentido 14, diálogo largo 14, vulgar 8, texto cortado 6, adulto 5.
  Formato y campos en [benchmark/README.md](benchmark/README.md).
- **Limitaciones del corpus:** escrito por IA y **sin revisar por un traductor nativo** (la referencia es orientativa, no verdad absoluta);
  categorías adulto/vulgar/texto cortado con pocos casos; coreano solo una escena. Complementos: el capítulo real en inglés (427 regiones,
  privado) y manga/manhwa reales del titular (privados, fuera de Git).

### 8.2 Métricas (se informan por separado; no hay «nota única»)
| Métrica | Cómo | Unidad |
|---|---|---|
| Fidelidad semántica | Humano, MQM simplificado (menor / mayor / crítico) + `must_keep` automático | errores mayores por 100 segmentos |
| Naturalidad | Humano | 1–5 |
| Adecuación es-419 | Automático (`must_not`, «vosotros», lista de españolismos) + humano | infracciones / 100 |
| Contexto | Segmentos que dependen de la escena (género, referente, registro) | % correctos (humano) |
| Consistencia | Glosario y nombres idénticos en escena y capítulo; tú/usted estable | % automático |
| Omisiones | `must_keep` ausente, texto sin traducir, longitud anómala | / 100 |
| Invenciones | Humano (heurística de longitud como aviso) | / 100 |
| Suavizado y negativas | Intensidad de insultos/vulgaridades; `isRefusal` | % conservado |
| Formato | JSON válido, eco, cortes por tope | tasas |
| Rendimiento | prefill/generación (tok/s), s/página, RAM/VRAM pico; Android: temperatura y batería en 20 min | medido, con dispositivo |

Prohibido declarar > 95 % de precisión sin revisión humana sobre este corpus completo y material real; BLEU/COMET/XCOMET solo como apoyo.

### 8.3 Protocolo
1. **Fase A — filtro automático (PC):** todos los candidatos, corpus completo, el traductor real de la app (contextual o texto plano), mismas instrucciones, `temperature` fija, 1 ejecución por semilla.
2. **Fase B — revisión humana ciega:** 3–5 finalistas por plataforma; salidas barajadas sin nombre de modelo; muestra estratificada de ≥ 100 segmentos; 2 revisores latinoamericanos si es posible y acuerdo entre ellos.
3. **Fase C — dispositivo:** RTX 4060 (PC) y Redmi Note 8 Pro (Android, lo ejecuta el titular con `llama-bench` y la app); opcional un teléfono moderno.
4. **Decisión:** «recomendado» solo si reduce los errores mayores de forma clara (p. ej. ≥ 30 % menos en ≥ 100 segmentos) frente a la línea base de su plataforma (PC: Gemma 4 E4B; Android: Qwen3.5-2B) **y** su rendimiento es aceptable allí.
5. **Registro:** cada resultado con dispositivo, build de llama.cpp, cuantización, SHA-256 del GGUF, versión del corpus, fecha y revisor.

## 9. Arquitectura de los dos apartados

**Compartido (no se duplica):** prompts y esquemas, glosario/diccionario, memoria de personajes, contexto de capítulo, controles de
omisión/invención/eco/es-419/negativas, normalización, comprobación de encaje, y los **formatos** de catálogo y de evaluación (Python ↔ TS con
la guarda de paridad de CI).

**Separado por plataforma:**
1. **Catálogo:** una sola fuente con `platforms: ["pc"] | ["android"] | ambos` y bloques propios (`pc: {quant, file, vram_min, ram_min, offload: "gpu"|"hybrid"|"cpu", n_cpu_moe}`, `android: {quant (Q4_0), file, ram_min, threads, ctx_max, kv_type}`), exportada a `catalog.pc.json` y `catalog.android.json`. Cada apartado solo ve los suyos.
2. **Evaluaciones:** archivo aparte (`evaluations.json`) con `{model_id, platform, device, llama_cpp_build, quant, sha256, corpus_version, date, metrics, reviewers}`. Sin entrada → «Pendiente de evaluación».
3. **Estados derivados:** *Recomendado* (evaluado y elegido para ese perfil) · *Experimental* (sin evaluación humana completa) · *Pendiente de evaluación* · *Incompatible* (no cabe o su arquitectura no la soporta el `llama-server` empaquetado; con el motivo).
4. **Ejecución:** PC — `ngl` automático, híbrido con `--n-cpu-moe` para MoE, Vulkan/CPU. Android — CPU, hilos = núcleos grandes, contexto acotado por RAM, KV q8_0 cuando ahorre, `ThermalPacer` y `DeviceStatusGuard` (ya existen).
5. **Recomendación:** asesor por plataforma con su propia tabla (PC: VRAM/RAM; Android: RAM, extensiones de CPU detectables —dotprod/i8mm—, espacio libre). Corregir el texto «sin GPU dedicada».
6. **Formatos de prompt por familia:** el motor ya separa contextual (JSON) y `PlainTranslator`; Hy-MT2-7B añadiría una tercera vía opcional con sus plantillas oficiales de contexto y datos estructurados, a validar en la fase A.

## 10. Diseño de experiencia de usuario

- Dos apartados con el mismo esqueleto (Instalados · Recomendados · Explorar · Comparar · Avanzado), cada uno con **su** catálogo.
- **Tarjeta:** nombre · plataforma · idiomas · licencia (permisiva / con condiciones / no comercial) · tamaño de descarga · RAM y VRAM necesarias (marcadas «estimación») · cuantización · **Calidad evaluada** (solo con evaluación registrada, con su fuente y fecha; si no: «Pendiente de evaluación») · **Velocidad medida** (con el dispositivo; «Probar velocidad» mide en el propio equipo) · compatibilidad (GPU / híbrido / CPU / no cabe) · progreso de descarga · «En uso».
- **Insignias:** Recomendado · Experimental · Pendiente de evaluación · Incompatible (con motivo legible).
- **Nunca** una puntuación sin fuente; nunca «el mejor» sin evaluación.
- **Android:** aviso de temperatura y batería si la evaluación lo indica; tamaño frente a espacio libre; recomendación de Q4_0 transparente para el usuario.
- **Comparar:** velocidad (ya existe) + «muestra de calidad» con 10 segmentos del corpus mostrados lado a lado, sin nota automática.

## 11. Candidatos que merecen pruebas reales (orden propuesto)

| # | Plataforma | Prueba | Por qué |
|---|---|---|---|
| 1 | PC | **Hy-MT2-7B Q4_K_M**, todo en GPU: traductor contextual actual **y** plantilla oficial de contexto/JSON; «Latin American Spanish» | Mayor ganancia esperada con licencia limpia y sin híbrido |
| 2 | PC | **Gemma 4 26B-A4B** híbrido, barrido de `--n-cpu-moe` 20–30 (tok/s, VRAM, RAM, temperatura) | Salto natural desde E4B; ya en catálogo |
| 3 | Android (Redmi, el titular) | `llama-bench -p 512 -n 128 -t 2,4,6` con **Hy-MT2-1.8B** Q4_0 vs Q4_K_M y **Qwen3.5-2B** Q4_0 | Confirma repack/dotprod, hilos y velocidad real |
| 4 | Android (PC primero, luego Redmi) | Corpus completo con Hy-MT2-1.8B Q4_0 (texto plano) y Qwen3.5-2B Q4_0 (JSON) | Elegir el traductor del Redmi |
| 5 | PC | Hy-MT2-30B-A3B (comprobando carga en b12017) | Solo si el 7B falla en modismos |
| 6 | PC | Qwen3.6-35B-A3B sin razonamiento | Referencia generalista |
| 7 | Android ≥ 8 GB | Gemma 4 E2B QAT | Calidad de la familia E4B en móvil (requiere teléfono de 8 GB+) |

Todas en el benchmark común (§8) y con revisión humana antes de recomendar nada.

## 12. Riesgos y limitaciones

- **Evidencia de calidad mayoritariamente del autor** (Hy-MT2 compara con sus rivales); sin datos independientes ja→es / en→es. Mitigación: nuestro corpus + revisión humana.
- **es-419 frente a es-ES:** ningún candidato salvo Tower+ (no comercial) declara español latinoamericano; riesgo de españolismos (ya visto en Qwen 9B y Gemma E4B).
- **Suavizado/censura** en insultos y contenido adulto: medido solo en 56 segmentos [NUESTRO]; hay que medirlo con el corpus nuevo.
- **Híbrido en Windows con Vulkan:** rendimiento y estabilidad sin medir; 32 GB de RAM justos; calor del portátil.
- **llama.cpp:** b12017 puede no cargar arquitecturas recientes (`hy_v3`) o variantes de cuantización; actualizar llama.cpp afecta a Windows y Android a la vez y exige su propia validación.
- **Android:** sin medidas en el G90T; temperatura y RAM real de la app desconocidas; un 4B probablemente inviable.
- **Licencias:** LFM (umbral de ingresos), Gemma Terms (TranslateGemma, Gemma 3n), NC (Tower+, Aya) → **decisión del titular**; Apache-2.0 es la preferencia.
- **Corpus:** generado por IA, sin revisión nativa; puede sesgar a favor de modelos «parecidos» a quien lo escribió. La decisión final debe incluir material real.

## 13. Confirmado / pendiente / no verificado

- **Confirmado (hoy, por API/archivo de licencia):** licencias y acceso de §6; existencia y tamaño de los GGUF citados; título y fecha del informe de Hy-MT2; estado del catálogo y del asesor de STARBLITZ (código).
- **Confirmado previamente [NUESTRO, PC]:** Gemma 4 E4B > Qwen3.5-4B/9B en el capítulo real en inglés; Hy-MT2-1.8B > Qwen3.5-2B en 56 segmentos ja/ko.
- **Pendiente:** todas las pruebas de §11; revisión humana; medidas en el Redmi.
- **No verificado:** cifras WMT/FLORES del autor; velocidades estimadas; carga de `hy_v3` en b12017; beneficio del repack Q4_0 en el G90T; memoria real de Gemma 4 con llama.cpp en Android.

## 14. Siguiente fase recomendada (requiere autorización)

1. **Fase de medición en PC** (sin tocar el catálogo de la app): descargar Hy-MT2-7B Q4_K_M (4,6 GB) y, si se autoriza, Gemma 4 26B-A4B; pasar el corpus nuevo y el capítulo real con `tools/bench` (ampliado para leer el formato nuevo del corpus).
2. **Medición en el Redmi** (titular): `llama-bench` según §11.3, y una sesión de 20 min con la app (temperatura/batería).
3. **Revisión humana** de los finalistas (formulario ciego generado desde los resultados).
4. Con los datos: implementar los dos apartados (§9–10), mover Android a Q4_0 y proponer los nuevos recomendados. Qwen y Gemma se mantienen hasta entonces.

Fuentes completas y detalle por candidato: este documento resume dos informes de investigación del 2026-11-12 (PC y Android) guardados en el
Vault (`STARBLITZ OBISIDIAN/02_Evidencias/`).
