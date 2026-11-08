# Investigación de modelos de OCR y traducción

Metadatos (tamaños, licencias declaradas, idiomas) consultados en la API pública de Hugging Face el **2026-11-08**, sin
descargar ningún peso. **No se ha medido ninguna velocidad ni consumo de RAM** y **no se declara ningún ganador**: la tabla
de decisión queda vacía hasta ejecutar el [protocolo de comparación](#protocolo-de-comparación). Las licencias son las
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

| Modelo | Descarga (cuantizado) | Licencia (código / pesos) | Idiomas | Runtime y compatibilidad |
|---|---|---|---|---|
| **Qwen3.5-0.8B** Q4_K_M · `unsloth/Qwen3.5-0.8B-GGUF` | ✅ **508 MB** (Q4_0: 484 MB; visión opcional `mmproj` 195 MB) | ✅ Apache-2.0 | multilingüe (generalista) | ✅ `llama.cpp`, el runtime actual |
| Qwen3.5-2B Q4_K_M | ✅ **1 222 MB** (mmproj 637 MB) | ✅ Apache-2.0 | multilingüe | ✅ `llama.cpp` |
| Qwen3.5-4B Q4_K_M | ✅ **2 614 MB** (mmproj 641 MB) | ✅ Apache-2.0 | multilingüe | ✅ `llama.cpp` (familia del modelo recomendado hoy) |
| **OPUS-MT ja→es** · `Helsinki-NLP/opus-mt-ja-es` | ✅ ≈ **292 MB** (pesos PyTorch/TF; sin versión ONNX/CT2 oficial) | ✅ Apache-2.0 | ja → es | ❓ Marian: **no está en el runtime actual** (haría falta exportar a ONNX o CTranslate2 y escribir la búsqueda en haz) |
| **OPUS-MT ko→es** · `Helsinki-NLP/opus-mt-ko-es` | ✅ ≈ **298 MB** | ✅ Apache-2.0 | ko → es | ❓ igual que ja-es |
| OPUS-MT zh→es | ❌ **no existe** en Hugging Face (solo `zh-en`, `en-zh`…); habría que pivotar por inglés (calidad menor) | — | — | — |
| **MADLAD-400-3B-MT** · `google/madlad400-3b-mt` | ✅ GGUF Q4_K oficial **1 578 MB** (comunitario `cstr/…`: Q4_K 1 942 MB, Q8_0 3 219 MB); pesos completos 11 217 MB | ✅ Apache-2.0 | ✅ 400+ idiomas | ❓ Arquitectura T5 codificador-decodificador: **no está verificado que el `llama-server` incluido la sirva por la API de chat** |
| NLLB-200 distilled 600M | ✅ 2 346 MB (PyTorch FP32) | ❌ **CC-BY-NC-4.0** (no comercial) | 200 idiomas | descartado por licencia restrictiva |
| M2M-100 418M | ✅ 1 846 MB | ✅ MIT | 100 idiomas | ❓ no comparado aquí; 1,8 GB en FP32 |
| TranslateGemma 4B / Gemma 3 1B | comunitarios en GGUF | ⚠️ **licencia Gemma** (acceso restringido en el repositorio oficial; condiciones y política de uso propias) | multilingüe | ✅ `llama.cpp`; modelos con alineamiento de seguridad |

Calidad documentada de las alternativas de MT dedicadas (📖 en sus fichas): OPUS-MT ja→es BLEU 34,6 / chr-F 0,553 en
Tatoeba ja-es; ko→es BLEU 31,3 / chr-F 0,521 en Tatoeba ko-es. Son **frases cortas de un corpus general**: no representan el
registro, el argot ni el contexto de un manga, y estos modelos **no usan glosario, personajes ni páginas vecinas**.

### RAM estimada (no medida)

Orden de magnitud para llama.cpp: **tamaño del archivo + caché KV** (crece con el contexto) **+ ~0,3–0,5 GB** de
proceso. Con ese criterio, Qwen3.5-0.8B Q4 cabría con holgura incluso en 4 GB; el 4B Q4 (2,6 GB) pide un teléfono de
≥ 6–8 GB. **Son estimaciones**, no mediciones: la RAM real se medirá en el teléfono.

### Insultos, contenido adulto y expresiones explícitas

- Los modelos **instruidos** (Qwen, Gemma) pueden **negarse o suavizar** el texto por su alineamiento de seguridad. STARBLITZ
  ya detecta las negativas (`isRefusal`) y, con las correcciones de este trabajo, **conserva el original** en lugar de borrarlo.
- Los modelos de **traducción dedicada** (OPUS-MT, MADLAD, NLLB) no son conversacionales y no tienen capa de moderación
  declarada, pero ❓ **no hay documentación** de si omiten o atenúan léxico explícito por sus datos de entrenamiento: se medirá.
- Ningún comportamiento se da por sentado: el protocolo incluye una categoría de frases con insultos y contenido explícito.

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
