"""Catálogo curado de modelos de traducción y perfiles de rendimiento.

Todos los modelos son de pesos abiertos con licencia Apache‑2.0 y están publicados en
Hugging Face en formato GGUF cuantizado (Q4/Q5; las versiones «QAT» de Gemma 4 se entrenaron
ya conscientes de la cuantización a 4 bits, por lo que conservan casi toda la calidad).
Los modelos de TRADUCCIÓN dedicados (Hy‑MT2; también PLaMo 3 Translate si el usuario lo instala desde
la búsqueda, pues su «PLaMo Community License» no es permisiva y no entra en el catálogo curado) usan
el formato de texto plano (`translate/plain.py`). No se recomiendan por defecto hasta medirlos en el teléfono.
Los tamaños son los reales de los archivos en el repositorio (noviembre 2026); antes de
instalar, la app vuelve a consultar el repositorio y verifica tamaño y SHA‑256 del archivo.

Un modelo del catálogo no es obligatorio: el usuario puede buscar y añadir cualquier GGUF de
Hugging Face. El catálogo solo decide qué *recomendar* según el dispositivo.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Tier = Literal["low", "mid", "high", "pc-gpu"]
GIB = 1024 ** 3


@dataclass(frozen=True)
class FileRef:
    path: str
    size: int  # bytes (referencia; se verifica con el repositorio al instalar)


@dataclass(frozen=True)
class CuratedModel:
    id: str
    label: str
    family: str
    params_b: float          # parámetros totales (miles de millones)
    active_b: float          # parámetros activos por token (MoE); = params_b si es denso
    repo: str
    file: FileRef
    mmproj: FileRef | None
    quant: str
    license: str
    context_native: int
    tiers: tuple[Tier, ...]  # perfiles para los que se recomienda
    summary: str
    languages: str = "201 idiomas, incluidos japonés, inglés y español"
    tags: tuple[str, ...] = field(default_factory=tuple)

    @property
    def total_bytes(self) -> int:
        return self.file.size

    def to_dict(self) -> dict:
        return {
            "id": self.id, "label": self.label, "family": self.family, "params_b": self.params_b,
            "active_b": self.active_b, "repo": self.repo, "file": self.file.path, "size": self.file.size,
            "mmproj": self.mmproj.path if self.mmproj else None, "mmproj_size": self.mmproj.size if self.mmproj else 0,
            "quant": self.quant, "license": self.license, "context_native": self.context_native,
            "tiers": list(self.tiers), "summary": self.summary, "languages": self.languages, "tags": list(self.tags),
        }


CATALOG: tuple[CuratedModel, ...] = (
    CuratedModel(
        id="qwen3.5-2b-q4km", label="Qwen 3.5 2B", family="qwen3.5", params_b=2.0, active_b=2.0,
        repo="unsloth/Qwen3.5-2B-GGUF", file=FileRef("Qwen3.5-2B-Q4_K_M.gguf", 1_280_835_840),
        mmproj=FileRef("mmproj-F16.gguf", 668_227_264), quant="Q4_K_M", license="Apache-2.0", context_native=262_144,
        tiers=("low",),
        summary="El más ligero que recomendamos: para móviles de gama baja y equipos sin GPU. Un modelo de 2 000 M de "
                "parámetros es limitado en diálogos largos o con mucho argot; conviene revisar más líneas.",
        tags=("ligero", "móvil"),
    ),
    CuratedModel(
        id="qwen3.5-4b-q4km", label="Qwen 3.5 4B", family="qwen3.5", params_b=4.0, active_b=4.0,
        repo="unsloth/Qwen3.5-4B-GGUF", file=FileRef("Qwen3.5-4B-Q4_K_M.gguf", 2_740_937_888),
        mmproj=FileRef("mmproj-F16.gguf", 672_423_616), quant="Q4_K_M", license="Apache-2.0", context_native=262_144,
        tiers=("mid",),
        summary="Punto de equilibrio para móviles de gama media y portátiles modestos. Familia con especial énfasis en "
                "japonés, chino y coreano; cabe en un teléfono de 6 GB de RAM.",
        tags=("equilibrado", "móvil"),
    ),
    CuratedModel(
        id="hy-mt2-1.8b-q4km", label="Hy-MT2 1.8B (traducción dedicada)", family="hy-mt2",
        params_b=1.8, active_b=1.8, repo="tencent/Hy-MT2-1.8B-GGUF", file=FileRef("Hy-MT2-1.8B-Q4_K_M.gguf", 1_133_080_448),
        mmproj=None, quant="Q4_K_M", license="Apache-2.0", context_native=8_192, tiers=(),
        summary="Modelo de traducción dedicado de Tencent (1,1 GB) con licencia Apache-2.0 y 33 idiomas, incluidos japonés, coreano y español. "
                "En las pruebas en PC fue más fiel y mucho más rápido que Qwen 2B, y menos fiel que PLaMo en japonés. Admite terminología "
                "(glosario). Sin medir aún en el teléfono.",
        languages="33 idiomas (japonés, coreano, inglés, español…)", tags=("traducción dedicada", "licencia permisiva", "móvil"),
    ),
    CuratedModel(
        id="qwen3.5-4b-q5km", label="Qwen 3.5 4B (Q5, más precisión)", family="qwen3.5", params_b=4.0, active_b=4.0,
        repo="unsloth/Qwen3.5-4B-GGUF", file=FileRef("Qwen3.5-4B-Q5_K_M.gguf", 3_143_656_608),
        mmproj=FileRef("mmproj-F16.gguf", 672_423_616), quant="Q5_K_M", license="Apache-2.0", context_native=262_144,
        tiers=(), summary="Misma base que el 4B con cuantización Q5: un 15 % más grande y algo más fiel.",
        tags=("precisión",),
    ),
    CuratedModel(
        id="gemma4-e2b-qat", label="Gemma 4 E2B (QAT 4 bits)", family="gemma4", params_b=5.1, active_b=2.3,
        repo="google/gemma-4-E2B-it-qat-q4_0-gguf", file=FileRef("gemma-4-E2B_q4_0-it.gguf", 3_349_516_256),
        mmproj=FileRef("gemma-4-E2B-it-mmproj.gguf", 986_833_664), quant="Q4_0 (QAT)", license="Apache-2.0",
        context_native=131_072, tiers=(),
        summary="Modelo compacto de Google entrenado ya para 4 bits (QAT), que conserva más calidad que una "
                "cuantización posterior. Ocupa más disco que su tamaño efectivo por sus tablas de embeddings.",
        languages="Multilingüe (incluye japonés, inglés y español)", tags=("ligero", "móvil", "oficial"),
    ),
    CuratedModel(
        id="gemma4-e4b-qat", label="Gemma 4 E4B (QAT 4 bits)", family="gemma4", params_b=7.5, active_b=4.5,
        repo="google/gemma-4-E4B-it-qat-q4_0-gguf", file=FileRef("gemma-4-E4B_q4_0-it.gguf", 5_154_941_280),
        mmproj=FileRef("gemma-4-E4B-it-mmproj.gguf", 991_552_256), quant="Q4_0 (QAT)", license="Apache-2.0",
        context_native=131_072, tiers=(),
        summary="Alternativa de Google a Qwen 4B (QAT de 4 bits). Más pesada en disco; compárala con Qwen 4B en tu "
                "propio material con «Comparar modelos».",
        languages="Multilingüe (incluye japonés, inglés y español)", tags=("oficial",),
    ),
    CuratedModel(
        id="qwen3.5-9b-q4km", label="Qwen 3.5 9B", family="qwen3.5", params_b=9.0, active_b=9.0,
        repo="unsloth/Qwen3.5-9B-GGUF", file=FileRef("Qwen3.5-9B-Q4_K_M.gguf", 5_680_522_464),
        mmproj=FileRef("mmproj-F16.gguf", 918_166_080), quant="Q4_K_M", license="Apache-2.0", context_native=262_144,
        tiers=("high", "pc-gpu"),
        summary="Recomendado para PC con GPU de 6–8 GB y móviles de gama alta (10 GB de RAM o más): el mayor modelo "
                "denso que cabe cómodamente en esa memoria. Familia con especial énfasis en japonés, chino y coreano.",
        tags=("recomendado",),
    ),
    CuratedModel(
        id="gemma4-12b-qat", label="Gemma 4 12B (QAT 4 bits)", family="gemma4", params_b=12.0, active_b=12.0,
        repo="google/gemma-4-12B-it-qat-q4_0-gguf", file=FileRef("gemma-4-12b-it-qat-q4_0.gguf", 6_975_879_296),
        mmproj=FileRef("mmproj-gemma-4-12b-it-qat-q4_0.gguf", 175_115_616), quant="Q4_0 (QAT)", license="Apache-2.0",
        context_native=131_072, tiers=("pc-gpu",),
        summary="Modelo de Google (QAT de 4 bits) para PC con 10 GB de VRAM o más. Compáralo con Qwen 9B en tu propio "
                "material con «Comparar modelos».",
        languages="Multilingüe (incluye japonés, inglés y español)", tags=("calidad", "oficial"),
    ),
    CuratedModel(
        id="gemma4-26b-a4b-qat", label="Gemma 4 26B‑A4B (MoE, QAT 4 bits)", family="gemma4", params_b=26.0, active_b=4.0,
        repo="google/gemma-4-26B-A4B-it-qat-q4_0-gguf", file=FileRef("gemma-4-26B_q4_0-it.gguf", 14_439_363_584),
        mmproj=FileRef("gemma-4-26B-it-mmproj.gguf", 1_194_828_160), quant="Q4_0 (QAT)", license="Apache-2.0",
        context_native=262_144, tiers=("pc-gpu",),
        summary="El modelo más grande del catálogo. Mezcla de expertos: solo 4 000 M de parámetros activos por token, "
                "así que es ágil para su tamaño, pero ocupa ~14 GB (necesita ~16 GB de VRAM, o GPU parcial con 32 GB de RAM).",
        languages="Multilingüe (incluye japonés, inglés y español)", tags=("máxima calidad", "oficial"),
    ),
)

BY_ID: dict[str, CuratedModel] = {m.id: m for m in CATALOG}


# ---------------------------------------------------------------------------
# Perfiles de rendimiento
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Profile:
    id: Tier
    label: str
    description: str
    context: int            # ventana de contexto con la que se trabaja
    vision_llm: bool        # enviar la imagen de la página al modelo
    quality: Literal["max", "balanced"]   # dos pasadas (traductor + corrector) o una
    ocr_japanese: Literal["manga-ocr", "ppocr"]
    inpaint: Literal["lama", "fast"]
    default_model: str


PROFILES: dict[Tier, Profile] = {
    "low": Profile("low", "Gama baja", "Móvil con ≤ 5 GB de RAM o PC sin GPU y con poca memoria. "
                   "Una sola pasada de traducción y OCR ligero.", 4096, False, "balanced", "ppocr", "fast", "qwen3.5-2b-q4km"),
    "mid": Profile("mid", "Gama media", "Móvil con 6–8 GB de RAM o portátil sin GPU dedicada.", 6144, False, "balanced",
                   "manga-ocr", "fast", "qwen3.5-4b-q4km"),
    "high": Profile("high", "Gama alta", "Móvil con 10 GB de RAM o más, o PC con mucha RAM sin GPU dedicada.", 8192, False, "max",
                    "manga-ocr", "fast", "qwen3.5-9b-q4km"),
    "pc-gpu": Profile("pc-gpu", "PC con GPU dedicada", "Equipo con tarjeta gráfica de 6 GB de VRAM o más.", 12288, True, "max",
                      "manga-ocr", "lama", "qwen3.5-9b-q4km"),
}


def classify(ram_gb: float, vram_gb: float, *, mobile: bool = False) -> Tier:
    """Perfil de un dispositivo a partir de su memoria.

    En móviles se usa la RAM total que informa Android (un teléfono de «8 GB» informa ~7,4 GB;
    de «12 GB», ~11,2 GB). En PC cuenta la VRAM de la GPU dedicada y, sin ella, la RAM.
    """
    if mobile:
        if ram_gb >= 10.5:
            return "high"
        if ram_gb >= 6.5:
            return "mid"
        return "low"
    if vram_gb >= 5.5:
        return "pc-gpu"
    if ram_gb >= 24:
        return "high"
    if ram_gb >= 11:
        return "mid"
    return "low"


def pick_default(tier: Tier, vram_gb: float = 0.0) -> str:
    """Modelo recomendado para el perfil; en PC con mucha VRAM sube de escalón."""
    if tier == "pc-gpu":
        if vram_gb >= 18:
            return "gemma4-26b-a4b-qat"
        if vram_gb >= 10:
            return "gemma4-12b-qat"
    return PROFILES[tier].default_model


# ---------------------------------------------------------------------------
# Compatibilidad con el dispositivo
# ---------------------------------------------------------------------------

# Fracción de caché KV respecto a un transformador denso clásico. Qwen 3.5 usa atención lineal en la
# mayoría de capas y Gemma 4 atención de ventana deslizante, así que su caché es mucho menor.
ARCH_KV_FACTOR = {"qwen35": 0.3, "qwen3": 1.0, "gemma4": 0.4, "gemma3": 0.4, "llama": 1.0}


def estimate_memory_gb(size_bytes: int, params_b: float, context: int, mmproj_bytes: int = 0,
                       arch: str = "") -> float:
    """Memoria necesaria: pesos + caché KV (aprox. proporcional a parámetros y contexto) + búferes de cálculo."""
    weights = size_bytes / GIB
    kv = (context / 1000) * 0.018 * max(params_b, 0.5) * ARCH_KV_FACTOR.get(arch, 1.0)
    return weights + kv + mmproj_bytes / GIB + 0.6


def fit_model(need_gb: float, ram_gb: float, vram_gb: float, *, mobile: bool = False) -> dict:
    """¿Cabe y con qué velocidad? ``fits`` ∈ gpu | hybrid | cpu | no, con una explicación para el usuario."""
    reserve = 2.5 if mobile else 4.0  # sistema operativo, interfaz y modelos de visión
    usable_ram = max(0.0, ram_gb - reserve)
    base = {"need_gb": round(need_gb, 1), "tight": False}
    if not mobile and vram_gb > 0 and need_gb <= vram_gb - 0.4:
        return {**base, "fits": "gpu", "speed": "fast", "tight": need_gb > (vram_gb - 0.4) * 0.92,
                "note": "Cabe entero en la memoria de la GPU: velocidad máxima."}
    if not mobile and vram_gb >= 3 and need_gb <= vram_gb + usable_ram:
        return {**base, "fits": "hybrid", "speed": "medium",
                "note": "Parte del modelo irá a la RAM del sistema: funciona, pero más lento que en GPU."}
    if need_gb <= usable_ram:
        slow = need_gb > 3.5
        where = "el procesador del teléfono" if mobile else "el procesador"
        return {**base, "fits": "cpu", "speed": "slow" if slow else "medium", "tight": need_gb > usable_ram * 0.85,
                "note": f"Se ejecutará en {where}" + (": cada página tardará varios minutos." if slow else ".")}
    have = usable_ram + (0.0 if mobile else max(vram_gb, 0.0))
    return {**base, "fits": "no", "speed": "none",
            "note": f"Necesita ~{need_gb:.1f} GB y este dispositivo dispone de ~{have:.1f} GB utilizables."}


# ---------------------------------------------------------------------------
# Licencias
# ---------------------------------------------------------------------------

_PERMISSIVE = ("apache-2.0", "mit", "bsd-3-clause", "bsd-2-clause", "isc", "unlicense", "cc0-1.0", "cc-by-4.0", "openrail++")
_WITH_TERMS = ("gemma", "llama", "openrail", "bigscience", "cc-by-sa", "mistral", "other", "creativeml", "deepseek", "qwen")
_RESTRICTED = ("nc", "research", "non-commercial", "noncommercial")


def license_info(license_id: str) -> dict:
    """Clasifica la licencia de un modelo: permisiva, con condiciones de uso o restringida/desconocida."""
    lic = (license_id or "").lower().strip()
    if not lic or lic == "desconocida":
        return {"id": license_id or "desconocida", "class": "unknown",
                "note": "El repositorio no declara su licencia: revisa la ficha del modelo antes de usarlo."}
    if any(k in lic for k in _RESTRICTED):
        return {"id": license_id, "class": "restricted",
                "note": "Licencia con restricciones (p. ej. no comercial o solo investigación). Válida para uso personal; no para publicar de forma comercial."}
    if lic in _PERMISSIVE:
        return {"id": license_id, "class": "permissive", "note": "Licencia permisiva: uso libre, también comercial."}
    if any(k in lic for k in _WITH_TERMS):
        return {"id": license_id, "class": "terms",
                "note": "Pesos abiertos con condiciones de uso propias del autor: lee los términos en su ficha."}
    return {"id": license_id, "class": "unknown", "note": "Licencia poco habitual: revisa la ficha del modelo."}
