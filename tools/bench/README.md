# Banco de pruebas de traducción (reproducible)

Compara modelos de traducción GGUF con el mismo `llama-server` que usa STARBLITZ (versión b12017, la misma en Windows y Android).

| Archivo | Qué es |
|---|---|
| `corpus_ja_ko.jsonl` | 56 segmentos **inventados** (36 japonés, 20 coreano; sin material con derechos de autor) en 10 categorías: normal, coloquial, insulto, doble sentido, humor, incompleta, onomatopeya, adulto, violencia, terminología. Cada uno lleva una traducción de referencia y listas de **contenido que debe conservarse** (`keep`: insultos, términos adultos o violentos, nombres y glosario) |
| `bench_translate.py` | Arranca `llama-server`, traduce el corpus con el perfil indicado y mide tiempo, tokens, RAM máxima y comprobaciones automáticas de fidelidad. Guarda **todas las salidas** para revisión humana |
| `run_matrix.py` | Ejecuta la matriz completa (secuencial, para no falsear tiempos) |
| `report_md.py` | Resume los resultados en Markdown (tabla y, con `--items`, todas las salidas) |
| `results/` | Resultados crudos (JSON) de las ejecuciones citadas en [BENCHMARK-TRADUCCION](../../docs/BENCHMARK-TRADUCCION.md) |

## Uso

```bash
pip install psutil
python bench_translate.py --server /ruta/llama-server --model /ruta/modelo.gguf --profile hymt2 --mode batch --gloss --out r.json
python run_matrix.py --server /ruta/llama-server --models /carpeta/con/gguf --out resultados --threads 6
python report_md.py resultados/*.json --items --fails > informe.md
```

Perfiles: `qwen` (instrucción genérica de fidelidad), `hymt2` (instrucción nativa de Hy-MT2), `plamo` (plantilla nativa de PLaMo 3
Translate), `app` (el prompt y el esquema JSON **reales** de STARBLITZ actuales; la «página» es la escena, sin contexto de páginas
vecinas, así que es un límite inferior del coste real). Modos: `per` (una llamada por segmento) y `batch` (una por escena, líneas
numeradas); `--gloss` añade el glosario de la escena.

## Qué mide y qué no (léelo antes de citar un número)

- **Mide** con reloj de pared y con los contadores del propio `llama-server`: tiempo, tokens de entrada y salida, tokens/s y RAM máxima del
  proceso. Los **recuentos de tokens son independientes del dispositivo**; los **tiempos y la RAM son del equipo donde se ejecuta**.
- **Ejecútalo en el Redmi Note 8 Pro** (p. ej. con Termux y el `llama-server` arm64 de `apps/mobile/android/app/vendor`) para obtener sus
  tiempos; hasta entonces los tiempos de un PC **no representan** al teléfono. Con `--phone-prefill-tps` y `--phone-gen-tps` (medidos en el
  teléfono) se obtiene una **proyección** claramente etiquetada como tal.
- Las comprobaciones automáticas son **heurísticas** (palabras esperadas, longitud, texto sin traducir, negativas). Detectan omisiones,
  suavizados y rechazos; **no puntúan naturalidad ni calidad literaria**. Eso exige a una persona que lea el idioma: revisa
  `items[].out` en los JSON.
- El corpus es pequeño y propio: sirve para **comparar** y detectar fallos graves, no para publicar una nota absoluta de calidad.
