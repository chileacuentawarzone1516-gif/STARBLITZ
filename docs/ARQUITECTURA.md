# Arquitectura

STARBLITZ tiene **dos motores independientes** que comparten formato de proyecto, perfiles de traducción, catálogo de
modelos, maquetación y exportación (`apps/shared`). Ninguno depende del otro: el móvil **no necesita el PC**.

```
┌────────────────────────── STARBLITZ Desktop (Windows) ───────────────────────────┐
│ Electron ─ interfaz React ──HTTP/SSE con token──► Motor Python (127.0.0.1)        │
│                                                  ├─ importación ZIP/CBZ·PDF·imágenes
│                                                  ├─ visión: detector · globos · viñetas · orden
│                                                  ├─ OCR: Manga OCR (ja) · PP-OCR (resto)
│                                                  ├─ traducción: llama-server (llama.cpp + Vulkan) o Ollama/OpenAI-compatible
│                                                  ├─ reconstrucción: relleno de papel · LaMa
│                                                  └─ proyectos JSON + imágenes en %APPDATA%\STARBLITZ
└───────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────── STARBLITZ Mobile (Android arm64) ─────────────────────┐
│ WebView (Capacitor) ─ interfaz táctil React                                       │
│   └─ LocalEngine (TypeScript, api/localEngine.ts)  ← misma API que el motor Python│
│        ├─ JobManager + Processor: trabajo de proyecto, pausa/reanudación, recuperación
│        ├─ DeviceStatusGuard: batería, temperatura, RAM, almacenamiento            │
│        ├─ Visión en Web Worker: OpenCV.js + ONNX Runtime Web (WASM con hilos)     │
│        │     detector de texto · PP-OCR (incluido) · Manga OCR / LaMa (opcionales)│
│        ├─ Traducción: NativeLlmRuntime → llama-server (llama.cpp arm64, proceso   │
│        │     hijo de la app, solo 127.0.0.1) con modelos GGUF Q4/Q5               │
│        ├─ Biblioteca de modelos: Hugging Face (catálogo) + descarga nativa        │
│        │     reanudable con SHA-256                                               │
│        └─ Almacenamiento: IndexedDB (proyectos) + carpeta privada (modelos, imágenes)
│ Plugin nativo Java (StarblitzNative): archivos, descargas, llama-server,          │
│   estado del dispositivo, MediaStore, mantener pantalla encendida                 │
└───────────────────────────────────────────────────────────────────────────────────┘
```

## Decisiones técnicas

| Decisión | Elegido | Alternativas evaluadas | Motivo |
|---|---|---|---|
| Shell de escritorio | **Electron** | Tauri | Tauri exige Rust + MSVC en Windows y la compilación cruzada no es fiable. Electron se empaqueta desde Linux/CI; el peso real lo marca el motor de IA. |
| Móvil | **Capacitor** + motor TypeScript propio + plugin nativo Java | Kotlin/Compose, PWA, motor Python en Android | Un APK instalable con acceso nativo (archivos, procesos, descargas). Reutiliza `apps/shared` y la lógica del motor (con **paridad verificada** por pruebas contra Python). Un APK con Python embebido pesaría cientos de MB y mantendría dos pilas nativas. |
| Procesamiento en móvil | **Todo en el teléfono** | Delegar al PC por Wi‑Fi (diseño anterior) | Requisito del producto: independencia del PC. Se retiró el emparejamiento por PIN/QR y todo su código. |
| Visión en móvil | **ONNX Runtime Web (WASM, hilos) + OpenCV.js** en un Web Worker | NNAPI/TFLite, ONNX Runtime Mobile nativo | Mismo modelo ONNX que el escritorio (paridad), sin compilar nativo; el Worker evita congelar la interfaz. Los hilos requieren `SharedArrayBuffer`: la app añade COOP/COEP al WebView (`IsolatedWebViewClient`). |
| Traducción en móvil | **llama.cpp** (`llama-server` arm64) como proceso hijo | Biblioteca JNI, MLC/ExecuTorch, ONNX GenAI | Es el runtime de referencia para GGUF (Q4/Q5), con visión (`mmproj`) y cientos de modelos en Hugging Face. Proceso aparte: si Android lo mata por memoria, la app sigue viva y lo relanza. Variantes de CPU ARMv8.0–v9.2 (NEON/dotprod/i8mm) elegidas automáticamente por ggml. |
| Traducción en escritorio | **llama-server (Vulkan)** empaquetado; Ollama/LM Studio opcionales | Solo Ollama | Sin instalar nada aparte y con GPU NVIDIA/AMD/Intel sin CUDA. |
| Inferencia de visión (PC) | **ONNX Runtime + DirectML** | PyTorch CUDA | DirectML usa cualquier GPU de Windows (≈3 GB menos que CUDA); si falla, vuelve a CPU. |
| Detección | **comic-text-detector** (ONNX) | DBNet genérico, YOLO de globos | Entrenado con manga y cómic: bloques, líneas verticales/horizontales y máscara de texto. Post-procesado propio (NMS, DBNet, agrupado). |
| OCR japonés | **Manga OCR** (ONNX), respaldo PP-OCR | Tesseract | Referencia para manga: columnas verticales, furigana. Si falta o falla, PP-OCR japonés (incluido). |
| OCR resto | **PP-OCRv6** incluido (~21 MB) | Tesseract | Mucha más precisión que Tesseract en texto de cómic. |
| Traducción | **LLM local con contexto** | Argos, Bergamot, NLLB, TranslateGemma | Los traductores por frase no tienen contexto, glosario ni visión; el LLM permite memoria, voz de personajes, JSON validado y marcado de dudas. |
| Reconstrucción | **Relleno con muestras de papel** + **LaMa** en dibujo | Solo LaMa, solo OpenCV | La mayoría del texto está en globos lisos: copiar el grano real es exacto. LaMa se reserva para tramas y escenarios. |
| Rotulación | **Canvas TypeScript compartido** | Pillow en el motor | Lo que ves en el editor es lo que se exporta, en Windows y Android. |
| Prompts | **Una sola fuente** (`engine/.../translate/prompts.py`) exportada a JSON para TypeScript | Duplicar en ambos lados | Las pruebas comprueban que los mensajes exactos son idénticos en Python y TypeScript (`tools/export_translate_fixtures.py`). |

