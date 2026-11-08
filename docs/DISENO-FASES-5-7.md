# Diseño: segundo plano en Android, tipografía y actualizador

Documento de **diseño** (nada de esto está implementado todavía). Lo que depende de reglas de Android, de fabricantes o de
GitHub se marca como ❓ cuando **no se ha verificado en un dispositivo real**; hay que contrastarlo con la documentación
oficial vigente y con pruebas en el Redmi Note 8 Pro antes de darlo por cierto.

## Fase 5: procesamiento en segundo plano (Android)

### Problema de arquitectura

Todo el motor móvil (orquestador, cola, traducción, visión) es **TypeScript dentro del `WebView`** de la actividad. El
proceso hijo `llama-server` pertenece al proceso de la app. Para que el trabajo continúe al salir de la app o con la
pantalla apagada hay que mantener **vivo el proceso y la ejecución de JavaScript**; con la actividad en segundo plano, Android
puede congelar o matar el proceso, y ❓ el `WebView` puede pausar temporizadores y renderizado.

### Opciones evaluadas

| Opción | Cómo | A favor | En contra / riesgo |
|---|---|---|---|
| **A. Servicio en primer plano (FGS) que mantiene el proceso** (recomendada para empezar) | Un `Service` nativo con notificación persistente; el orquestador TypeScript sigue en el `WebView` | Cambia poco código; progreso real vía el mismo bus de eventos; cancelar/reanudar ya existen | ❓ Hay que comprobar que el `WebView` sigue ejecutando JS y los Workers con pantalla apagada (`resumeTimers`, bloqueo de CPU parcial); ❓ límites de tiempo de los tipos de FGS en Android 15 |
| B. `WorkManager` (trabajo expedido o de larga duración) | Reencolar el trabajo por tandas | Sobrevive a reinicios; cumple las políticas de energía | Los trabajos tienen límites de tiempo y cuotas; no mantienen vivo el `WebView`; no encaja con una tarea de decenas de minutos sin rearmarla |
| C. Orquestador nativo en Java/Kotlin | Mover la cola al servicio y dejar el `WebView` solo para la visión | La más robusta | Reescritura grande (la visión depende de OpenCV.js y ONNX Runtime Web, que son WebAssembly) |

**Recomendación:** prototipo de **A** (FGS + reanudación del `WebView`), con `WorkManager` solo como *red de seguridad* para
reanudar una tarea interrumpida (la reanudación por páginas ya existe). C queda como plan si A no es fiable en el dispositivo.

### Qué debe cumplir (criterios de aceptación)

- Continuar al salir de la app y con la pantalla apagada; notificación persistente con **progreso real** y acciones
  *Pausar* y *Cancelar*; recuperación de trabajos interrumpidos al reabrir (ya existe a nivel de página).
- Procesar una página como unidad atómica: si el sistema mata el proceso, solo se repite la página en curso.
- Respetar la `DeviceStatusGuard` (batería ≤ 10 %, calor, poco espacio) también en segundo plano.

### Restricciones de Android a contrastar (❓ no verificadas en dispositivo)

- **Android 13+:** permiso de notificaciones en tiempo de ejecución (`POST_NOTIFICATIONS`).
- **Android 14 (API 34):** todo FGS debe declarar un **tipo** en el manifiesto y el permiso correspondiente
  (`FOREGROUND_SERVICE_*`); hay tipos (p. ej. `dataSync`) y también `specialUse`, con justificación.
- **Android 15 (API 35):** ❓ algunos tipos de FGS tienen **límite de tiempo** por periodo; un capítulo largo debe caber o
  reiniciarse limpiamente (la reanudación por página lo permite).
- **Android 12+:** arrancar un FGS desde segundo plano está restringido: debe iniciarse mientras la app es visible o con una
  excepción permitida. El arranque se hará desde la acción del usuario («Traducir proyecto»).
- **Android 16 (API 36):** ❓ revisar cambios en cuotas y en trabajos; **no se ha comprobado**.
- **Fabricantes (MIUI/HyperOS del Redmi Note 8 Pro):** el gestor de batería puede matar el servicio aunque Android lo permita;
  normalmente hace falta marcar la app como «sin restricciones» y activar el inicio automático. ❓ Se documentará el
  procedimiento y se mostrará una guía en la app tras probarlo en el dispositivo.
- El `llama-server` es un hijo del proceso de la app: si el proceso muere, muere con él; hay que relanzarlo en la reanudación
  (ya lo hace el motor).

## Fase 6: reconstrucción visual

