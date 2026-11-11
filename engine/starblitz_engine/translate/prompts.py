"""Instrucciones y esquemas del traductor contextual.

El diseño sigue el flujo de una editorial: un traductor que lee la obra
completa con contexto (personajes, glosario, lo ocurrido, la página siguiente
y la imagen de la escena) y un corrector que revisa fidelidad y naturalidad.
"""

from __future__ import annotations

LANG_NAMES = {
    "ja": "japonés", "en": "inglés", "zh": "chino simplificado", "zh-hant": "chino tradicional", "ko": "coreano",
    "fr": "francés", "it": "italiano", "pt": "portugués", "de": "alemán",
}

VARIANTS = {
    "es-419": (
        "español latinoamericano neutro",
        "Usa «ustedes» (nunca «vosotros» ni sus formas: «tenéis», «id», «os», «vuestro»), vocabulario comprensible en toda Latinoamérica y evita regionalismos "
        "marcados (nada de «vale», «tío», «guay», «che», «güey», «pana»). Tuteo por defecto entre jóvenes y amigos; "
        "«usted» cuando el original marque respeto o distancia.",
    ),
    "es-ES": (
        "español de España",
        "Usa «vosotros» para la segunda persona del plural y expresiones naturales del español peninsular, "
        "sin abusar de coloquialismos. «Usted» cuando el original marque respeto o distancia.",
    ),
}

HONORIFICS = {
    "adapt": (
        "Honoríficos japoneses (-san, -kun, -chan, -sama, senpai, sensei): adáptalos al trato natural en español "
        "(tú/usted, nombre de pila, «señor/señora», «profe», «jefe») según la relación. Consérvalos solo si forman "
        "parte de un apodo o tienen peso en la historia; en ese caso marca la línea con «honorific»."
    ),
    "keep": (
        "Conserva los honoríficos japoneses unidos al nombre con guion (Tanaka-san, Hina-chan, senpai, sensei) "
        "y adapta el resto del trato al español."
    ),
}

# Perfiles de traducción: cambian el criterio (no el significado) con el que se traduce. Cada uno es
# (nombre, descripción corta para la interfaz, instrucción para el modelo). `natural` es el comportamiento por defecto.
PROFILES: dict[str, tuple[str, str, str]] = {
    "natural": (
        "Natural",
        "Equilibrado: suena a español nativo y adapta modismos y humor sin perder el significado.",
        "PERFIL DE TRADUCCIÓN «Natural»: equilibra fidelidad y fluidez. Adapta modismos, refranes y bromas a equivalentes "
        "españoles con el mismo efecto y evita los calcos.",
    ),
    "fiel": (
        "Fiel",
        "Se mantiene cerca del original: estructura, orden de las ideas y matices, con la mínima reescritura.",
        "PERFIL DE TRADUCCIÓN «Fiel»: mantente lo más cerca posible del texto original. Conserva el orden de las ideas, la "
        "estructura de las frases, el nivel de formalidad y los matices; reescribe solo lo imprescindible para que sea "
        "gramatical y se entienda. Traduce los modismos por su equivalente más próximo, sin embellecer ni acortar. "
        "Prioridad: fidelidad sobre naturalidad.",
    ),
    "coloquial": (
        "Coloquial",
        "Habla cotidiana y cercana: frases cortas, tuteo, interjecciones y muletillas naturales.",
        "PERFIL DE TRADUCCIÓN «Coloquial»: usa un registro cotidiano y cercano, como habla la gente en la calle: frases "
        "cortas, tuteo, interjecciones y muletillas naturales, sin tono libresco ni palabras rebuscadas. Respeta lo que "
        "permite la variante de español elegida: no introduzcas jerga marcada de un solo país.",
    ),
    "formal": (
        "Formal",
        "Registro cuidado: trato de usted, vocabulario culto sin ser rebuscado y sin jerga.",
        "PERFIL DE TRADUCCIÓN «Formal»: usa un registro formal y cuidado. Trato de «usted» salvo que el original marque "
        "confianza explícita, vocabulario culto sin ser rebuscado, frases completas y sin jerga ni coloquialismos. "
        "Mantén el carácter de cada personaje dentro de ese registro.",
    ),
    "adaptacion": (
        "Adaptación narrativa",
        "Prioriza el efecto en el lector (ritmo, humor, dramatismo) sobre la literalidad; sin cambiar los hechos.",
        "PERFIL DE TRADUCCIÓN «Adaptación narrativa»: prioriza el efecto sobre el lector (ritmo, humor, dramatismo y voz de "
        "cada personaje) por encima de la literalidad. Puedes reestructurar frases y sustituir chistes o referencias que no "
        "funcionen en español por equivalentes culturales con el mismo efecto. Nunca cambies hechos, nombres ni relaciones "
        "entre personajes, ni añadas información nueva.",
    ),
}
DEFAULT_PROFILE = "natural"

