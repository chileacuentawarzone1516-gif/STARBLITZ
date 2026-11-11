# Modelos, Hugging Face y calidad de traducción

## Principios

- **La traducción siempre es local.** Hugging Face es solo catálogo y origen de descarga; la API de inferencia de pago
  nunca se usa.
- **Nada se descarga solo.** La app recomienda según el dispositivo y pide confirmación; antes de descargar comprueba el
  espacio libre y, en el móvil, si el modelo cabe en la RAM (veredicto «cabe / justo / no cabe» y velocidad estimada).
- **Lo que se instala es lo que se mostró.** Se consulta el repositorio para fijar el *commit*, el tamaño y la huella
  SHA-256 (`lfs.oid`) de cada archivo, y se descarga desde `resolve/<commit>/<archivo>`. La descarga se **reanuda** si se
  corta y se **verifica** al terminar; un archivo corrupto se descarta.

## Gestor de modelos (escritorio y móvil)

| Función | Qué hace |
|---|---|
| Explorar | Catálogo curado + búsqueda libre en Hugging Face (solo repositorios con GGUF), con tamaño por archivo, cuantización, parámetros, arquitectura, contexto, idiomas y **licencia clasificada** (permisiva / con restricciones / desconocida) |
| Compatibilidad | Para cada archivo: memoria estimada (pesos + caché KV según la arquitectura + proyector de imágenes), velocidad esperada y nota; recomendados Q4/Q5 |
| Instalados | Activar, desinstalar (libera espacio), ver tamaño y licencia; el modelo activo es el que usa la traducción |
| Visión | Detector de texto, Manga OCR y LaMa: estado, tamaño, instalar/quitar |
| Comparar | Traduce un fragmento de prueba con varios modelos instalados y los muestra lado a lado, con tiempos |
| Token de Hugging Face | Opcional, para modelos con acceso restringido (se guarda en el almacenamiento privado de la app, sin cifrar) |

## Catálogo recomendado (GGUF)

Todos son de pesos abiertos con licencia Apache-2.0. Los tamaños son los de referencia del catálogo
(`engine/starblitz_engine/llm/catalog.py`, noviembre 2026); **la app los vuelve a consultar en el repositorio antes de
instalar**. Esta sesión no tuvo acceso a Hugging Face, así que los nombres de repositorio y tamaños no se han vuelto a
comprobar aquí.

| Modelo | Cuantización | Archivo | Perfil recomendado |
|---|---|---|---|
| Qwen 3.5 2B | Q4_K_M | 1,28 GB | Gama baja (móvil ≤ 5 GB RAM) |
| Qwen 3.5 4B | Q4_K_M / Q5_K_M | 2,74 / 3,14 GB | Gama media (móvil 6–8 GB RAM) |
| Gemma 4 E2B / E4B | QAT 4 bits | 3,35 / 5,15 GB | Alternativas para comparar. **E4B: la mejor medida en PC con GPU** (2026-11-10, sin evaluación humana; [comparación](MODELOS-INVESTIGACION.md)) |
| Qwen 3.5 9B | Q4_K_M | 5,68 GB | Gama alta (móvil ≥ 10 GB) y PC con GPU 6–8 GB |
| Gemma 4 12B | QAT 4 bits | 6,98 GB | PC con ≥ 10 GB de VRAM (en 8 GB ocupa la GPU entera y Windows llegó a desalojarlo: medido) |
| Gemma 4 26B‑A4B (MoE) | QAT 4 bits | 14,44 GB | PC con ~16 GB de VRAM o 32 GB de RAM |

El proyector de imágenes (`mmproj`, 0,2–1,2 GB) solo se descarga y se carga si el perfil usa visión en el modelo de
lenguaje (PC con GPU).

## Perfiles de dispositivo

| Perfil | Cuándo | Contexto | Visión en el LLM | Calidad | OCR japonés | Reconstrucción |
|---|---|---|---|---|---|---|
| Gama baja | Móvil ≤ 5 GB RAM, PC sin GPU y poca RAM | 4 096 | No | Equilibrada (1 pasada) | PP-OCR | Relleno |
| Gama media | Móvil 6–8 GB, portátil sin GPU | 6 144 | No | Equilibrada | Manga OCR | Relleno |
| Gama alta | Móvil ≥ 10 GB, PC con mucha RAM | 8 192 | No | Máxima (2 pasadas) | Manga OCR | Relleno |
| PC con GPU | GPU dedicada ≥ 6 GB | 12 288 | Sí | Máxima | Manga OCR | LaMa |

