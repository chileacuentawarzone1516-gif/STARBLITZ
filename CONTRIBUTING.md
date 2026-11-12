# Contribuir a STARBLITZ

Gracias por querer ayudar. Esta guía resume cómo preparar el entorno, qué se espera de un cambio y qué nunca debe
subirse al repositorio.

## Antes de empezar

- Abre un *issue* (plantilla de error o de mejora) para cambios grandes antes de escribir código.
- Para vulnerabilidades **no** abras un issue público: sigue [SECURITY.md](SECURITY.md).
- La licencia del proyecto está pendiente de confirmación por el titular; los términos para las contribuciones se
  aclararán cuando se confirme (ver `LICENSE` y [docs/LICENCIAS-TERCEROS.md](docs/LICENCIAS-TERCEROS.md)).

## Entorno de desarrollo

Requisitos: Node.js 20+ (probado con 22) y npm; Python 3.12+ (probado con 3.12 y 3.14; numpy 2.5 exige 3.12); para el APK, JDK 21 y Android
SDK 35. Detalle en [docs/COMPILAR.md](docs/COMPILAR.md).

```bash
npm ci
python -m venv .venv && .venv/bin/pip install -r engine/requirements.txt onnxruntime pytest onnx
.venv/bin/pip install --no-deps rapidocr==3.10.0
```

En Windows (PowerShell) el entorno virtual se activa con `.venv\Scripts\Activate.ps1`. Si `npm ci` completo falla en
Windows, instala solo lo necesario: `npm ci -w @starblitz/shared -w @starblitz/mobile`.

## Pruebas

```bash
npm run typecheck                         # shared + desktop + mobile
npm test                                  # shared + mobile
cd engine && python -m pytest -q          # motor (parte requiere modelos reales y se omite sin ellos)
bash apps/mobile/e2e/run.sh               # E2E en Chromium (Playwright, Pillow, openssl y fuente CJK)
```

Los datos compartidos Python ↔ TypeScript (prompts, perfiles, catálogo) se regeneran con los scripts de `tools/`
(`export_translate_fixtures.py`, `export_llm_catalog.py`, `export_vision_registry.py`); las pruebas fallan si ambos
lados se desvían. Si cambias un prompt, un perfil o el catálogo, regenera y sube también los datos derivados.

## Qué se espera de un cambio

1. Cambios pequeños y enfocados, con su prueba cuando haya lógica.
2. No declares «validado» lo que solo compiló o pasó pruebas simuladas: distingue compilado, simulado, real y
   hardware pendiente (ver [docs/PRUEBAS.md](docs/PRUEBAS.md)).
3. Actualiza la documentación afectada y [CHANGELOG.md](CHANGELOG.md).
4. Respeta el tono de la documentación: español, técnico y conciso.
5. El CI debe pasar (`ci.yml`), incluida la comprobación de integridad (`scripts/ci/verificar-repo.sh`).

## Qué nunca debe subirse

- Secretos: `.env`, tokens, claves, `*.jks`, `*.keystore`, `*.pem`, `*.p12`.
- Modelos de IA (`*.gguf`, `*.onnx` pesados) y binarios (`*.exe`, `*.apk`, `*.zip`): se distribuyen con Releases o los
  descarga la propia app.
- Notas internas, copias de seguridad, el Vault de Obsidian o datos personales.
- Páginas de manga o cómic con derechos de autor como ejemplos o fixtures.

`.gitignore` está escrito como lista blanca: si añades una carpeta o archivo nuevo en la raíz, declara su excepción
explícitamente.

## Finales de línea

`.gitattributes` fija LF para `*.sh` y `gradlew`, y CRLF para `*.bat`, `*.ps1` y `*.nsi`. No los cambies.

## Releases

Las publica el titular: etiqueta `vX.Y.Z` en `main` con la versión de `package.json` y la sección correspondiente del
CHANGELOG. `release.yml` solo crea un **borrador**; ver [docs/COMPILAR.md](docs/COMPILAR.md).
