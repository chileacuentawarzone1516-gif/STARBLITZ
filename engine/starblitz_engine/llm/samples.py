"""Frases de prueba para comparar modelos con el material real de un manga: modismos, sarcasmo, insultos,
emoción y registro. No hay una «respuesta correcta» automática: la comparación la hace el usuario leyendo
las salidas una al lado de otra, junto con la velocidad medida en su propio equipo.
"""

from __future__ import annotations

SAMPLES: dict[str, list[str]] = {
    "ja": [
        "お前、本気で言ってるのか？ふざけるな！",
        "やれやれ…また面倒なことになりそうだな。",
        "猫の手も借りたいくらい忙しいんだ。",
        "べ、別にあんたのために作ったわけじゃないんだからね！",
        "バカ言うな。そんなの、出来レースに決まってるだろ。",
        "先輩、さっきの……聞こえてました？",
    ],
    "en": [
        "Oh great, because *that* worked out so well last time.",
        "You've got some nerve showing your face here, you little punk.",
        "Break a leg out there. Don't make me regret this.",
        "I'm not crying. It's just... raining inside.",
        "Don't tell me you actually bought that story, genius.",
        "We're gonna need a bigger plan. And fast.",
    ],
}