## Flujo de procesamiento (idéntico en ambos motores)

1. **Importación**: tipo por firma binaria (no por extensión), orden natural, PDF a resolución nativa, duplicados
   exactos (SHA‑1) y similares (dHash), límites de ZIP (entradas, tamaño, ratio de compresión) y de megapíxeles.
2. **Análisis** (por página): detección → viñetas → orden de lectura (manga: derecha→izquierda) → globo de cada texto →
   tipo (diálogo, narración, SFX…) → OCR → área de maquetación. Con idioma «auto» se detecta con una muestra de páginas.
3. **Traducción** (página a página): ficha de la obra + perfil + glosario del proyecto + diccionario personal +
   personajes + resumen + página anterior/siguiente; segunda pasada de corrección en «Calidad máxima»; marcas
   (`ambiguous`, `ocr_suspect`, `wordplay`, `too_long`…) y confianza; lo aprobado o editado nunca se sobrescribe.
4. **Reconstrucción**: máscara de texto ∩ entorno de las líneas ∩ interior del globo; relleno de papel o LaMa;
   nada fuera de la máscara se modifica.
5. **Rotulación y exportación**: ajuste automático del cuerpo de letra al polígono del globo; PDF, ZIP, JPG, PNG, WEBP.

### Trabajo gestionado, recuperación y control de recursos

- Un proyecto es **un trabajo** (`JobManager`) con etapas y estado por página (`pending/active/done/error`), persistido
  tras cada página: si la app se cierra o el sistema la mata, al volver se **reanuda desde la última página terminada**.
- Pausa/reanudación/cancelación en cualquier momento. Un error en una página no detiene las demás.
- **Móvil**: `DeviceStatusGuard` pausa por batería ≤ 10 % sin cargador, calor (enfría a ≥ 42 °C, pausa a ≥ 46 °C o estado
  térmico crítico) y menos de 200 MB libres; ante poca memoria descarga el modelo de lenguaje y el de visión.
  `WakeController` mantiene la pantalla encendida solo mientras se procesa.
- **Perfiles de dispositivo** (`low/mid/high/pc-gpu`, medidos o elegidos): fijan el contexto del modelo, uso de visión en
  el LLM, calidad de traducción, OCR (PP-OCR o Manga OCR) y reconstrucción (relleno o LaMa). Aligeramiento automático:
  Manga OCR → PP-OCR y LaMa → relleno si faltan o el perfil no los admite; un modelo que no cabe en memoria se rechaza
  con la indicación de elegir uno más ligero; si el modelo activo no está instalado se usa el instalado que mejor encaja.
- El servidor de modelos se detiene solo tras inactividad para devolver la memoria al sistema.

## Formato de proyecto

Escritorio: `projects/<id>/project.json` + `pages/<id>/{original.*, thumb.webp, mask.png, clean.png, page.json}` con
escritura atómica. Móvil: mismos documentos en IndexedDB y las imágenes en la carpeta privada de la app. Esquema en
`engine/starblitz_engine/projects/schema.py` y `apps/shared/src/types.ts` (idénticos). Los proyectos antiguos sin
`translation_profile` se cargan como «Natural».

## Seguridad

- **Escritorio**: el motor solo escucha en `127.0.0.1`; token de sesión aleatorio de 256 bits por arranque (comparación en
  tiempo constante); identificadores validados (sin *path traversal*); ZIP sin extraer a disco con límites; Electron con
  `contextIsolation`, `sandbox`, sin `nodeIntegration`, navegación restringida, permisos denegados y CSP estricta;
  errores controlados al usuario con trazas solo en `logs/`. La clave de un servidor LLM externo no se devuelve en claro.
- **Android**: `allowBackup=false`; permisos solo `INTERNET` y `ACCESS_NETWORK_STATE`; tráfico siempre HTTPS salvo
  `127.0.0.1/localhost` (el servidor de modelos de la propia app); rutas del plugin validadas (`SafePath`); descargas
  con tamaño y SHA-256 comprobados; exportación a «Descargas/STARBLITZ» con MediaStore sin permisos de almacenamiento.
- **Privacidad**: sin telemetría ni cuentas. Conexiones salientes solo para descargar modelos que el usuario pide
  (Hugging Face; el detector, desde su publicación en GitHub; en escritorio, el OCR coreano desde ModelScope vía RapidOCR)
  y, si el usuario lo configura, hacia su propio servidor de lenguaje. Los textos y las imágenes no salen del equipo.
- El token de Hugging Face (opcional, para modelos con acceso restringido) se guarda **sin cifrar** en el almacenamiento
  privado de la app (ver limitaciones).
