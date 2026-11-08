# Política de seguridad

## Versiones con soporte

Todavía no hay versiones publicadas. Cuando existan, esta tabla indicará cuáles reciben correcciones de seguridad.

| Versión | Soporte |
|---|---|
| 1.0.0 (sin publicar) | — |

## Cómo informar de una vulnerabilidad

**No abras un issue público.** Usa el informe privado de GitHub (pestaña *Security* → *Report a vulnerability*) cuando
esté habilitado en el repositorio. Mientras el repositorio sea privado, informa directamente al titular por el canal
habitual. Incluye versión, plataforma, pasos para reproducirlo e impacto. No incluyas tokens ni datos personales reales.

## Qué se considera en alcance

- El motor local (escucha en `127.0.0.1`, token de sesión por arranque) y la interfaz de escritorio (Electron).
- El plugin nativo de Android y el arranque de `llama-server` como proceso hijo.
- La descarga de modelos (tamaño, SHA-256 y rutas) y el tratamiento de archivos importados (ZIP, CBZ, PDF, imágenes).
- Fugas de privacidad: cualquier conexión saliente distinta de la descarga de modelos solicitada por el usuario.

## Fuera de alcance

- Vulnerabilidades de los modelos de lenguaje o de visión en sí (consulta al autor del modelo).
- Servidores externos que el usuario configure (Ollama, LM Studio o compatibles con OpenAI): si son remotos, los textos
  salen del equipo por decisión del usuario.

## Privacidad y datos sensibles

STARBLITZ no incluye telemetría ni cuentas. Detalle en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md#seguridad) y en
[docs/LIMITACIONES.md](docs/LIMITACIONES.md) (por ejemplo, el token opcional de Hugging Face se guarda sin cifrar en el
almacenamiento privado de la app).

## Para quien contribuye o publica

- Nunca subas secretos, claves de firma ni modelos; el CI lo comprueba parcialmente (`scripts/ci/verificar-repo.sh`).
- La clave de firma del APK es del titular: se guarda fuera del repositorio y se inyecta como secreto del CI
  (`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`). El workflow no pasa el alias ni la contraseña de la clave:
  el keystore debe usar el alias `starblitz` y la misma contraseña para almacén y clave. `release.yml` exige esa firma;
  `validacion.yml` usa una clave desechable. Si se pierde, no se podrán publicar actualizaciones sobre la misma
  instalación.
- Los workflows usan permisos mínimos (`contents: read`); solo `release.yml` pide escritura, únicamente en el job que crea
  el borrador de la Release.