KIND_LABELS = {
    "dialogue": "diálogo", "thought": "pensamiento", "narration": "narración/cartela",
    "sfx": "onomatopeya", "other": "texto en escena: cartel o nota",
}

TRANSLATOR_SYSTEM = """Eres un traductor y adaptador profesional de manga y cómic al {variant_name}. Trabajas para una editorial: el resultado debe leerse como si la obra se hubiera escrito originalmente en español, nunca como una traducción automática.

Principios, por orden de prioridad:
1. FIDELIDAD: conserva exactamente el significado, la información y la intención de cada texto. No añadas, no omitas y no inventes nada que no esté en el original. No expliques chistes ni añadas notas dentro de la traducción. Es una obra de ficción: reproduce con la misma fuerza los insultos, groserías, violencia o escenas adultas del original; no los suavices, no los censures y no añadas avisos ni comentarios.
2. NATURALIDAD: escribe lo que diría un hablante nativo en esa situación. Sustituye modismos, refranes, juegos de palabras y bromas por equivalentes españoles con el mismo efecto. Evita calcos y construcciones literales («¿Es así?», «Como esperaba de…», «¡Lo haré lo mejor posible!» cuando suenan forzadas).
3. VOZ DEL PERSONAJE: respeta personalidad, edad, registro (formal o coloquial, tú o usted) y muletillas, con coherencia en todo el capítulo.
4. TONO Y EMOCIÓN: transmite humor, sarcasmo, ironía, enfado, ternura o tensión. Si hay sarcasmo o doble sentido, que también se note en español.
5. COHERENCIA: usa SIEMPRE los nombres y términos del glosario y de la lista de personajes. Mantén la continuidad con las páginas anteriores. Los NOMBRES PROPIOS de personas, lugares (ciudades, barrios, calles), empresas, marcas y títulos NO se traducen: cópialos tal cual («Brooklyn», «Shinjuku», «Kim Min-ji», «Acme Corp.»), salvo que el glosario diga otra cosa.
6. LETRISMO: frases claras y de longitud similar al original; respeta el límite orientativo de caracteres del globo si es posible sin perder significado. Ortografía y puntuación españolas (¿?, ¡!, puntos suspensivos «…», raya de diálogo no se usa en globos). Mantén los gritos, titubeos («¿Q-qué…?») y alargamientos con recursos naturales del español.
7. GÉNERO: concuerda adjetivos, participios y pronombres con el género de quien habla y de a quién se habla (lista de PERSONAJES, imagen y contexto). Si no se sabe, usa una forma que no marque género.

{variant_rules}
{honorifics}
{profile_rules}
Onomatopeyas (tipo «onomatopeya»): tradúcelas por una onomatopeya española equivalente y breve (p. ej. «¡PUM!», «Ñam», «Glup»); si es un efecto sin equivalente, describe el sonido en una o dos palabras.

AMBIGÜEDAD Y ERRORES: si un texto admite varias interpretaciones y el contexto no basta, elige la más probable, baja «confidence» (0–1) y explica la duda brevemente en «note». Si el texto reconocido parece un error de OCR (caracteres sin sentido, palabras incompletas), NO inventes: traduce lo que se entiende, añade la marca «ocr_suspect» y, solo si la imagen o el contexto lo dejan claro, escribe la lectura correcta del original en «source_fix».

Marcas posibles en «flags»: idiom (expresión idiomática adaptada), wordplay (juego de palabras), sarcasm, honorific, cultural (referencia cultural), ambiguous, ocr_suspect.
Responde únicamente con el JSON pedido."""

REVIEWER_SYSTEM = """Eres el corrector de estilo de una editorial de manga y cómic en {variant_name}. Revisas la traducción de un compañero frente al original, línea por línea.

Para cada línea comprueba:
- Fidelidad: ¿conserva exactamente el significado? ¿Añade, omite o inventa algo? Si es así, corrígelo.
- Naturalidad: ¿suena a español nativo o a traducción? Reescribe calcos, literalidades y expresiones forzadas.
- Voz, tono y emoción del personaje; coherencia con el glosario, los nombres y lo anterior.
- Longitud adecuada al globo (límite orientativo de caracteres).
- Ortografía y puntuación españolas.
{variant_rules}
{profile_rules}
Si una línea ya es correcta y natural, devuélvela IGUAL (no cambies por cambiar). Nunca añadas información que no esté en el original. No suavices ni censures el tono del original.
En «issue» explica en pocas palabras qué corregiste (vacío si nada). Ajusta «confidence» (0–1) a tu seguridad final.
Responde únicamente con el JSON pedido."""

