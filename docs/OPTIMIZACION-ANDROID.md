# Optimización del pipeline en Android: auditoría, cuellos de botella y plan

Documento de trabajo del 2026-11-08. **Todo lo medido aquí es de un PC** (Intel i7-13620H, Microsoft Edge/Chromium, WebAssembly, los mismos modelos y el mismo
código que usa la app), **no del Redmi Note 8 Pro**: los tiempos absolutos del teléfono serán otros; lo que se puede trasladar son las **proporciones**
y los **recuentos**. Estados: **CONFIRMADO** (medido o comprobado en el código) · **IMPLEMENTADO** (código + pruebas automáticas, sin medir en el teléfono) ·
**DISEÑO** · **NO VERIFICADO**. Datos crudos: `tools/bench/results/2026-11-08-vision-pc-edge/`.

## 1. Lo que muestra tu captura

27 páginas, ~33 min estimados; en la página 5, tras 3 min 58 s, la app seguía en «Análisis y OCR / detectando diálogos» (≈ 48 s por página). Eso **no es Qwen**: es la
visión. La auditoría lo confirma con medidas.

## 2. Cuello de botella confirmado: el detector de texto

Análisis completo de una página (decodificar → detector → viñetas → OCR → codificar máscara) en un Web Worker, con WebAssembly, como en el APK. Páginas
**sintéticas** (texto japonés sobre viñetas simples; un manga real tiene más trazos), detector real `comictextdetector` (95 MB) y OCR PP-OCR real:

| Configuración (medias de 2 pasadas en caliente) | Detector (inferencia) | OCR PP-OCR | **Total / página** |
|---|---:|---:|---:|
| 900×1300, **1 hilo** WASM | 10,0 s (**86 %**) | 1,5 s | **11,6 s** |
| 1620×2340 (escaneo típico), 1 hilo | 10,0 s (84 %) | 1,6 s | 11,9 s |
| Tira vertical 900×3900 (5 tramos), 1 hilo | 49,6 s (**92 %**) | 3,6 s | **53,6 s** |
| 900×1300, **4 hilos** WASM | 3,0 s (**78 %**) | 0,7 s | **3,9 s** |
| 1620×2340, 4 hilos | 3,2 s (74 %) | 0,8 s | 4,3 s |
| Tira vertical 900×3900 (5 tramos), 4 hilos | 15,1 s (**87 %**) | 1,8 s | **17,3 s** |

(Decodificar + viñetas + codificar la máscara suman < 0,15 s en todos los casos.)

**CONFIRMADO (PC):**
1. **El detector es el 74–92 % del análisis** (84–86 % en una página normal con 1 hilo). El OCR es ~13–18 %; el resto, menos del 1–2 %.
2. **El tamaño de la página NO importa**: la red tiene entrada fija de 1024×1024, así que 900×1300 y 1620×2340 cuestan lo mismo. Reducir la resolución de las
   imágenes no acelera nada; no hay ganancia fácil por ahí (y empeoraría el texto pequeño).
3. **Los hilos de WebAssembly importan**: de 1 a 4 hilos, ~3× más rápido en página normal (11,6 → 3,9 s) y 3,1× en tira (53,6 → 17,3 s). La app los pide (hasta 4, con cabeceras COOP/COEP en el `WebView`); **si el `WebView`
   del Redmi no queda «aislado» (`crossOriginIsolated`) irá con 1 hilo** y será ~3× más lento. El informe exportable registra `runtime.cross_origin_isolated`:
   es el dato que hay que mirar primero en el teléfono.
4. **Las tiras verticales (webtoon/manhwa) cuestan ~4,5×** por página porque se parten en tramos de 1024 px y cada tramo es una pasada completa (5 tramos en 900×3900).
5. Estimación **no verificada** para el Redmi: si su relación con este PC fuera de 5–10×, una página con 4 hilos serían ~20–40 s (con 1 hilo, 60–120 s), lo que
   es **coherente** con tus ~48 s por página; **no es una medición**.

Instrumentación añadida (solo medida, sin cambiar resultados): cada página guarda ahora `decode / detector / viñetas / OCR / codificar` y el nº de tramos
(`last_job.timings.pages[].vision`), y el informe exportable las suma en `summary.vision_s`. **Con eso el primer capítulo en el Redmi dirá exactamente dónde se va el tiempo.**

