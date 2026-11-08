# Validación de la Fase 4 en Android real (Redmi Note 8 Pro)

Este documento es un **protocolo de medición**, no un informe de resultados. **Nadie ha ejecutado todavía estas pruebas en un
teléfono real**: todo lo que se afirma de la Fase 4 (cola persistente, cachés, gobernador, memoria) está verificado solo con visión
y modelo **simulados** (ver [MOTOR-AUDITORIA](MOTOR-AUDITORIA.md)). Las pruebas con hardware real las hace el titular; aquí se
deja el APK verificable y el procedimiento reproducible.

Estados que se usan al anotar resultados: **CONFIRMADO** (medido y repetido) · **PENDIENTE** · **NO VERIFICADO** · **ERROR**.

## 1. El APK

Lo genera el workflow `android` (manual) a partir del código **de la rama que se elige al lanzarlo**; no reutiliza APK de otras
ejecuciones. Cada ejecución produce el artefacto `STARBLITZ-Android-APK` (se conserva 7 días) con:

| Archivo | Contenido |
|---|---|
| `salida/STARBLITZ-android-arm64-CI.apk` | el APK release arm64 |
| `salida/STARBLITZ-android-arm64-CI.apk.sha256` | su SHA-256 |
| `informe-apk/apk-verificacion.md` | verificación estática (firma, paquete `app.starblitz.mobile`, minSdk 28, solo arm64-v8a, bibliotecas de llama.cpp con SHA-256 igual a `vendor/llama-libs.sha256`, sin gancho E2E…) |
| `gradle.log` | registro de la compilación |

**Firma:** el APK se firma con una **clave desechable** que se crea en cada ejecución. No es la clave de producción, **no sirve
para publicar** y **no permite actualizar** una instalación hecha con otra ejecución: hay que desinstalar la app anterior antes de
instalar un APK de otra ejecución (se pierden sus datos locales; exporta lo que quieras conservar).

> La verificación estática **no prueba** que la app funcione en el teléfono; solo comprueba el contenido y la firma.

### Descargar y comprobar la integridad (en el PC)

1. En GitHub → *Actions* → workflow **android** → la ejecución → *Artifacts* → `STARBLITZ-Android-APK` (zip). Comprueba que la
   ejecución es del commit esperado (se ve junto al título de la ejecución).
2. Descomprime y compara el SHA-256 (PowerShell):

```powershell
Get-FileHash .\salida\STARBLITZ-android-arm64-CI.apk -Algorithm SHA256
Get-Content .\salida\STARBLITZ-android-arm64-CI.apk.sha256
```

Los dos valores hexadecimales deben ser idénticos.

### Instalar

Con depuración USB (recomendado, permite usar `adb` para medir):

```bash
adb devices
adb uninstall app.starblitz.mobile
adb install salida/STARBLITZ-android-arm64-CI.apk
```

Sin PC: copia el APK al teléfono, ábrelo y permite «instalar apps desconocidas» a la app que lo abre. MIUI puede pedir confirmar
dos veces y desactivar «Optimización de MIUI» no es necesario para instalar.

## 2. Cómo sacar `project.last_job.timings`

**Desde la app (sin PC):** abre el proyecto → menú **⋮** (arriba a la derecha) → **Exportar informe de rendimiento (JSON)**.
Se guarda en `Descargas/STARBLITZ/starblitz-informe-<proyecto>-<fecha>.json` y se abre el menú de compartir. En Android 9 solo se
ofrece compartir (no hay carpeta Descargas sin permisos): comparte el archivo contigo mismo (correo, Drive…).

**Con PC (alternativa):** `adb pull /sdcard/Download/STARBLITZ/ .`

El informe **solo lee** datos ya guardados; no cambia nada del motor. **No contiene** tokens ni claves (el de Hugging Face queda
fuera), ni imágenes, ni textos del manga: solo cifras, ajustes y el estado del dispositivo.

### Dónde está cada dato que necesitas

