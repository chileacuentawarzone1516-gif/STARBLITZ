# Limitaciones conocidas

Lista honesta de lo que **no está verificado** y de lo que STARBLITZ **no hace todavía**.

## 1. No verificado en esta entrega

La sesión de desarrollo se hizo en un contenedor Linux sin GPU, sin Android SDK y sin acceso a Hugging Face, Google
Maven, `dl.google.com` ni Gradle (tampoco desde el entorno Linux del PC conectado). Por eso:

| Qué | Estado | Cómo se verifica |
|---|---|---|
| **APK compilado, instalado y abierto** (permisos, importación, procesamiento y exportación en Android) | **No hecho.** El proyecto Android está completo y sincronizado (`cap sync` correcto, 20 métodos del plugin JS↔Java coinciden, pruebas JVM de la parte nativa pasan), pero nunca se compiló con Gradle ni se instaló | `scripts\Compilar-APK-Android.bat` en tu PC; luego instalar (`-Install`) y recorrer [INSTALACION](INSTALACION.md#android) |
| **llama.cpp arm64 ejecutándose en el teléfono** (arranque como proceso hijo, `libllama-server-exe.so`, restricciones de SELinux/`exec` en distintas versiones de Android) | No verificado. La lógica de arranque, parada, tiempos y errores se probó con un `llama-server` simulado (JVM y vitest) | Traducir una página en un teléfono arm64 real; revisar `llamaLog` en Ajustes |
| **WebView con aislamiento COOP/COEP** (hilos de WebAssembly) | El mismo mecanismo se verificó en Chromium (E2E con página aislada, 2 hilos), pero no en el WebView de Android. Si no se activa, la visión usa 1 hilo (más lenta, igual de correcta) | Mirar el tiempo por página en el teléfono |
| **Modelos de lenguaje reales** (calidad de traducción, tiempos, memoria; Qwen 3.5 / Gemma 4) | Medido **en PC** con un capítulo real (inglés; [comparación](MODELOS-INVESTIGACION.md), revisión no humana). Sin medir en el teléfono ni evaluado por hablantes nativos. Flujo, esquemas JSON, corrección, marcas, perfiles y diccionario se probaron con modelos simulados y con paridad Python ↔ TypeScript de los mensajes exactos | «Comparar modelos» con tu material; revisar con ojo humano |
| **Búsqueda y descarga reales en Hugging Face** | Probado contra un servidor simulado (consulta de árbol y `lfs.oid`, reanudación, SHA-256). Los repositorios y tamaños del catálogo no se han vuelto a comprobar contra el sitio real | Abrir Modelos → Explorar y descargar uno |
| **Manga OCR y LaMa con pesos reales en el móvil** | Probados con modelos sintéticos de la misma estructura (escritorio) y en la ruta de código; los pesos reales no se descargaron | Descargar desde Modelos → Visión y procesar páginas japonesas |
| **STARBLITZ Desktop en Windows con GPU** (arranque del `.exe`, Vulkan/DirectML, tiempos por página) | No se vio en pantalla ni se midió en la RTX 4060. El motor sí se ejecutó en Linux/CPU | Abrir `STARBLITZ.exe`, descargar lo necesario y procesar un capítulo |
| **Hardware físico** (batería, temperatura, RAM real, almacenamiento) | La lógica de `DeviceStatusGuard` se probó con lecturas simuladas; los sensores reales de Android no se leyeron | Procesar un capítulo largo en el teléfono y vigilar pausas |

## 2. Funcionales

- **Onomatopeyas (SFX)**: se detectan y pueden traducirse como nota, pero por defecto no se borran del dibujo.
- **Texto sobre dibujo o tramas sin LaMa**: sin ese modelo, el relleno puede dejar manchas; en globos lisos no hace falta.
- **Globos abiertos o fundidos con la viñeta**: si el contorno no está cerrado, el texto se rotula dentro del área del
  texto original, no del globo. Texto que desborda su globo en el original puede dejar restos del trazo al borrar
  (la reconstrucción no toca nada fuera de la máscara de texto ni borra contornos largos).
- **Rotulación**: no curva el texto ni lo adapta a formas en espiral; la rotación es manual.
- **Tiras webtoon muy largas**: el detector las analiza por tramos y el modelo ve la tira reducida. Los lienzos del
  WebView tienen un tope de memoria (≈16 MP en muchos teléfonos): conviene cortarlas en páginas.
- **Historial de correcciones**: hay deshacer/rehacer por sesión de edición, pero no un historial persistente por texto
  (versiones anteriores de una traducción) ni «corrección inteligente» que aprenda de tus ediciones más allá del glosario
  y el diccionario personal.
- **Idiomas de origen**: con páginas reales solo se probó el japonés. Chino, coreano, inglés y lenguas latinas usan
  PP-OCR; están integrados pero no evaluados con páginas reales.
- **Variantes del español**: latinoamericano neutro y de España; otras (rioplatense, mexicano marcado) se piden en las notas.
- **Calidad con modelos pequeños**: un modelo de 2–4 B marca más líneas para revisión y falla más con argot y juegos de
  palabras; no hay reemplazo para la revisión humana.

## 3. Plataforma, rendimiento y seguridad

- **Android sin servicio en primer plano**: procesar con la app abierta y la pantalla encendida (la app la mantiene
  despierta). Si Android cierra la app en segundo plano, el trabajo queda «interrumpido» y se reanuda desde la última
  página terminada; no continúa solo en segundo plano.
- **Aceleración por hardware en móvil**: solo CPU (variantes NEON/dotprod/i8mm de ggml elegidas automáticamente). Sin GPU
  (Vulkan/OpenCL) en el APK; la visión usa WebAssembly con hilos, sin NNAPI.
- **Solo arm64-v8a, Android 9+**: en x86/x86_64 la app abre pero no puede traducir. Android 9 no puede guardar en
  «Descargas» (usa Compartir).
- **Aviso de cierre del `llama-server`**: Android puede matar el proceso hijo por memoria; la app lo detecta y lo relanza
  en la siguiente petición, pero esa página puede fallar y reintentarse.
- **Token de Hugging Face**: se guarda sin cifrar en el almacenamiento privado de la app (accesible solo con root o copia
  de seguridad del dispositivo; `allowBackup` está desactivado).
- **Windows**: solo 64 bits (10 21H2 o posterior); ejecutable sin firma digital (SmartScreen avisará). Instalado ocupa
  ≈0,7 GB; los modelos, aparte (0,8 GB de visión + 1,3–15 GB de lenguaje).
- **Escritorio y servidor de lenguaje externo**: si configuras Ollama/LM Studio/OpenAI-compatible, las páginas se envían a
  ese servidor; si es remoto, tus textos salen del equipo. El modo por defecto es local.
- **Licencia del detector**: GPL‑3.0 (ver [LICENCIAS-TERCEROS](LICENCIAS-TERCEROS.md)).