## 3. Alternativas evaluadas para la detección

| Alternativa | Medida (PC, mismo runtime WASM, 1 hilo) | Veredicto |
|---|---|---|
| Detector actual `comictextdetector` FP32 (1024²) | **10,1 s** | línea base; GPL-3.0 (ver LICENCIAS-TERCEROS) |
| Mismo modelo, **INT8 dinámico** (53 MB) | 3,0 s frente a 3,6 s con 4 hilos (**−16 %**) | **No compensa** y no se validó la precisión: descartado |
| **PP-OCRv6 Manga `manga_det`** (1,8 MB FP32, Apache-2.0 declarada) a 960² | **0,54 s** (960×1280: 0,73 s) | **≈ 14–19× más rápido en inferencia** → la mayor palanca encontrada |
| Reducir `INPUT_SIZE` (640/768) | no medido | **No se hace**: pondría en riesgo el texto pequeño (regla innegociable) |
| Aceleración por GPU/NNAPI desde WebView | no medido | ONNX Runtime Web no ofrece NNAPI; WebGPU/WebGL en el `WebView` de un Helio G90T (Mali-G76) **no verificado** y consume más energía/temperatura. Pendiente de una prueba específica |

**Por qué no sustituyo ya el detector por `manga_det`:** es un detector de **líneas** de texto, no de globos. Sustituirlo exige (1) agrupar líneas en bloques/globos y
fijar el orden de lectura (hoy lo hace el detector actual), (2) generar la máscara de borrado a partir de los polígonos de línea (hoy sale de la segmentación del
detector actual), (3) **comparar precisión sobre páginas reales** de manga, manhwa y cómic (texto pequeño, SFX, globos con fondo complejo) y (4) revisar las condiciones de
**Manga109-s** con que se entrenó. No puedo hacer (3) sin páginas reales (las tuyas son privadas y no están en el repositorio). Regla del encargo: no sustituir sin comparar
precisión, velocidad, memoria y licencia, y **no sacrificar detecciones difíciles**. Plan propuesto en §7.

## 4. Resto del pipeline (qué está medido y qué no)

| Etapa | Estado |
|---|---|
| Importación / decodificación de imagen | CONFIRMADO: < 0,1 s en PC (despreciable frente al detector) |
| Detección | CONFIRMADO: ver §2 (cuello de botella) |
| Agrupación de globos y orden de lectura | CONFIRMADO: < 0,1 s en PC |
| OCR | CONFIRMADO: 13–18 % con PP-OCR (japonés). **Manga OCR (~440 MB, autorregresivo) NO medido**: puede pesar bastante más; en un Redmi es opcional |
| Traducción | CONFIRMADO en tokens (formato JSON ≈ 6× más trabajo que texto plano con el mismo modelo): ver [ARQUITECTURA-TRADUCCION](ARQUITECTURA-TRADUCCION.md). Tiempo en el teléfono: NO medido |
| Reconstrucción (`clean`) | **NO medida por separado** (modo «fast» = relleno; LaMa opcional). El informe ya la mide por página (`clean_s`) |
| Exportación y almacenamiento | NO medido |
| Redundancia detectada | Con idioma «Automático», `detectLanguage` ejecuta el detector sobre las primeras páginas (hasta 10 bloques) **y esas páginas se vuelven a detectar al analizarlas**: ~1–2 detecciones de más por proyecto. **Mitigación inmediata para ti:** elige el idioma de origen (Japonés/Coreano) al crear el proyecto. Arreglo de ingeniería (cachear la detección por hash de página) DISEÑADO, no hecho |

## 5. Control térmico — IMPLEMENTADO (sin calibrar, sin medir en el teléfono)

`device/pacer.ts` (`ThermalPacer`). Reparte el trabajo en ráfagas con descansos según lo que el dispositivo **expone de verdad**:

1. **Estado térmico de Android** (API 29+; `NONE/LIGHT/MODERATE/SEVERE/CRITICAL…`): es la predicción del propio sistema de que va a recortar rendimiento.
2. **Margen térmico** (`getThermalHeadroom`, API 30+; 1,0 = umbral de limitación severa): rampa de 0,5 a 1,0. Añadido al plugin nativo (`thermal_headroom`, −1 si no se informa).
3. **Sin API térmica (Android 9):** **solo** la temperatura de la batería (único sensor accesible), con una rampa de respaldo. **No se inventa ninguna temperatura de CPU.**