El perfil se detecta midiendo el dispositivo y puede forzarse en Ajustes.

## Modelos de visión

| Modelo | Uso | Tamaño | Origen (SHA-256 verificado) | Licencia |
|---|---|---|---|---|
| comic-text-detector (ONNX) | Bloques, líneas y máscara de texto | 95 MB | GitHub (manga-image-translator, beta‑0.3) | **GPL‑3.0** (pesos) |
| Manga OCR (ONNX) | OCR japonés de manga (opcional) | 460 MB | Hugging Face `onnx-community/manga-ocr-base-ONNX` | Apache‑2.0 |
| LaMa (ONNX fp32, 512 px) | Reconstrucción sobre dibujo y tramas (opcional) | 208 MB | Hugging Face `Carve/LaMa-ONNX` | Apache‑2.0 |
| PP-OCRv6 small | OCR multilingüe, **incluido en la app** | 21 MB | Paquete `rapidocr` 3.10.0 (huella fijada) | Apache‑2.0 |
| PP-OCRv5 coreano | OCR coreano (solo escritorio, descarga automática al primer uso) | ~15 MB | ModelScope vía RapidOCR | Apache‑2.0 |

El detector no se incluye en el instalador ni en el APK (licencia GPL‑3.0): lo descarga el usuario desde su
publicación original. Sin Manga OCR se usa PP-OCR; sin LaMa, el relleno de papel (más Telea de OpenCV) deja manchas
visibles sobre dibujo complejo, no en globos lisos.

## Idiomas

Origen: japonés, inglés, coreano, chino simplificado y tradicional, francés, italiano, portugués y alemán, o
detección automática. Destino: español latinoamericano neutro o español de España. Con páginas reales solo se ha
probado el japonés (ver [LIMITACIONES](LIMITACIONES.md)).

## Cómo se cuida la calidad de traducción

1. **Contexto**: ficha de la obra, personajes (género y forma de hablar), glosario obligatorio, resumen acumulado,
   página anterior traducida y siguiente en original; opcionalmente la imagen de la escena con globos numerados.
2. **Perfil de traducción** (por proyecto o por defecto): *Natural* (por defecto), *Fiel* (lo más cercano al original),
   *Coloquial*, *Formal* y *Adaptación narrativa*; se inyecta en el prompt del traductor y del corrector.
3. **Diccionario personal** global (≤ 500 términos, siempre bloqueados) + glosario del proyecto (gana en conflicto).
   Los términos del diccionario no se vuelven a proponer como «términos nuevos».
4. **Instrucciones**: no añadir, no omitir, no inventar; adaptar modismos y bromas; salida JSON por línea con
   confianza, hablante, emoción, marcas y nota (con reparación automática si el JSON llega mal).
5. **Corrector** (segunda pasada, «Calidad máxima»): compara original y traducción; se conserva la confianza más prudente.
6. **Control de calidad**: líneas con confianza < umbral (72 % por defecto), ambiguas, con juego de palabras, con posible
   error de OCR o demasiado largas para el globo quedan **marcadas para revisión** con una nota; una respuesta del modelo
   que parezca una negativa («no puedo ayudar…») se trata como fallo y se marca.
7. **Memoria fijada por el usuario** (personajes y glosario con candado) que la IA no puede cambiar; textos aprobados o
   editados a mano nunca se retraducen.

No hay medición automática de calidad con modelos reales en esta sesión: la calidad de cada modelo debe valorarse con
«Comparar» sobre tu propio material.

## Alternativas evaluadas y descartadas

- **Argos / Bergamot / OPUS‑MT / NLLB**: traducen frase a frase, sin contexto ni glosario y (ja→es) pasando por el inglés.
- **TranslateGemma**: buenas métricas por frase, pero ~2 K tokens de ventana y formato rígido (sin glosario ni JSON).
- **Tesseract**: precisión muy baja con texto vertical japonés y tipografías de cómic.
- **PyTorch + CUDA**: +3 GB y dependencia de una versión de CUDA; ONNX Runtime con DirectML sirve en cualquier GPU de Windows.