| Necesitas | Campo del JSON |
|---|---|
| Tiempo total | `summary.total_s` (y `last_job.timings.chapter.total_s`) |
| OCR por página | `last_job.timings.pages[].analyze_s` (media: `summary.per_page_avg_s.ocr`) |
| Traducción por página | `last_job.timings.pages[].translate_s` (media: `summary.per_page_avg_s.translate`) |
| Reconstrucción por página | `last_job.timings.pages[].clean_s` (media: `summary.per_page_avg_s.clean`) |
| Tokens por segundo | `last_job.timings.pages[].llm_tps` (resumen: `summary.llm_tokens_per_s` = media/mín/máx) |
| Llamadas al OCR | `summary.ocr_calls` (páginas realmente analizadas) y `summary.ocr_cache_hits` (páginas que salieron de la caché) |
| Llamadas al modelo | `summary.llm_calls` y `summary.translate_cache_hits` |
| Carga del modelo | `summary.model_load_s` |
| Memoria libre / usada | `summary.device.ram_free_mb` (inicio, fin, mínima) y `summary.device.system_ram_used_max_mb` |
| Batería | `summary.device.battery_pct` (inicio, fin, `drop`) |
| Temperatura | `summary.device.battery_temp_c` (inicio, fin, máxima) y `summary.device.thermal_max` |
| Decisión de concurrencia | `summary.concurrency_plan`, `summary.overlapped_pages` |
| Liberaciones de memoria | `summary.trims` |
| Textos que conservaron el original | `summary.preserved_originals` |
| Muestra por página | `last_job.timings.pages[].device` (batería, temperatura, memoria libre al terminar cada página) |

### Qué NO puede medir el informe (limitaciones honestas)

- **La memoria de la app sola:** Android no se la da al `WebView`. Se informa la **memoria libre del sistema**;
  `system_ram_used_max_mb` es *RAM total − libre mínima* del sistema entero, **no** lo que usa STARBLITZ. Para la de la app:
  `adb shell dumpsys meminfo app.starblitz.mobile` (antes, durante y después).
- **Llamadas al OCR por bloque:** se cuenta una llamada por **página analizada**; el número de bloques de texto por página está en
  `timings.pages[].regions`.
- **Tokens por segundo:** es el de la **última** llamada al modelo de cada página.
- **Es la última tarea terminada del proyecto.** Si una tarea se interrumpe, no deja informe de esa tarea; el informe siguiente
  (tras reanudar) solo cuenta las páginas de la tarea que sí terminó.
- Con **cachés**, los tiempos de las páginas servidas desde caché **no son** medidas del OCR ni del modelo (el resumen lo avisa).
- La batería y la temperatura son las que reporta el sistema, con su resolución (la batería en pasos de 1 %).
- Si el informe sale con los campos de dispositivo en `null`, el teléfono no informó esos datos.

## 3. Protocolo de pruebas en el Redmi

**Antes de empezar (anótalo):** versión de Android y de MIUI/HyperOS (Ajustes → Acerca del teléfono), RAM, modelo de traducción
instalado y su cuantización, si están instalados Manga OCR y LaMa, ajuste de perfil de la app (Ajustes), temperatura ambiente
aproximada. Cierra las demás apps. Conecta el cargador **o** anota que no lo está (afecta a calor y rendimiento). Brillo medio.

> **Importante:** el servicio en segundo plano (Fase 5) **no está implementado**. Mantén la app **en primer plano y la pantalla
> encendida** durante todas las pruebas; si MIUI cierra la app en segundo plano, es el comportamiento esperado hoy y no un fallo de
> la Fase 4. Pon la app en «Sin restricciones» de batería para no confundirlo con otros cierres.

### Prueba 1 — Primera pasada de un manga de 27 páginas

1. Crea un proyecto nuevo, importa las 27 páginas (anota el idioma y el nombre de los archivos; el límite por proyecto es 50).
2. Antes de procesar, mide la línea base (opcional):
   `adb shell dumpsys meminfo app.starblitz.mobile | findstr TOTAL` y `adb shell dumpsys battery`.
3. Pulsa **Procesar** y no toques el teléfono. Cada ~5 páginas, si usas `adb`, repite `dumpsys meminfo` y anota la hora.
4. Al terminar, **Exportar informe de rendimiento (JSON)** (menú ⋮) y guarda el archivo como `prueba1-primera-pasada.json`.

### Prueba 2 — Registrar los tiempos

Rellena con el JSON de la prueba 1:

| Medida | Valor | Estado |
|---|---|---|
| Tiempo total (s) |  |  |
| OCR por página (media / máx) |  |  |
| Traducción por página (media / máx) |  |  |
| Reconstrucción por página (media / máx) |  |  |
| Tokens/s (media / mín / máx) |  |  |
| Llamadas al OCR / aciertos de caché de OCR |  |  |
| Llamadas al modelo / aciertos de caché |  |  |
| Carga del modelo (s) |  |  |
| RAM libre del sistema (inicio / mínima / fin) |  |  |
| Batería (inicio / fin) · Temperatura (inicio / máx / fin) |  |  |
| `concurrency_plan`, `trims` |  |  |

### Prueba 3 — Revisión de globos, diálogos y dibujos

Abre cada página en el lector/editor y comprueba, **página a página** (anota los números de página con problemas):

