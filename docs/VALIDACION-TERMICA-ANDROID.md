# Protocolo de validación térmica y de rendimiento sostenido (Redmi Note 8 Pro)

**Objetivo:** comprobar con medidas reales si STARBLITZ mantiene la velocidad durante un capítulo completo (sin la caída típica del *thermal throttling*) y calibrar el
control térmico. **Nada de esto se ha ejecutado todavía en un teléfono**; los parámetros del control térmico son hipótesis sin calibrar
([OPTIMIZACION-ANDROID](OPTIMIZACION-ANDROID.md) §5). Los resultados de un PC **no** se presentan como resultados de Android.

Estados al anotar: **CONFIRMADO · PENDIENTE · NO VERIFICADO · ERROR**.

## 0. Qué APK comparar (mismas condiciones)

| Etiqueta | APK | Qué tiene |
|---|---|---|
| **A (línea base)** | `android.yml` #6, commit `0d25cdb` (SHA-256 `3fec59ce…fbe43`) | Fases 3–4 y traductor de texto plano, **sin** control térmico ni desglose de visión |
| **B (nuevo)** | `android.yml` #7, commit `a188a80` ([run 42518760487](https://github.com/chileacuentawarzone1516-gif/STARBLITZ/actions/runs/42518760487)), SHA-256 `9f48ff0a66bf637fa2fa125cb2ae0a0048bd00321d3618d9e63813fa8627d00e` | A + **control térmico** + **desglose de tiempos de visión** + margen térmico en el plugin |

Instala uno cada vez (`adb uninstall app.starblitz.mobile` entre ellos: la firma es desechable y cada ejecución usa otra).

## 1. Condiciones (anótalas en cada prueba; deben ser iguales entre A y B)

- Misma obra de **27 páginas** (mismos archivos y orden), mismo idioma elegido a mano (no «Automático»), mismos ajustes y mismo modelo de traducción (Qwen-4B o el que se esté probando).
- **Arranque en frío**: espera hasta que la temperatura de la batería esté ≤ 31 °C (`adb shell dumpsys battery | findstr temperature` da décimas de grado: 310 = 31,0 °C). Anota la inicial.
- Misma situación de carga: **o** conectado a un cargador de 10 W **o** con batería ≥ 80 % sin cargador (anótalo; cargar calienta). Misma temperatura ambiente aproximada, sin funda gruesa, sin luz solar directa.
- Brillo fijo, pantalla **encendida**, app en primer plano (el servicio en segundo plano no está implementado), sin otras apps, modo avión opcional (anótalo), «Ahorro de batería» de MIUI = **Sin restricciones** para STARBLITZ.
- Una sola prueba a la vez; deja enfriar entre pruebas (de nuevo ≤ 31 °C).

## 2. Registro durante la prueba

Cada ~2 minutos (o cada 3 páginas) desde el PC con `adb`, y guárdalo en un archivo con la hora:

```bash
adb shell dumpsys battery | findstr /i "level temperature status"
adb shell dumpsys thermalservice | findstr /i "Thermal Status"
adb shell "cat /sys/class/thermal/thermal_zone*/type" && adb shell "cat /sys/class/thermal/thermal_zone*/temp"
adb shell "cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq"
adb shell dumpsys meminfo app.starblitz.mobile | findstr TOTAL
```

**Importante:** `thermal_zone*` y `cpufreq` pueden estar **bloqueados** por Android/MIUI sin root (devolverán «Permission denied» o nada). Si no se pueden leer, **se anota «no
disponible»**: STARBLITZ tampoco inventa esas temperaturas; usa solo el estado térmico de Android y la temperatura de la batería. Un descenso sostenido de `scaling_cur_freq` de los núcleos grandes a
frecuencia constante de carga es la evidencia directa de throttling.

## 3. Exportar el informe al terminar

Menú ⋮ del proyecto → **Exportar informe de rendimiento (JSON)** (guarda en `Descargas/STARBLITZ/`). Lo que se mira:

| Pregunta | Campo |
|---|---|
| ¿El `WebView` está aislado (hilos de WASM)? | `runtime.cross_origin_isolated` (si es `false`, el detector va con 1 hilo: ~3× más lento) |
| ¿Dónde se va el tiempo de visión? (solo B) | `summary.vision_s` (detector, OCR, tramos medios) y `last_job.timings.pages[].vision` |
| Velocidad sostenida | `last_job.timings.pages[]`: `analyze_s + translate_s + clean_s` página a página (¿empeora hacia el final?) |
| Temperatura / batería | `summary.device.battery_temp_c`, `summary.device.battery_pct`, y `pages[].device` página a página |
| Presión y control térmicos (solo B) | `summary.thermal`: `source` (`os` = estado térmico de Android; `battery` = solo batería; `none`), `throttle_samples` (muestras con estado ≥ MODERATE), `max_status`, `max_headroom`, `idle_s`, `pauses`, `idle_max` |
| Memoria | `summary.device.ram_free_mb`, `system_ram_used_max_mb` (+ `dumpsys meminfo`) |
| Errores / omisiones / globos vacíos | revisión visual (ver VALIDACION-FASE4, prueba 3) y `last_job.errors`, `preserved_originals` |

## 4. Métricas y cómo compararlas

| Métrica | Cálculo | Qué buscas |
|---|---|---|
| Tiempo total del capítulo | `summary.total_s` | B ≤ A, o B ligeramente mayor pero **estable** |
| **Velocidad sostenida** | media de los tiempos por página de la **última tercera parte** ÷ media de la **primera tercera parte** | ≈ 1,0 (sin degradación). Si A da > 1,3 y B ≈ 1,0, el control térmico funciona |
| Temperatura máxima de batería | `summary.device.battery_temp_c.max` | B < A |
| Frecuencia de throttling | `summary.thermal.throttle_samples ÷ muestras` | B < A (A no lo registra: usa `dumpsys thermalservice`) |
| Descanso total | `summary.thermal.idle_s + paused_s` ÷ `total_s` | pequeño (< 25 %) si compensa; si es alto sin bajar la temperatura, los parámetros están mal calibrados |
| Batería gastada | `summary.device.battery_pct.drop` | B ≤ A |
| Calidad | revisión de las 27 páginas | **idéntica**: el control térmico no debe cambiar la traducción ni el dibujo |

Repite **cada configuración 2–3 veces** (el primer arranque en frío es el más fiable) y compara medianas; un capítulo aislado no es evidencia.

## 5. Cómo se calibra (qué se ajusta y con qué criterio)

Si B no evita la degradación, o descansa de más, se ajustan **una sola cosa cada vez** (siempre registrada): `maxIdle`, rapidez de subida/bajada (`rise`/`fall`), rampa del margen
térmico (`headroomStart/Full`) o la rampa de batería (solo Android 9). Criterio de éxito: **velocidad sostenida ≈ 1,0 con el menor descanso total posible** y sin pasar a estado ≥ SEVERE.
Mientras no haya esas medidas, **ningún umbral se da por bueno**.

## 6. Limitaciones conocidas

- Android 9 no tiene API térmica: solo batería (lectura gruesa y con retraso). Android 10 (API 29) tiene estado térmico pero **no** margen; el margen es de Android 11 (API 30).
- Los fabricantes pueden no informar de forma útil `getThermalHeadroom` (devuelve NaN → se ignora). El informe indicará la fuente real.
- MIUI puede cerrar la app en segundo plano por su gestor de energía: no es un fallo de este control.
- Sin servicio en primer plano: pantalla encendida durante todas las pruebas.
