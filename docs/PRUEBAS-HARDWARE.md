# Pruebas que exigen hardware físico (pendientes de ejecutar en tus equipos)

El workflow `.github/workflows/validacion.yml` (se lanza **a mano**: *Actions → validacion → Run workflow*; no se ejecuta
en cada push) está diseñado para comprobar que los instaladores **se generan**, que el instalador de Windows (el mismo NSIS que se publica, generado por `windows.yml`) se instala,
arranca el motor y se desinstala en un Windows de un servidor de CI, y que el motor y la app móvil funcionan con detector,
OCR y modelos de lenguaje **reales** en CPU. **Hasta que se ejecute y se archive su `INFORME`, ninguna de esas
comprobaciones cuenta como realizada.** Y lo que **no puede** demostrar un servidor de integración continua es lo que
depende de un dispositivo concreto. Esta página lo separa, para que nada quede dado por bueno sin haberse probado.

| Evidencia | Qué demuestra | Qué NO demuestra |
|---|---|---|
| COMPILACIÓN | El APK / instalador se genera, está firmado y contiene lo esperado | Que funcione |
| PRUEBAS SIMULADAS | La lógica es correcta con piezas falsas (modelo de lenguaje, Hugging Face, plugin nativo) | Que funcione con las piezas reales |
| PRUEBAS REALES (CI) | Hugging Face, llama.cpp, OCR y traducción reales **en CPU x86-64 de Linux/Windows** | Rendimiento, GPU, arm64, teléfono |
| EMULADOR | El APK se instala y la actividad arranca en un Android virtual | Un teléfono real: batería, calor, RAM, arm64 nativo |
| HARDWARE FÍSICO | Todo lo de la lista de abajo | — |

## Dónde están los binarios y cómo comprobarlos

| Origen | Archivos | Comprobación de integridad |
|---|---|---|
| Release (borrador creado por `release.yml`) | `STARBLITZ-Setup-<versión>.exe`, `STARBLITZ-win-x64-portable.zip`, `STARBLITZ-<versión>-android-arm64.apk` | `SHA256SUMS.txt` de la Release |
| `windows.yml` / `build.yml` (manual) | Artefacto `STARBLITZ-Windows` (instalador, ZIP portátil y `STARBLITZ-Setup.sha256`) y, en `build.yml`, `STARBLITZ-Android` | `STARBLITZ-Setup.sha256`; para el resto calcula el SHA-256 y guárdalo en tu informe |
| `validacion.yml` (manual) | `STARBLITZ-Android-APK` (`STARBLITZ-android-arm64-CI.apk`, clave desechable) y los artefactos de `windows.yml` | `STARBLITZ-android-arm64-CI.apk.sha256` y `STARBLITZ-Setup.sha256` |