- **Ningún globo vacío:** todo globo con texto original debe tener o bien la traducción o bien su original intacto.
- **Originales conservados:** los textos sin traducción válida (rechazo del modelo, vacía, «sin traducir», no cabe) deben seguir con su
  texto original y aparecer **en revisión**; cuéntalos y compáralos con `summary.preserved_originals`.
- **Dibujo intacto:** sin manchas, bordes comidos ni líneas de la viñeta borradas alrededor de los globos; compara con el original.
- **OCR vacío visible:** si alguna región se lee vacía, debe aparecer como texto en revisión, no desaparecer.
- **Texto que cabe y se lee** (tamaño legible, sin salirse del globo).
- El original de cada página sigue disponible (alterna Original / Traducido).

### Prueba 4 — Cachés

Un «Reprocesar todo» **fuerza** una pasada nueva y **salta las cachés a propósito**, así que **no** sirve para probarlas.
Para comprobar que se reutiliza el trabajo:

1. Crea un **segundo proyecto** e importa **los mismos 27 archivos, en el mismo orden**, con el mismo idioma y sin editar la
   sinopsis ni el glosario. Procesa.
2. Exporta el informe (`prueba4-cache.json`) y comprueba: `summary.ocr_cache_hits` debería ser 27 y `ocr_calls` 0;
   `summary.llm_calls` debería ser 0 (o muy bajo) y `translate_cache_hits` > 0. **Si no ocurre, anótalo como ERROR/NO VERIFICADO**
   (la caché depende de que el contexto sea idéntico).
3. El resultado visual debe ser **el mismo** que el del proyecto 1. Compara una muestra de páginas.
4. Cambia la sinopsis del proyecto 2 y reprocesa solo si quieres ver el fallo de caché esperado (el modelo se vuelve a invocar).

### Prueba 5 — Interrupción y recuperación

Con un tercer proyecto (o el primero reprocesado con «Reprocesar todo»):

1. Inicia el procesamiento y, hacia la página 10–12, **cierra la app a la fuerza** (recientes → cerrar) — esto simula que Android la
   mata. Anota cuántas páginas llevaba.
2. Reabre la app. Debe mostrarse **«El procesamiento se interrumpió»** con las páginas terminadas y el botón **Reanudar**.
3. Pulsa **Reanudar**. Comprueba: no se rehacen las páginas ya terminadas (el informe de la reanudación debería contar solo las
   restantes) y al final las 27 quedan completas, sin globos vacíos.
4. Repite una vez más **pausando** (botón Pausar) y reanudando, y otra **cancelando** y reanudando.

*Limitación conocida:* una petición que estaba **en cola sin empezar** cuando se cerró la app queda guardada en la cola persistente
(`queue()/resumeQueue()`), pero **aún no hay aviso en la interfaz** para ella; las ejecuciones con progreso sí muestran «Reanudar».

### Prueba 6 — RAM, batería y temperatura

Durante la prueba 1 (y la 4 si quieres comparar), registra cada 5 páginas (el JSON ya guarda una muestra por página):

```bash
adb shell dumpsys meminfo app.starblitz.mobile | findstr "TOTAL"
adb shell dumpsys battery | findstr "level temperature"
adb shell dumpsys thermalservice | findstr "Thermal Status"
```

Anota si el teléfono se calentó al tacto, si bajó el brillo o si Android cerró algo (MIUI puede matar procesos por memoria).
Apunta cualquier aviso de la app («Poca memoria libre…», «El teléfono está caliente…»). El informe recoge cuántas veces se soltó memoria
(`summary.trims`) y la memoria libre mínima.

## 4. Qué decide cada medida (no se decide aquí)

Con estos datos podrán calibrarse, **con medidas reales**: hilos de `llama` (hoy 5 en un Helio G90T de 8 núcleos, ❓ sin medir), si el
**solapado** del gobernador compensa o no en este teléfono (por defecto está **desactivado** con menos de 10,5 GB de RAM), si
**Manga OCR** es el cuello de botella del OCR, el efecto de la segunda pasada de corrección y los umbrales de memoria. Hasta
medirlo, no se afirma ninguna mejora de velocidad.

## 5. Limitaciones conocidas de esta validación

- El APK usa una clave desechable: sirve para probar, no para distribuir ni para actualizar encima de otro APK.
- La visión y el modelo reales **no** se han probado en este teléfono por nadie hasta ahora; los resultados pueden revelar fallos
  que las pruebas simuladas no ven (arranque de `llama-server`, memoria del `WebView`, WebAssembly sin hilos si la página no está
  aislada — el informe incluye `runtime.cross_origin_isolated`).
- Sin servicio en segundo plano (Fase 5): la pantalla debe estar encendida y la app en primer plano.
- Las medidas de energía y calor dependen del cargador, del ambiente y de lo que haga el teléfono a la vez: repite si dudas.
