# Hoja de ruta

Leyenda de estado: 🔨 compilado · 🧪 pruebas automáticas o simuladas · ✅ verificado en hardware real · ⏳ pendiente.
**Hoy no hay nada marcado como ✅.** Esta página no promete fechas.

## Estado actual (v1.0.0, sin publicar)

| Área | Estado |
|---|---|
| Motor Python (importación, visión, OCR, traducción, reconstrucción) | 🧪 |
| Desktop: versión portátil | 🔨 (generada en el equipo del titular) |
| Desktop: instalador NSIS | ⏳ no generado ni probado |
| Desktop en Windows con GPU y modelos reales | ⏳ |
| Mobile: motor TypeScript, E2E en Chromium | 🧪 |
| Mobile: APK compilado e instalado | ⏳ |
| Mobile: `llama-server` arm64 en teléfono real | ⏳ |
| Calidad de traducción con modelos reales | ⏳ sin medir |

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
| Medición por etapa y por página | 🧪 implementada; ⏳ falta medir en el Redmi Note 8 Pro |
| Cola multi-proyecto, caché de OCR/traducción, concurrencia por RAM | ⏳ |
| Segundo plano en Android (servicio en primer plano) | ⏳ diseño |
| Estilo visual del texto | ⏳ diseño |
| Actualizador integrado | 🧪 comparación de versiones y validación del manifiesto; ⏳ descarga e instalación (decisiones pendientes) |
| Comparativa de modelos de OCR y traducción | ⏳ metadatos recopilados; sin mediciones ni ganador |

## Limitaciones conocidas que podrían abordarse

Tomadas de [LIMITACIONES](LIMITACIONES.md); no son compromisos:

- Onomatopeyas (SFX): hoy se detectan y se pueden traducir como nota, pero no se borran por defecto.
- Rotulación sin texto curvo ni formas en espiral.
- Historial persistente de correcciones por texto.
- Android: servicio en primer plano para procesar con la app en segundo plano; aceleración por GPU.
- Evaluación con páginas reales de chino, coreano, inglés y lenguas latinas.
- Almacenamiento cifrado del token opcional de Hugging Face.