Hoy (`makeRegion`) se infiere color claro/oscuro del fondo, contorno sobre dibujo, mayúsculas en onomatopeyas y una tipografía por rol
(diálogo, narración, grito…). Plan por etapas, **sin prometer fuentes exactas** (la imagen no contiene esa información):

1. Medir del recorte original: **color del texto**, **grosor** de trazo y **contorno** (diferencia texto/fondo en el anillo
   de la región), **inclinación** (cursiva) y **orientación**; guardarlos en `style` (los campos `color`, `stroke_*`, `italic`,
   `bold`, `rotation` ya existen).
2. Elegir entre las tipografías incluidas (OFL) la **más parecida** por clasificación simple (con serifa/sin ella, grosor,
   inclinación, estilo manuscrito) y ajustar tamaño dentro del polígono del globo (ya existe `layoutText`).
3. Sombra y degradados: solo si se detectan con fiabilidad; si no, no se inventan.
4. Medir: % de textos cuyo estilo coincide visualmente, por revisión humana.

## Fase 7: actualizador integrado

### Restricción

El repositorio es **privado**. Una app instalada **no puede** consultar Releases privadas sin una credencial, y **no se
incrustarán tokens** en la app (cualquiera podría extraerlos del APK/instalador). Tampoco se hará público el repositorio.

### Alternativas

| Alternativa | Cómo funciona | Pros | Contras / decisión tuya |
|---|---|---|---|
| **1. Repositorio público solo de distribución** (recomendada) | Un repositorio público aparte (p. ej. `STARBLITZ-releases`) con un `latest.json` firmado y los binarios; el código sigue privado. El CI de `release.yml` publica ahí | La app consulta la API pública sin credenciales; historial y notas de GitHub | Requiere crear ese repositorio y un token de CI de **mínimo alcance** (secreto de Actions) para publicar; los binarios pasan a ser públicos (es lo que implica distribuir) |
| 2. Alojamiento propio/estático | `latest.json` + binarios en un servidor o almacenamiento tuyo | Total control; sin GitHub público | Coste y mantenimiento; ❓ puede implicar servicios de pago, que no se quieren |
| 3. Comprobación manual | La app muestra un enlace a la página de Releases (requiere iniciar sesión en GitHub) | No expone nada | Sin barra de progreso ni instalación integrada |
| 4. Token del usuario | El usuario pega un token de solo lectura | Funciona con el repo privado | Mala experiencia y riesgo de guardar un secreto en el teléfono |

### Diseño de la opción 1

- **Manifiesto** `latest.json`: versión (SemVer), notas, URL, tamaño y **SHA-256** de cada archivo (instalador de Windows, APK).
- **Autenticidad:** además del SHA-256, el manifiesto va **firmado con Ed25519**; la app incrusta solo la **clave pública**.
  La clave privada de firma de manifiestos es **distinta** de la clave de firma del APK y no entra al repositorio.
- **Comparación de versiones:** SemVer con *prerelease* (`1.1.0-rc.1 < 1.1.0`); los *prerelease* solo se ofrecen a quien lo active.
- **Windows:** descarga del instalador NSIS actual (`STARBLITZ-Setup-<ver>.exe`) en la carpeta temporal, verificación y
  ejecución del instalador con confirmación del usuario. (Electron `autoUpdater` no encaja: usa metadatos de `electron-builder`
  y aquí el instalador canónico es NSIS directo.)
- **Android:** descarga con barra de progreso, verificación, e instalación mediante el instalador de paquetes del sistema
  (`ACTION_VIEW`/`PackageInstaller` con `FileProvider`); exige el permiso «instalar apps desconocidas» y que el APK nuevo esté
  **firmado con la misma clave**. Sin una **clave de producción estable** la actualización falla: las claves desechables de CI no
  sirven.

### Clave de firma de producción

**No se generará ni sustituirá** ninguna clave hasta verificar su custodia y copia de seguridad contigo. Requisitos
propuestos: generada y guardada **fuera del repositorio**, con **dos copias cifradas** en lugares distintos, contraseña en un
gestor, y solo su copia en Base64 como secreto de Actions (`ANDROID_KEYSTORE_B64`, alias `starblitz`). Perderla impide
publicar actualizaciones para quien ya instaló la app.

### Qué necesito de ti para implementarlo

1. Elegir la alternativa (recomendada: 1) y, si es la 1, crear el repositorio público de distribución y un token de mínimo alcance.
2. Decidir cómo se custodia la clave de producción (ver arriba).
3. Confirmar si habrá canal de *prerelease* para pruebas.

Las piezas puras (comparar versiones, validar el manifiesto, comprobar SHA-256) se pueden implementar y probar sin esas
decisiones; la descarga e instalación reales, no.
