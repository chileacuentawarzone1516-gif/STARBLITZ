# Instalación y requisitos de hardware

## Requisitos

### Windows (STARBLITZ Desktop)

| | Mínimo | Recomendado |
|---|---|---|
| Sistema | Windows 10 21H2 x64 | Windows 11 x64 |
| RAM | 8 GB (modelo de 2–4 B, en CPU) | 16 GB o más |
| GPU | Ninguna (funciona en CPU, más lento) | Cualquier GPU con Vulkan/DirectX 12 y ≥ 6 GB de VRAM (NVIDIA, AMD o Intel) para el modelo de 9 B |
| Disco | ~0,7 GB de la app + ~0,8 GB de visión + 1,3–15 GB del modelo de lenguaje | SSD |

La app elige el perfil midiendo tu equipo. Con un portátil de 32 GB de RAM y una RTX 4060 de 8 GB (como el HP OMEN 16 del
proyecto) corresponde el perfil «PC con GPU» y Qwen 3.5 9B. **No se ha podido medir el rendimiento real en ese equipo**
(ver [LIMITACIONES](LIMITACIONES.md)); los tiempos por página dependen de la GPU y del modelo.

### Android (STARBLITZ Mobile)

| | Mínimo | Recomendado |
|---|---|---|
| Sistema | Android 9 (API 28) | Android 12 o superior |
| Procesador | **arm64-v8a** (la inmensa mayoría de móviles desde 2017). Los x86/x86_64 (emuladores, algunos BlueStacks) abren la app pero **no pueden traducir** | Chip reciente con dotprod/i8mm |
| RAM | 4 GB (modelo de 2 B, lento y limitado) | 6–8 GB (4 B) o ≥ 10 GB (9 B) |
| Almacenamiento libre | ~0,3 GB (app) + 1,3 GB (modelo 2 B) + 0,5–1 GB de visión opcional | ≥ 6 GB |
| Otros | Sin permisos especiales (Internet para descargar modelos y vibración háptica) | Cargador conectado en capítulos largos |

El tamaño del APK no se ha medido (no se ha compilado): la interfaz y los modelos incluidos suman unos 49 MB y las
bibliotecas de llama.cpp arm64 28 MB sin comprimir.

## Windows

1. Portátil (disponible): abre `dist\STARBLITZ-win-x64\STARBLITZ.exe` (los datos se guardan en su carpeta `data` si existe
   `portable.txt`). Instalador (opcional): `bash scripts/build-installer.sh` lo genera como `dist/STARBLITZ-Setup-1.0.0.exe`
   (por usuario, sin administrador); **no se ha generado ni probado en esta sesión**.
   Es el instalador canónico: en GitHub Actions lo genera y lo prueba `windows.yml` (artefacto `STARBLITZ-Windows`);
   ver [COMPILAR](COMPILAR.md#github-actions).
   Windows SmartScreen avisará la primera vez porque el ejecutable no está firmado («Más información → Ejecutar de todas formas»).
2. En **Inicio** pulsa **Descargar lo necesario**: detector de texto (95 MB), Manga OCR (460 MB), LaMa (208 MB) y el
   modelo de traducción recomendado para tu equipo. Es una descarga única; después todo funciona sin Internet.
3. En **Modelos → Avanzado → Origen del modelo** deja «Integrado en STARBLITZ» (llama.cpp incluido). Si tu `data/settings.json`
   viene de una versión anterior con `ollama`, cámbialo ahí.
4. Arrastra un ZIP, CBZ, PDF o imágenes. Elige idioma de origen, variante de español y perfil de traducción.
5. Revisa en el **Editor** (lo dudoso aparece marcado) y **Exporta** a PDF, ZIP, JPG, PNG o WEBP.

El desinstalador (cuando se genere el instalador) conserva proyectos y modelos (`%APPDATA%\STARBLITZ`).

## Android

1. **Obtener el APK**: compílalo con `scripts\Compilar-APK-Android.bat` (doble clic en Windows; descarga JDK y SDK en
   `.cache\android`) o con GitHub Actions (artefacto `STARBLITZ-Android`). Ver [COMPILAR](COMPILAR.md).
2. **Instalar**: copia `STARBLITZ-android.apk` al teléfono y ábrelo (permite «instalar apps desconocidas» para tu gestor de
   archivos), o conecta el teléfono con depuración USB y ejecuta `scripts\build-android.ps1 -Install`.
3. **Primer arranque**: abre **Modelos**. La app mide tu teléfono, propone un perfil y un modelo de traducción y comprueba
   que cabe. Descarga el **detector de texto** (pestaña Visión) y un **modelo de lenguaje**; usa Wi‑Fi y cargador.
4. **Importar** con el botón ★: ZIP, PDF o imágenes (hasta 50 páginas por proyecto, ajustable en Ajustes).
5. **Procesar**: «Traducir proyecto». Verás miniaturas, estado por página, porcentaje, tiempo estimado y errores; puedes
   abrir las páginas terminadas mientras el resto se procesa. Pausa/reanuda cuando quieras; si el sistema cierra la app,
   el trabajo se puede reanudar.
6. **Exportar**: PDF, ZIP, JPG, PNG o WEBP; se guarda en «Descargas/STARBLITZ» (Android 10+) o se comparte (Android 9).

Consejos: procesa con el cargador y el teléfono ventilado (la app pausa sola por batería ≤ 10 %, calor o poco espacio);
no cierres la app deslizándola mientras procesa (no hay servicio en primer plano; ver limitaciones).

### BlueStacks / emulador

Instala el APK arrastrándolo a la ventana. Solo funciona completo si la instancia es **arm64**; en x86_64 la app abre y
permite importar, editar y exportar, pero la traducción local avisa de que falta el motor para esa arquitectura.
