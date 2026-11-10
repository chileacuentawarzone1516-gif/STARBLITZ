# Detector de texto experimental: PP-OCRv6 Manga

Estado: **EXPERIMENTAL, desactivado por defecto.** El detector predeterminado sigue siendo `comic-text-detector`. Leyenda:
**CONFIRMADO** (medido o comprobado en el código) · **PENDIENTE** · **NO VERIFICADO**. Fecha: 2026-11-09.

## 1. Qué es (comprobado contra Hugging Face)

| Dato | Valor | Estado |
|---|---|---|
| Repositorio | `Kellenok/PP-OCRv6_manga`, revisión **`v0.3`** (2026-11-05) | CONFIRMADO (API de HF) |
| Archivo usado | `det/manga_det.onnx`, 1 816 958 bytes, SHA-256 `97c434ae8deaad83513fb132b605d5085a3af8ffac2cb15e2aa096815c206172` | CONFIRMADO: el archivo local coincide con el de `v0.3` y con `main` |
| Variante FP16 | `det/manga_det_fp16.onnx`, 961 964 bytes (SHA-256 `6cfa057e…7a17`); la ficha declara 0,02 pp de CER de diferencia | NO EVALUADA (ver §6) |
| Arquitectura (ficha) | PP-OCRv6 *tiny* (`PPLCNetV4` + `RepLKFPN` + cabeza **DB**) | según la ficha |
| Licencia | **Apache-2.0 declarada** en la ficha | declarada; ver §5 |
| Datos de entrenamiento | Manga109-s (acceso restringido en HF: no se pudieron leer sus condiciones sin cuenta) | **NO VERIFICADO** |
| Entrada / salida | imagen BGR normalizada (media/desviación de ImageNet), lado largo múltiplo de 32 (STARBLITZ usa **1600**; la ficha, 960: ver §3) → **un mapa de probabilidad de líneas** | CONFIRMADO (código y ejemplo oficial) |
| Post-procesado recomendado | `thresh=0.15`, `box_thresh=0.25`, `unclip_ratio=1.5` | se usan esos valores |
| Dependencias | solo ONNX Runtime (CPU / DirectML en PC; ONNX Runtime **Web** en Android) + OpenCV; **ningún** paquete nuevo (no hace falta `pyclipper`: la expansión se hace con el rectángulo mínimo, como el detector actual) | CONFIRMADO |
| Windows | se ejecuta con el ONNX Runtime del motor (CPU) | CONFIRMADO (corpus real) |
| Android | se ejecuta con ONNX Runtime Web + OpenCV.js (el mismo motor TS que corre en el `WebView`) | CONFIRMADO en Edge (Chromium) del PC con 46 páginas reales; **PENDIENTE en el teléfono** |

### Lo que el modelo NO hace (no se le atribuye)
- **No detecta globos** ni bloques: solo líneas sueltas.
- **No da máscara de trazos** (el detector actual tiene una U-Net de segmentación).
- **No clasifica idioma** (el actual distingue `eng`/`ja`): los bloques salen con `lang_hint = unknown`.

### Lo que añade STARBLITZ (código propio, `vision/manga_det.py` y `vision/mangaDet.ts`, con paridad)
1. Post-procesado DB → polígonos de línea a la escala de la página; páginas alargadas por **tramos** (igual que el detector actual).
2. **Agrupación** de líneas en bloques/párrafos con la misma regla del detector actual para el texto fuera de globos (`cluster_lines`).
3. **Máscara de trazos**: dentro de cada línea, Otsu separa trazos y fondo (la clase minoritaria son los trazos) y se dilata 2 px.
4. La **asociación con globos**, el orden de lectura, el OCR, la reconstrucción y la rotulación **no cambian**: son las del pipeline.

## 2. Cómo activarlo

- PC: *Ajustes → Procesamiento → Detector de texto ligero (experimental)* e instalar *Modelos → Visión → Detector ligero PP-OCRv6 Manga*.
- Móvil: *Ajustes → Procesamiento → Detector ligero (experimental)*; el modelo, en *Modelos → Visión*.
- API: `PATCH /api/settings {"processing": {"detector": "manga-det"}}` (valor por defecto `"default"`).
- Si se activa y el modelo no está instalado, el análisis **avisa de que falta** (no cambia de detector en silencio).
- La caché de análisis del móvil incluye el detector en su clave: no se mezclan resultados de los dos.

## 3. Resultados con páginas reales (cómic en inglés, 46 páginas) — CONFIRMADO

Detalle, método y límites en [EVALUACION-CORPUS-USM](EVALUACION-CORPUS-USM.md) §5. Resumen:

| | Por defecto | Experimental (1600 px) |
|---|---|---|
| Detección por página (A/B intercalado, CPU, mediana) | 5,37 s | **1,63 s (3,3×)** |
| Motor móvil (WASM, 4 hilos, Edge en PC) | ≈ 3,9 s (medida previa) | **1,06 s** |
| Pico de RAM del motor (solo visión) | 1 232 MB | **668 MB** |
| Cobertura de la capa de texto del PDF (indicador) | 85,8 % | 85,5 % |
| Regiones (más = más troceado) | 428 | 637 (173 fragmentos de ≤ 3 caracteres) |
| Regiones sin lectura del OCR | 1 | 27 |
| Pipeline completo, 10 págs. (con traducción) | 549 s | 557 s |
| Paridad Python ↔ TypeScript | — | 1 606/1 607 líneas, máscara IoU 0,9999 |

- **Lado largo 1600 en vez de 960** (valor de la ficha): a 960 se perdía la mitad de las líneas de una doble página (106/208 palabras de
  referencia); a 1600, 207/208. Con manga japonés NO está medido.
- **Limitación principal:** trocea los globos (las líneas del modelo son más ajustadas y no cumplen la regla de agrupación) y un bloque de una
  sola línea no encuentra su globo. Siguiente paso: agrupar por globo. Ver los fallos esperados en `engine/tests/test_manga_det.py`.
- **Veredicto:** más rápido y más ligero, pero hoy **no** sustituye al predeterminado. Falta además manga/manhwa real (ja/ko, vertical, SFX).

## 4. Qué falta para plantear cambiar el predeterminado (PENDIENTE)

1. **Manga y manhwa reales** (japonés vertical, coreano, onomatopeyas dibujadas): el corpus disponible es un cómic **en inglés**.
2. Revisión humana de las diferencias (texto no detectado, falsos positivos) y de la reconstrucción.
3. Medirlo en el **Redmi Note 8 Pro** (lo hace el titular con el APK; no se pide ahora).
4. Detector de **globos** con licencia permisiva para no depender de la forma del dibujo (ver §5).

## 5. Dependencia GPL-3.0 del detector actual: implicaciones y cómo aislarla o sustituirla

**Situación (CONFIRMADO en el código):** `comic-text-detector` (pesos **GPL-3.0**) no va dentro del instalador ni del APK; cada
usuario lo descarga desde su publicación original (URL y SHA-256 fijos en `models/registry.py`) y se carga como archivo de datos
en tiempo de ejecución. STARBLITZ declara MIT (`LICENSE`, decisión D2 pendiente del titular).

**Implicaciones (no es asesoramiento legal):**
- Distribuir la app **sin** los pesos y que el usuario los descargue es la forma más limpia de aislarlo; si alguien distribuye
  STARBLITZ **junto con** esos pesos, esa distribución debe cumplir la GPL-3.0 para ese componente.
- Si se considerase que el post-procesado de `vision/detector.py` y `vision/detector.ts` **deriva** del código GPL del proyecto
  original, ese código también estaría afectado. El archivo se declara «implementación propia»; **NO VERIFICADO** (no hay
  historial anterior a 2026-11-07 que permita comprobar su origen).
- Con el repositorio **público**, cualquiera ve la dependencia: conviene que la licencia del proyecto (D2) quede decidida.

**Opciones, de menor a mayor esfuerzo:**
| Opción | Qué resuelve | Estado |
|---|---|---|
| Mantener la descarga aparte (hoy) | No redistribuye GPL | ✅ ya es así |
| PP-OCRv6 Manga (Apache-2.0 declarada) + agrupación/máscara propias | Sustituye la detección de **líneas** | 🧪 integrado como experimental (este documento) |
| `ogkalu/comic-text-and-bubble-detector` (RT-DETR v2, **Apache-2.0 declarada**, ONNX, ~102 000 descargas) | Aportaría **globos y bloques de texto**, lo que PP-OCRv6 no da | **NO EVALUADO**: siguiente candidato |
| `PaddlePaddle/PP-OCRv5_*_det` (Apache-2.0) | Detección de líneas genérica (no entrenada en cómic) | no evaluado |
| `kitsumed/yolov8m_seg-speech-bubble` | Globos | **descartado**: GPL-3.0 |
| `huyvux3005/manga109-segmentation-bubble` | Globos | **descartado**: CC-BY-NC-4.0 (no comercial) |
| `mayocream/comic-text-detector-onnx` | — | **no fiable**: declara Apache-2.0 pero parece una reexportación de los pesos GPL |

Regla del titular: **no se elimina** `comic-text-detector` hasta que exista una alternativa integrada **y validada**.

## 6. Cuantización

FP16 (0,96 MB) no se ha medido: en CPU, ONNX Runtime suele convertir a FP32 internamente y no gana velocidad; la ganancia sería de
tamaño (0,9 MB menos), irrelevante frente a 95 MB del detector actual. El modelo FP32 ya es 52× más pequeño. INT8 no está publicado.
