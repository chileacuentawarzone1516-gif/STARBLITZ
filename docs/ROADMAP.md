# Hoja de ruta

Leyenda de estado: 🔨 compilado · 🧪 pruebas automáticas o simuladas · ✅ verificado en hardware real · ⏳ pendiente.
**Hoy no hay nada marcado como ✅.** Esta página no promete fechas.

## Estado actual (v1.0.0, sin publicar)

| Área | Estado |
|---|---|
| Motor Python (importación, visión, OCR, traducción, reconstrucción) | 🧪 + capítulo real en PC (CPU) con Qwen3.5-4B: [EVALUACION-CORPUS-USM](EVALUACION-CORPUS-USM.md) |
| Desktop: versión portátil | 🔨 (generada en el equipo del titular) |
| Desktop: instalador NSIS | 🔨 generado e instalado/desinstalado en el runner Windows de CI (`windows.yml` #1, `a35c252`); ⏳ en un PC real |
| Desktop en Windows con GPU y modelos reales | ⏳ |
| Mobile: motor TypeScript, E2E en Chromium | 🧪 |
| Mobile: APK compilado | 🔨 en CI con clave **desechable** (`android.yml`, verificación estática); ⏳ instalado en un teléfono real |
| Mobile: `llama-server` arm64 en teléfono real | ⏳ |
| Calidad de traducción con modelos reales | ⏳ sin evaluación humana (revisión preliminar no nativa en [EVALUACION-CORPUS-USM](EVALUACION-CORPUS-USM.md)) |
| Repositorio de código | **público** (comprobado 2026-11-09); rama `test/windows-ci`; sin `main`, sin Releases |

## Próximos hitos de entrega

1. ⏳ Ejecutar la lista de [PRUEBAS-HARDWARE](PRUEBAS-HARDWARE.md) en equipos reales y documentar los resultados.
2. ⏳ Compilar el APK firmado y generar el instalador de Windows; publicar Releases con SHA-256 (ver [COMPILAR](COMPILAR.md)).
3. ⏳ Medir calidad de traducción con material propio y modelos reales.
4. ⏳ Capturas verificadas de la interfaz para el README.
5. ⏳ Confirmar la licencia del proyecto y el logo oficial del repositorio.
6. ⏳ Decidir la firma de código del ejecutable de Windows.

## Mejora del motor de traducción (en curso)

Detalle y estado por etapa en [MOTOR-AUDITORIA](MOTOR-AUDITORIA.md), [MODELOS-INVESTIGACION](MODELOS-INVESTIGACION.md) y
[DISENO-FASES-5-7](DISENO-FASES-5-7.md).

| Etapa | Estado |
|---|---|
| Protección de diálogos (no borrar sin traducción válida; OCR vacío visible) | 🧪 implementada y probada con piezas simuladas; ⏳ falta en el teléfono |
| Medición por etapa y por página + informe JSON exportable | 🧪 implementada; ⏳ falta medir en el Redmi Note 8 Pro ([protocolo](VALIDACION-FASE4-ANDROID.md)) |
| Cola persistente, caché de OCR y de traducciones, concurrencia por RAM, liberación de memoria (móvil) | 🧪 implementada y probada con piezas simuladas; ⏳ sin medir en el teléfono; ⏳ aviso de la cola en la interfaz |
| Control térmico adaptativo (estado/margen térmico de Android) | 🧪 implementado y probado con señales simuladas; ⏳ sin calibrar ni medir en el teléfono ([protocolo](VALIDACION-TERMICA-ANDROID.md)) |
| Auditoría de la visión (cuello de botella: detector de texto) | 🧪 medida en PC; ⏳ falta el desglose en el Redmi ([OPTIMIZACION-ANDROID](OPTIMIZACION-ANDROID.md)) |
| Detector ligero PP-OCRv6 Manga (**experimental**, desactivado por defecto) | 🧪 integrado detrás de un ajuste y comparado con un capítulo real en PC ([DETECTOR-EXPERIMENTAL](DETECTOR-EXPERIMENTAL.md)); ⏳ manga/manhwa reales (ja/ko) |
| Escritorio en CPU: números desnormalizados en el detector por defecto | ✅ corregido (salida idéntica bit a bit, ~100× más rápido en CPU; ver [EVALUACION-CORPUS-USM](EVALUACION-CORPUS-USM.md)) |
| PLaMo 3 Translate | retirado del código (D3: no autorizado) |
| Segundo plano en Android (servicio en primer plano) | ⏳ diseño (no implementado) |
| Estilo visual del texto | ⏳ diseño |
| Actualizador integrado | 🧪 comparación de versiones y validación del manifiesto; ⏳ descarga e instalación (decisiones pendientes) |
| Comparativa de modelos de traducción | 🧪 medida en PC (CPU) con corpus propio, 4 familias; ⏳ sin medir en el teléfono ni evaluada por personas; sin modelo por defecto nuevo ([BENCHMARK](BENCHMARK-TRADUCCION.md)) |
| Traducción en texto plano por lotes (modelos dedicados) | 🧪 implementada (móvil y PC) y probada con modelo simulado; ⏳ falta medir en el teléfono |
| Comparativa de modelos de OCR | ⏳ metadatos recopilados; sin mediciones |

## Limitaciones conocidas que podrían abordarse

Tomadas de [LIMITACIONES](LIMITACIONES.md); no son compromisos:

- Onomatopeyas (SFX): hoy se detectan y se pueden traducir como nota, pero no se borran por defecto.
- Rotulación sin texto curvo ni formas en espiral.
- Historial persistente de correcciones por texto.
- Android: servicio en primer plano para procesar con la app en segundo plano; aceleración por GPU.
- Evaluación con páginas reales de chino, coreano, inglés y lenguas latinas.
- Almacenamiento cifrado del token opcional de Hugging Face.
