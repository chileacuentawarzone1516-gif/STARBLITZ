# Historial de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y versionado [SemVer](https://semver.org/lang/es/).

> Las entradas describen **código implementado**, no funcionalidad validada. El estado de validación de cada
> parte está en [docs/PRUEBAS.md](docs/PRUEBAS.md), [docs/LIMITACIONES.md](docs/LIMITACIONES.md) y
> [docs/PRUEBAS-HARDWARE.md](docs/PRUEBAS-HARDWARE.md).

## [1.0.0] — sin publicar

Primera versión del código. **No hay ninguna Release publicada**: antes de publicarla deben completarse y documentarse
las pruebas de [docs/PRUEBAS-HARDWARE.md](docs/PRUEBAS-HARDWARE.md).

### Añadido

- **STARBLITZ Desktop** (Windows 10/11 x64): aplicación Electron + React con motor propio en Python (FastAPI, ONNX Runtime
  con DirectML, llama.cpp con Vulkan), proyectos, procesamiento por lotes, editor, exportación y gestor de modelos.
- **STARBLITZ Mobile** (Android 9+, arm64): aplicación Capacitor con motor local en TypeScript, plugin nativo en Java y
  `llama-server` de llama.cpp (arm64) como proceso hijo; funciona sin PC.
- **Motor Python** (`engine/`): importación (ZIP, CBZ, PDF, imágenes), detección de texto, OCR (Manga OCR y PP-OCR),
  traducción contextual con modelos locales, reconstrucción del fondo (relleno de papel y LaMa) y trabajos con pausa y
  reanudación.
- **Código común** (`apps/shared`): tipos, cliente del motor, maquetación, exportación, catálogo de modelos y perfiles de
  traducción (Natural, Fiel, Coloquial, Formal y Adaptación narrativa).
- Ecosistema de modelos: búsqueda en Hugging Face, comparación con el dispositivo, descarga reanudable con SHA-256.
- Documentación técnica en `docs/` y automatización en `.github/workflows/` (integridad, pruebas, compilación,
  validación manual y borrador de Release).

### Seguridad y privacidad

- Sin telemetría ni cuentas. Las conexiones salientes se limitan a la descarga de modelos que el usuario solicita.
- Motor de escritorio solo en `127.0.0.1` con token de sesión; Android con `allowBackup=false` y permisos mínimos.
