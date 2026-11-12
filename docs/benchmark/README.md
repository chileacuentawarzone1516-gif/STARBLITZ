# Benchmark lingüístico común (PC y Android)

Corpus y método para comparar modelos de traducción **con los mismos segmentos, las mismas instrucciones y los mismos criterios** en
STARBLITZ PC y STARBLITZ Android. Diseño completo: [MODELOS-TRADUCCION-PC-ANDROID.md §8](../MODELOS-TRADUCCION-PC-ANDROID.md#8-benchmark-lingüístico-común-pc-y-android).

## `corpus-es419-v1.jsonl`

- **233 segmentos inventados** (sin material con derechos de autor): 122 japonés, 101 inglés (62 en mayúsculas de cómic), 10 coreano.
- **7 capítulos, 29 escenas** en orden, con personajes recurrentes: c1 fantasía (mercenario de Kansai), c2 comedia romántica escolar,
  c3 oficina y yakuza (keigo), c4 terror escolar, c5 superhéroes (mayúsculas), c6 comedia/negro, c7 manhwa de cazadores (coreano).
- **Glosario por capítulo** (58 términos en total) que debe mantenerse idéntico en todas sus escenas.
- SHA-256 de la versión 1 (con finales de línea LF, como se guarda en Git): `e454320320fa1f0c5e4ff37d8ca488aebfdc4f6a66429f2d55ddcb6019889b39`. **No se modifica**: los cambios van a una `v2`.

### Campos

| Campo | Significado |
|---|---|
| `id`, `chapter`, `scene`, `order` | Identificador y posición (las escenas se traducen en orden, como páginas) |
| `lang` | `ja` · `en` · `ko` |
| `speaker`, `speaker_gender`, `addressee`, `register`, `kind` | Quién habla (género `m/f/n/?`), a quién, registro (`informal/formal/vulgar/narrativo`) y tipo (`dialogo/pensamiento/narracion/sfx/cartel`) |
| `text` | Original |
| `tags` | Fenómenos: coloquial, ambiguo, humor, sarcasmo, doble_sentido, modismo, insulto, vulgar, adulto, violencia, pensamiento, narracion, dialogo_largo, continuidad, referencia_cultural, onomatopeya, nombre_propio, termino_glosario, registro_formal/informal, tecnica, texto_cortado, mayusculas |
| `context` | Nota para el evaluador (sentido real, intención, doble sentido, qué hacer con la onomatopeya) |
| `reference_es419` · `alternatives` | Traducción de referencia en español latinoamericano neutro y otras aceptables |
| `must_keep` | Lo que debe aparecer (nombre, término, insulto con su intensidad, cifra) |
| `must_not` | Errores a penalizar (vosotros, españolismos, suavizado, nombre traducido, calco del modismo) |
| `glossary` | Términos obligatorios de ese segmento |

### Limitaciones (léelas antes de citar un resultado)

- Escrito con ayuda de IA y **sin revisar por un traductor nativo latinoamericano**: la referencia orienta al evaluador, no es la única
  respuesta correcta. Se recomienda que el titular revise y corrija una `v2`.
- Pocas muestras de adulto (5), técnica (5), texto cortado (6) y vulgar (8); coreano en una sola escena.
- Algunas etiquetas (continuidad, término de glosario, nombre propio, mayúsculas) se añadieron de forma sistemática: sus recuentos están inflados.
- No sustituye al material real (capítulo en inglés ya evaluado y manga/manhwa del titular, privados y fuera de Git).

## Rúbrica humana (por segmento, ciega)

| Dimensión | Valores |
|---|---|
| Fidelidad | 0 sin error · 1 menor (matiz) · 2 mayor (sentido cambiado, omisión o invención relevante) · 3 crítico (lo contrario, ofensivo sin motivo, ilegible) |
| Naturalidad | 1–5 (¿lo publicaría una editorial latinoamericana?) |
| es-419 | sí / no (motivo: vosotros, españolismo, regionalismo marcado) |
| Contexto y continuidad | correcto / incorrecto (género, referente, registro, glosario) |
| Intensidad | conservada / suavizada / exagerada (insultos, vulgaridad, violencia) |
| Humor y doble sentido | conservado / explicado / perdido (cuando aplica) |

Se informan por separado (errores mayores por 100 segmentos, naturalidad media, % es-419, % contexto). **No se resume en una nota
única ni se declara > 95 % sin esta revisión.**
