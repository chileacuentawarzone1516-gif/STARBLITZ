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

### Restricciones de Android a contrastar (❓ = documentación oficial recordada, **no verificada en un dispositivo**)

Antes de implementar hay que contrastar cada fila con la documentación vigente de Android y con una prueba real; el Redmi Note 8
Pro, además, ❓ puede estar en una versión de Android/MIUI anterior a la 14 (hay que anotar la del equipo de pruebas): las
filas de Android 14–16 se probarían en otro dispositivo o emulador.

| Versión / entorno | Restricción relevante | Consecuencia para el diseño | Estado |
|---|---|---|---|
| **Android 9–11** (base actual del proyecto, minSdk 28) | Sin tipos de FGS obligatorios; limitaciones de ejecución en segundo plano desde 8; en 10+ no se puede abrir actividades desde segundo plano | FGS clásico con notificación; sin permisos extra | ❓ |
| **Android 12 (API 31)** | **No se puede arrancar un FGS desde segundo plano** salvo excepciones; las alarmas exactas requieren permiso | El FGS se inicia **solo desde una acción visible** («Procesar proyecto»); nunca desde un `BroadcastReceiver` al arrancar | ❓ |
| **Android 13 (API 33)** | Permiso de notificaciones en tiempo de ejecución (`POST_NOTIFICATIONS`); la persona puede cerrar la notificación del FGS | Pedir el permiso en contexto; si se niega, avisar de que el progreso solo se verá dentro de la app (el FGS funciona igual) | ❓ |
| **Android 14 (API 34)** | **Todo FGS debe declarar un tipo** en el manifiesto y el permiso `FOREGROUND_SERVICE_<TIPO>`; arrancar sin tipo válido lanza excepción | Candidatos: `dataSync`, `mediaProcessing` (API 35) o `specialUse` (exige justificación en el manifiesto; la distribución es por APK propio, no por Play) | ❓ elegir tras probar |
| **Android 15 (API 35)** | `dataSync` y `mediaProcessing` tienen un **límite de tiempo acumulado** por periodo; al agotarse el sistema llama a `onTimeout()` y el servicio debe parar en pocos segundos | Un capítulo largo debe poder **detenerse limpiamente y reanudarse**: ya existe (estado por página + cola persistente de la Fase 4); `onTimeout` debe pausar la tarea y avisar | ❓ valor exacto del límite sin verificar |
| **Android 16 (API 36)** | ❓ posibles cambios en cuotas de trabajos/FGS y en la optimización por defecto de procesos en segundo plano | Tratar cualquier cuota como causa de parada **recuperable**, nunca como error | ❓ no se ha comprobado |
| **MIUI / HyperOS (Redmi Note 8 Pro)** | El gestor de energía/«Autoinicio» puede cerrar el servicio aunque Android lo permita; el bloqueo de la app en «recientes» y «Ahorro de batería: sin restricciones» suelen ser necesarios | Guía en la app (tras probarla en el equipo) y detección de cierre inesperado → la cola persistente la marca *interrumpida* | ❓ el procedimiento exacto depende de la versión de MIUI |
| **Todas** | El `llama-server` es hijo del proceso de la app: si el proceso muere, muere con él | Al reanudar, el motor lo relanza (ya lo hace) y repite solo la página en curso | ✅ lo segundo ya está probado con piezas simuladas |

### Diseño técnico propuesto (sin implementar)

**Componentes**

1. `ProcessingService` (Java, `ForegroundService`): solo mantiene el **proceso vivo** y muestra la notificación. No contiene
   lógica de traducción. Adquiere un `PARTIAL_WAKE_LOCK` con tiempo máximo y lo libera al terminar, pausar o cancelar.
2. Puente Capacitor (`ProcessingPlugin`): `start(title)`, `update({progress, message, page, total, paused})`, `stop(reason)` y
   eventos hacia el `WebView`: `action` (*pausar*, *reanudar*, *cancelar* desde la notificación) y `timeout` (Android 15).
3. Orquestador TypeScript (ya existente): al empezar una tarea de procesamiento llama a `start`; al cambiar el progreso llama
   a `update` (limitado a ~1 por segundo); al terminar/cancelar/fallar llama a `stop`. Las acciones de la notificación se
   traducen a `pauseJob/resumeJob/cancelJob`.
4. `WebView` en segundo plano: ❓ **es el punto de mayor riesgo**: hay que comprobar que, con la pantalla apagada y la actividad
   en segundo plano, siguen ejecutándose JavaScript, los *Workers* de visión y los temporizadores (en Capacitor, `resumeTimers`
   del `WebView` y el bloqueo parcial de CPU). Si no es fiable → plan C (orquestador nativo) o pausa automática.

**Máquina de estados** (se apoya en la cola persistente de la Fase 4): `idle → starting → running ⇄ paused → stopping → idle`,
con `interrupted` si el proceso muere. Al reabrir la app, `queue()` muestra lo `interrumpido` y la persona decide retomar.

**Reglas**

- El FGS se arranca **solo** desde una acción visible y se detiene en cuanto no queda trabajo (nunca un servicio «permanente»).
- La `DeviceStatusGuard` (batería ≤ 10 %, calor, poco espacio, poca memoria) sigue mandando en segundo plano: pausa y actualiza la
  notificación en lugar de insistir.
- Una página es la unidad atómica: si el proceso muere, solo se repite la página en curso. Ninguna parada (timeout, cierre del
  sistema, batería) puede dejar un globo vacío: la regla de integridad de la Fase 3 se aplica igual al reanudar.
- El progreso de la notificación sale del mismo `RunState` que ve la interfaz (una sola fuente de verdad).

**Riesgos principales:** (1) el `WebView` puede congelarse en segundo plano; (2) límites de tiempo del FGS (Android 15+);
(3) cierre por el gestor de batería de MIUI; (4) mayor consumo de batería y calor en un procesamiento largo (hay que medirlo);
(5) la notificación puede ser descartada por la persona (el servicio sigue, pero no hay control visible).

**Plan de pruebas (en dispositivo, lo hace el titular)**: capítulo de ≥ 20 páginas con la pantalla apagada 10 min; app
enviada a segundo plano; pausa/reanudación/cancelación desde la notificación; matar la app desde «recientes» y reabrir
(debe mostrarse como interrumpida y retomar sin repetir páginas); batería baja; con y sin permiso de notificaciones; en MIUI con
y sin «sin restricciones». Registrar versión de Android/MIUI de cada prueba.

**Criterio de «terminado» de la Fase 5:** las pruebas anteriores superadas en el Redmi Note 8 Pro y, al menos, una prueba en
Android 14 o superior. Hasta entonces: ⏳ diseño.

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

> **Actualización 2026-11-09:** el repositorio de código es **público** (comprobado con la API de GitHub); la restricción de abajo
> describe la situación del 2026-11-07 y queda como historia. Con el repositorio público, la app puede leer sus Releases sin
> credencial; elegir entre este repositorio o uno aparte (`STARBLITZ-RELEASES`) sigue siendo decisión del titular.

El repositorio era **privado** (2026-11-07). Una app instalada **no puede** consultar Releases privadas sin una credencial, y **no se
incrustarán tokens** en la app (cualquiera podría extraerlos del APK/instalador).

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
