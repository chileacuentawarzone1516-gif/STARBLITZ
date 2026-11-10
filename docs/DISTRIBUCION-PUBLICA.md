# Distribución pública, firma y actualización

Estado: **diseño** (nada de lo que sigue está publicado ni activado). Leyenda: ✅ implementado y probado · 🧪 solo en pruebas
automáticas · 📐 diseñado · ⛔ bloqueado por una decisión o un dato que debe aportar el titular.

> **Cambio de premisa (comprobado el 2026-11-09 con la API de GitHub):** el repositorio de código `STARBLITZ` es **público** (no
> privado, como suponía la primera versión de este diseño, del 2026-11-08). Consecuencias, **sin decidir nada por el titular**:
> (1) el actualizador podría leer las Releases de este mismo repositorio sin credenciales, así que el repositorio aparte
> `STARBLITZ-RELEASES` deja de ser imprescindible (sigue siendo una opción si se quiere separar presentación y código) — ⛔ decisión
> del titular; (2) todo lo que se suba aquí es visible: las reglas de «nunca se publica» de abajo se aplican **a cada push**, no solo
> a las Releases (la lista blanca de `.gitignore` y `scripts/ci/verificar-repo.sh` ya lo hacen); (3) la licencia (D2) y el logo (D1)
> pasan a ser visibles para cualquiera mientras siguen pendientes.

## 1. Qué es público y qué no

| Repositorio | Visibilidad | Contenido |
|---|---|---|
| `STARBLITZ` (código) | **Público** (comprobado 2026-11-09) | Todo el código, el CI, los documentos de trabajo (sin Vault, sin respaldos, sin modelos ni secretos) |
| `STARBLITZ-RELEASES` (opcional, ⛔) | Público, si se crea | `README.md` de presentación, capturas **reales**, documentación de instalación, `CHANGELOG`, `latest.json` (+ firma), y en *Releases*: APK, instalador EXE, ZIP portable y `SHA256SUMS.txt` |

**Nunca se publica** (comprobación automática obligatoria antes de cada publicación): código fuente, `.env`, `*.jks`, `*.keystore`,
`*.pem`, `*.p12`, tokens o contraseñas, el Vault de Obsidian (`STARBLITZ OBISIDIAN/`), `_backup/`, modelos o binarios de terceros
sin su licencia, ni logs con rutas personales. El flujo de publicación recorre la lista de archivos que va a subir y **aborta** si
alguno coincide con esos patrones o si encuentra cadenas con forma de credencial (`ghp_`, `github_pat_`, `-----BEGIN`).

## 2. Artefactos de cada versión oficial

| Archivo | Plataforma | Notas |
|---|---|---|
| `STARBLITZ-<ver>-android-arm64.apk` | Android 9+ (arm64) | Firmado con la **clave de producción** (ver §4) |
| `STARBLITZ-Setup-<ver>.exe` | Windows 10/11 x64 | Instalador NSIS canónico |
| `STARBLITZ-<ver>-win-x64-portable.zip` | Windows 10/11 x64 | Versión portable |
| `SHA256SUMS.txt` | — | Una línea `hash  archivo` por artefacto, formato de `sha256sum -c` |
| `latest.json` + `latest.json.sig` | — | Manifiesto para el actualizador (ver §5) |

Cada Release lleva su numeración SemVer (`vMAJOR.MINOR.PATCH`), notas de cambios y la **tabla de hashes** en el cuerpo. Las notas se
extraen del `CHANGELOG` del repositorio de código (ya lo comprueba `release.yml`). El historial de versiones es el de las Releases del
repositorio público.

## 3. Flujo de publicación (propuesto, sobre `release.yml`)

1. Etiqueta `v*` en el repositorio de código → `release.yml` (ya existente) ejecuta `ci.yml` y `build.yml` con **firma obligatoria**.
2. Se crea el **borrador** en el repositorio de código (ya implementado: nada se publica solo).
3. Un trabajo nuevo `publish-public` (📐), que **solo** se ejecuta tras aprobación manual (*environment* protegido):
   - descarga los artefactos firmados del borrador,
   - recalcula `SHA256SUMS.txt` y `latest.json`, **firma el manifiesto** (§5),
   - ejecuta la comprobación de «nada prohibido» (§1),
   - crea la Release en `STARBLITZ-RELEASES` con un **token de ámbito mínimo** (ver abajo).
4. El token: *fine-grained personal access token* con **solo** `Contents: write` sobre `STARBLITZ-RELEASES`, guardado como secreto de
   Actions del repositorio de código. **Nunca** va en la app, en el código ni en un archivo del repositorio. Caduca (≤ 1 año) y se rota.

## 4. Firma

### Android (⛔ falta establecer custodia y copia de seguridad)

Un APK solo actualiza a otro si **ambos están firmados con la misma clave**. Los APK de `android.yml`/`validacion.yml` usan una clave
**desechable** y **no sirven** para publicar: quien instalara uno tendría que desinstalar antes de pasar al oficial. Por eso:

- **No se genera ni se sustituye ninguna clave de producción hasta completar este procedimiento** (lo ejecuta el titular, o yo con su
  confirmación explícita de cada punto):
  1. Generar el keystore **fuera del repositorio** y fuera de carpetas sincronizadas (`keytool -genkeypair -v -keystore starblitz-release.jks
     -alias starblitz -keyalg RSA -keysize 4096 -validity 9125`, misma contraseña de almacén y de clave), con una contraseña larga
     generada por un gestor de contraseñas.
  2. Anotar la **huella SHA-256 del certificado** (`keytool -list -v -keystore … -alias starblitz`) en un archivo público del
     repositorio de distribución (permite a cualquiera comprobar que un APK es oficial: `apksigner verify --print-certs`).
  3. **Dos copias cifradas** del `.jks` en lugares físicamente distintos (p. ej. disco externo + almacenamiento cifrado) y la contraseña en
     el gestor, con copia de recuperación de éste. Una sola copia no es suficiente: perder la clave impide actualizar a todos los usuarios.
  4. **Prueba de recuperación:** restaurar una copia en una carpeta limpia, firmar con ella un APK de prueba y comprobar que la huella
     coincide con la del paso 2. Sin esta prueba superada, la clave no se considera operativa.
  5. Subir a los secretos de Actions solo el keystore en Base64 (`ANDROID_KEYSTORE_B64`) y la contraseña (`ANDROID_KEYSTORE_PASSWORD`).
- El script `build.gradle` ya lee `SB_KEYSTORE`/`SB_KEYSTORE_PASSWORD`; `release.yml` ya falla si falta el secreto (✅).
- **Rotación:** Android permite rotar claves con *APK Signature Scheme v3*, pero es un proceso delicado: la primera clave debe tratarse
  como definitiva. Si se pierde, la única salida es publicar una app con otro identificador y pedir reinstalar.

### Windows (⛔ no hay certificado)

- Sin certificado de firma de código, el instalador y el ejecutable funcionan, pero **Windows SmartScreen** mostrará «editor
  desconocido» y avisos de descarga poco habituales: es un hecho, no un fallo. **No se afirma** que esté firmado mientras no lo esté.
- Opciones (decisión del titular): (a) certificado OV/EV de una autoridad reconocida (de pago; EV elimina antes el aviso de
  SmartScreen); (b) servicios de firma gestionada (de pago o con programas para código abierto que **no encajan** con un repositorio
  privado); (c) publicar sin firma, con el SHA-256 y las instrucciones de verificación bien visibles. Hasta decidir: **(c)**.
- Con o sin firma, la integridad se garantiza con `SHA256SUMS.txt` y con el manifiesto firmado (§5).

## 5. Actualizador

Piezas puras (comparación SemVer, validación del manifiesto, comparación de SHA-256) ✅ ya existen en `apps/shared/src/updater.ts`
con pruebas. Lo demás se implementa **después** de que existan el repositorio público y la clave (📐):

1. **Consultar:** la app pide `latest.json` (+ `.sig`) por HTTPS a `STARBLITZ-RELEASES` (raw/Releases públicas): **sin credenciales**. Solo
   si el usuario lo permite (es una conexión a Internet; la app es local por defecto) y no más de una vez al día.
2. **Autenticidad:** el manifiesto va firmado con **Ed25519**; la app incrusta solo la **clave pública**. La clave privada de
   manifiestos es **distinta** de la de Android y nunca entra al repositorio (secreto de Actions). Sin firma válida → se ignora.
3. **Notas:** se muestran las notas de la versión del manifiesto.
4. **Descarga con progreso**, reanudable, a una carpeta temporal privada; límite de tamaño igual al del manifiesto.
5. **Verificación SHA-256** del archivo descargado frente al manifiesto **y** frente a `SHA256SUMS.txt`; si difiere, se borra y se avisa.
6. **Completar:**
   - **Windows:** ejecutar el instalador NSIS descargado con confirmación del usuario (UAC incluido). *No* hay actualización silenciosa
     garantizada.
   - **Android:** abrir el instalador de paquetes del sistema (`FileProvider` + `ACTION_VIEW`/`PackageInstaller`). **Siempre requiere
     intervención del usuario** (permiso «instalar apps desconocidas» para STARBLITZ y pulsar *Instalar*); **no se promete instalación
     silenciosa**. Solo funciona si el APK nuevo está firmado con la clave de producción (§4).
7. **Fallos:** cualquier error deja la versión instalada intacta; nunca se borra nada del usuario.

## 6. Puertas de calidad antes de publicar una versión estable

Una versión **estable** no se publica mientras falte **alguna** de estas: ✅ = cumplida hoy; ❌ = falta.

| Puerta | Hoy |
|---|---|
| Pruebas automáticas y E2E en CI | ✅ |
| Clave de producción Android creada, respaldada y con recuperación probada | ❌ |
| APK de producción firmado e instalado y probado en un teléfono arm64 real (Redmi Note 8 Pro) | ❌ |
| Traducción medida con modelos reales en el teléfono (tiempo, RAM, calidad) y modelo por defecto elegido con datos | ❌ (ver [MODELOS-INVESTIGACION](MODELOS-INVESTIGACION.md)) |
| Instalador NSIS probado: instalar, abrir, actualizar, desinstalar | ✅ en el runner de CI; ❌ en un equipo real |
| Prueba de hardware de Windows (GPU, modelos reales) | ❌ |
| Prueba de actualización de extremo a extremo (APK N → N+1 conservando datos y firma) | ❌ |
| `SHA256SUMS.txt` y manifiesto firmado generados por el flujo | ❌ (no implementado) |
| Repositorio `STARBLITZ-RELEASES` creado con su README y sin archivos prohibidos | ❌ |
| Logo oficial entregado y colocado (decisión D1) y licencia confirmada (D2) | ❌ |
| Capturas **reales** de la interfaz (no maquetas) | ❌ |

Mientras haya ❌ en las puertas críticas (firma, hardware, integridad, actualización), **solo se publica como *prerelease*, si se
publica algo**, y siempre indicándolo en la propia Release. La autorización de lanzamiento del titular se ejecutará cuando todas
estén en ✅.