SUMMARY_NOTE = "Resume en una o dos frases, en español, qué ocurre en esta página (hechos y quién habla), sin juicios."

FLAG_ENUM = ["idiom", "wordplay", "sarcasm", "honorific", "cultural", "ambiguous", "ocr_suspect"]

TRANSLATION_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "n": {"type": "integer"},
                    "src_start": {"type": "string"},
                    "translation": {"type": "string"},
                    "speaker": {"type": "string"},
                    "emotion": {"type": "string"},
                    "confidence": {"type": "number"},
                    "flags": {"type": "array", "items": {"type": "string", "enum": FLAG_ENUM}},
                    "note": {"type": "string"},
                    "source_fix": {"type": "string"},
                },
                "required": ["n", "src_start", "translation", "speaker", "emotion", "confidence", "flags", "note", "source_fix"],
            },
        },
        "new_terms": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"source": {"type": "string"}, "target": {"type": "string"}, "note": {"type": "string"}},
                "required": ["source", "target", "note"],
            },
        },
        "characters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "source": {"type": "string"}, "target": {"type": "string"},
                    "gender": {"type": "string", "enum": ["m", "f", "n", "?"]}, "speech": {"type": "string"},
                },
                "required": ["source", "target", "gender", "speech"],
            },
        },
        "page_summary": {"type": "string"},
    },
    "required": ["items", "new_terms", "characters", "page_summary"],
}

REVIEW_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "n": {"type": "integer"},
                    "final": {"type": "string"},
                    "issue": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": ["n", "final", "issue", "confidence"],
            },
        }
    },
    "required": ["items"],
}

# Frase que se añade a la petición de traducción: el eco del original permite comprobar que cada traducción es de SU texto.
ECHO_NOTE = ("En «src_start» copia literalmente las 3 primeras palabras del ORIGINAL de ese número (sirve para comprobar que "
             "ninguna traducción se cambia de globo).")
REPAIR_HEADER = ("CORRIGE ESTOS TEXTOS DE LA PÁGINA {page} (cada uno lleva el problema detectado en la traducción anterior). "
                 "Traduce SOLO estos números, solo lo que dice cada original y sin mirar la página siguiente:")
# Recuperación cuando la respuesta de la página entera no era JSON válido: cada texto que faltó se pide SOLO, con su número.
RECOVER_HEADER = ("TRADUCE SOLO ESTE TEXTO DE LA PÁGINA {page} (la respuesta anterior de la página llegó incompleta). "
                  "Traduce solo lo que dice este original:")
RECOVER_NOTE = "Devuelve un único elemento en «items», con «n» = {n}. {echo} En «page_summary» deja una cadena vacía."
RECOVER_MAX_SEGMENTS = 24   # textos que se intentan recuperar uno a uno por página (el resto se conserva en el original)
RECOVER_ATTEMPTS = 2        # intentos por texto
RECOVER_MAX_TOKENS = 512    # un solo elemento cabe de sobra; corta enseguida un posible bucle de repetición

# Reformulación breve: traducciones más largas de lo que cabe en su globo (capacidad estimada con el cuerpo mínimo del
# maquetador). Una llamada por página; la respuesta solo se usa si es de verdad más corta y no pierde nombres ni contenido.
SHORTEN_HEADER = ("ESTAS TRADUCCIONES DE LA PÁGINA {page} NO CABEN EN SU GLOBO. Reescribe cada una más corta, como máximo con "
                  "los caracteres indicados, conservando TODO su significado, el tono, la persona que habla y los nombres "
                  "propios: usa sinónimos más cortos, quita repeticiones o muletillas que no aporten y reestructura la frase. "
                  "No omitas información, no cambies los hechos y no la conviertas en un resumen. Si no se puede acortar sin "
                  "perder significado, devuelve la traducción IGUAL. En «issue» explica en pocas palabras qué cambiaste.")
SHORTEN_MIN_KEEP = 0.55     # la versión corta conserva al menos este tanto de las letras de la traducción (no es un resumen)
SHORTEN_MAX_RATIO = 0.97    # y es al menos un 3 % más corta (si no, no compensa cambiarla)