El instalador de Windows es **siempre el mismo binario** en las tres rutas: lo compila `windows.yml` una vez, lo prueba
`probar-instalador.ps1` y es el que adjunta la Release. Más detalle en [COMPILAR](COMPILAR.md#github-actions).

## Lista de pruebas

Marca cada una cuando la hagas y copia el resultado al informe. Estado inicial de **todas**: **PENDIENTE**.

### Teléfono Android arm64 (Android 9 o superior; ideal: uno de 6–8 GB y otro de 4 GB)

| # | Prueba | Cómo hacerla | Resultado esperado |
|---|---|---|---|
| A1 | Instalar el APK | Comprueba el SHA-256 (`certutil -hashfile <archivo>.apk SHA256`) contra `SHA256SUMS.txt` de la Release o, si el APK viene de `validacion.yml`, contra su `.sha256`; copia el APK al teléfono y ábrelo | Se instala; solo pide red (Internet y estado de red) y vibración (`VIBRATE`, permiso normal); ningún otro permiso (ni almacenamiento, cámara o ubicación) |
| A2 | Primer arranque y perfil del dispositivo | Abre **Modelos** | Detecta RAM, espacio y núcleos; propone un perfil y un modelo que cabe |
| A3 | Descarga de modelos (Wi‑Fi) | Detector (pestaña Visión) y un modelo de lenguaje. A mitad, apaga el Wi‑Fi y vuélvelo a encender | Reanuda sin empezar de cero; SHA-256 verificado; sin errores |
| A4 | **`llama-server` arm64 se ejecuta de verdad** | **Modelos → Probar la traducción** con una frase en japonés y otra en inglés. Con depuración USB: `adb logcat \| findstr /i "llama starblitz"` | Traducción al español en pantalla; velocidad (tokens/s) registrada; sin `Permission denied`, `SIGILL` ni `dlopen failed` |
| A5 | **Sin PC y sin Internet** | Con los modelos ya descargados, activa el **modo avión**, apaga el PC, importa 5 páginas y pulsa **Traducir proyecto** | Termina sin errores de red: todo se hace en el teléfono |
| A6 | Importar | ZIP, PDF y varias imágenes desde el selector de archivos del sistema (almacenamiento interno y tarjeta SD) | Todas las páginas aparecen en orden |
| A7 | Capítulo completo (≥ 20 páginas, tinta japonesa y vertical) | Procesa de principio a fin; anota tiempo total, temperatura y batería gastada | Termina; la app pausa sola con batería ≤ 10 %, calor o poco espacio y se puede reanudar |
| A8 | El sistema cierra la app | A mitad de proceso, cierra la app desde recientes y vuelve a abrirla | Detecta el trabajo interrumpido y lo reanuda sin repetir páginas hechas |
| A9 | Memoria | Prueba un modelo de 2 B en 4 GB, 4 B en 6 GB y 9 B en ≥ 10 GB | No se cierra por falta de memoria; si no cabe, lo avisa antes de cargarlo |
| A10 | Exportar | PDF, ZIP, JPG, PNG y WEBP | Android 10+: `Descargas/STARBLITZ`; Android 9: hoja de compartir. Los archivos abren bien |
| A11 | Editor táctil y accesibilidad | Mover/redimensionar globos con el dedo; rotar el teléfono; TalkBack; modo oscuro; texto grande | Sin textos cortados ni controles inalcanzables |
| A12 | Datos privados | Con un monitor de red (p. ej. «Ajustes → Uso de datos») comprueba que, tras descargar los modelos, la app no genera tráfico | 0 bytes durante el proceso de traducción |

### PC con Windows 11 (HP OMEN 16, RTX 4060)

| # | Prueba | Cómo hacerla | Resultado esperado |
|---|---|---|---|
| W1 | Instalador en tu equipo | Comprueba su SHA-256 (`Get-FileHash`) y ejecuta `STARBLITZ-Setup-*.exe` (por usuario, sin administrador) | SmartScreen avisa porque el ejecutable no está firmado («Más información → Ejecutar de todas formas»); se instala y aparece en Inicio |
| W2 | **GPU con Vulkan** | **Modelos → Probar la traducción** con un modelo de 4 B o 9 B | Usa la RTX 4060 (comprueba en el Administrador de tareas → GPU); tokens/s mucho mayor que en CPU |
| W3 | Visión con DirectML | Procesa un capítulo y observa la GPU | Manga OCR y LaMa en GPU; sin errores de DirectML |
| W4 | Pruebas reales completas en tu equipo | Doble clic en `scripts\Probar-Real-Windows.bat` (usa el Python incluido) | `informe.md` con todo en PASS; guarda el informe |
| W5 | Tu propio capítulo | Desde una consola: `scripts\Probar-Real-Windows.bat --proyecto --proyecto-origen "C:\mangas\capitulo1.zip" --idioma ja` (se procesa en tu equipo y no sale de él); o arrástralo a la app | Texto detectado, traducido, fondo reconstruido y exportado; revísalo con tus ojos |
| W6 | Aspecto | Escala de pantalla 100/125/150 %, modo claro/oscuro, teclado | Sin cortes; foco visible |
| W7 | Desinstalar | **Configuración → Aplicaciones** | Se retira; `%APPDATA%\STARBLITZ` (modelos y proyectos) se conserva |

### Calidad de traducción (no se puede automatizar)

| # | Prueba | Cómo hacerla | Resultado esperado |
|---|---|---|---|
| Q1 | Japonés → español | Una persona que lea japonés revisa 20–30 globos de un capítulo real | Sentido correcto, tono y tratamiento coherentes; anota los errores |
| Q2 | Inglés → español | Igual con un cómic en inglés | Idem |
| Q3 | Comparar modelos | **Modelos → Comparar** con el mismo texto | Elige el modelo por calidad **y** velocidad en *tu* equipo |

Las pruebas automáticas solo comprueban que la traducción no esté vacía, no conserve caracteres japoneses, difiera del
original y contenga palabras españolas. **No miden la calidad literaria**: eso solo puede juzgarlo una persona.