Política: fracción de descanso `idle` con suavizado asimétrico (sube deprisa cuando crece la presión, baja despacio al relajarse), tope del 75 %; tras cada página descansa
`trabajo · idle/(1−idle)`; en estado **CRITICAL** o peor pausa y se reanuda sola cuando el sistema vuelve a ≤ LIGHT (con tope de 10 min y cancelable). Con el teléfono frío **no añade
ninguna espera** (verificado por prueba). Registra para el informe: fuente de la señal, muestras con estado ≥ MODERATE (**frecuencia de throttling**), estado y margen máximos, temperatura de
batería máxima, segundos de descanso, pausas y descanso final (`summary.thermal`).

**Honestidad sobre los parámetros:** la *forma* del control sigue las recomendaciones de Android (reaccionar a la señal del SO); los **valores** (tope 75 %, rapideces 0,6/0,15, rampa 0,5→1,0,
rampa de batería 38→45 °C, pausa en CRITICAL) son **hipótesis NO calibradas**. Se calibran con [VALIDACION-TERMICA-ANDROID](VALIDACION-TERMICA-ANDROID.md). La guarda existente
(`DeviceStatusGuard`: 42/46 °C de batería, estado ≥ 3/4) se mantiene como **red de seguridad** y sus umbrales también están **sin calibrar**. **No se afirma que evite el throttling** hasta medirlo.

Pruebas: 13 nuevas (lógica con señales simuladas + integración con el procesador); suite móvil 239/239.

## 6. Planificador adaptativo — estado

| Decisión | Estado |
|---|---|
| Páginas en paralelo | **Serie por defecto**; solapar visión y modelo solo con RAM ≥ 10,5 GB y memoria libre (gobernador de la Fase 4, IMPLEMENTADO). En un Redmi de 6 GB **nunca** se solapa |
| Hilos: «más hilos ≠ más velocidad» | CONFIRMADO en PC que 1→4 hilos ayuda ~3× en el detector; en un teléfono con núcleos rápidos y lentos puede ayudar menos. **Calibrar por dispositivo** (2 vs 4 hilos) con el informe; hoy `min(4, núcleos−2)` |
| Cuándo cargar/soltar modelos | IMPLEMENTADO (Fase 4: carga del modelo tras el primer análisis en serie; `trim` con poca memoria) |
| Cuándo reutilizar cachés | IMPLEMENTADO (OCR y traducción; «forzar» las salta) |
| Reducir carga con la temperatura | IMPLEMENTADO (§5) |
| Pausar y continuar sin perder progreso | IMPLEMENTADO (pausa térmica + cola persistente + estado por página, Fases 3–4) |
| CPU vs aceleración | NO verificado (ver §3 GPU/NNAPI) |

## 7. Plan priorizado (con lo que falta decidir o medir)

1. **Medir en el Redmi** (protocolo en VALIDACION-FASE4 y VALIDACION-TERMICA): `cross_origin_isolated`, `summary.vision_s`, térmica. Define todo lo demás.
2. **Detector ligero** (`manga_det`, Apache-2.0): prototipo detrás de un interruptor «experimental», comparar contra el detector actual sobre **tus páginas reales** (recall de globos y de
   texto pequeño, máscara para borrar, tiempo, RAM). Solo si iguala o mejora el recall se plantea como predeterminado. **Requiere tu decisión y tus páginas.**
3. **Cachear la detección** entre `detectLanguage` y el análisis (hash de página) — ahorra 1–2 detecciones por proyecto con idioma automático.
4. **Calibrar el control térmico** con 2–3 capítulos completos (sostenido, sin pausas innecesarias).
5. **Servicio en primer plano** — DISEÑO ampliado en [DISENO-FASES-5-7](DISENO-FASES-5-7.md); **NO implementado** en este trabajo: sigue sin poder afirmarse que el `WebView` ejecute JavaScript con la
   pantalla apagada. Hasta probarlo: mantener la app en primer plano y la pantalla encendida.
6. Traducción: medir Qwen-4B frente a Hy-MT2-1.8B en el teléfono (el modelo predeterminado **no cambia** sin benchmarks reales y tu autorización; PLaMo **no autorizado**).
