"""Catálogo de modelos de visión (no LLM) con origen, licencia e integridad.

Cada archivo grande se verifica con SHA-256 tras la descarga. Los LLM se
gestionan aparte, a través de Ollama u otro servidor local compatible.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

HF = "https://huggingface.co"


@dataclass(frozen=True)
class ModelFile:
    rel_path: str
    urls: tuple[str, ...]
    sha256: str | None = None
    approx_mb: float = 0.0


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str
    purpose: str
    description: str
    license: str
    homepage: str
    files: tuple[ModelFile, ...]
    required: bool = False
    languages: tuple[str, ...] = field(default_factory=tuple)

    @property
    def approx_mb(self) -> float:
        return round(sum(f.approx_mb for f in self.files), 1)

    def directory(self, models_root: Path) -> Path:
        return models_root / self.id

    def is_installed(self, models_root: Path) -> bool:
        base = self.directory(models_root)
        return all((base / f.rel_path).is_file() for f in self.files)


REGISTRY: dict[str, ModelSpec] = {
    spec.id: spec
    for spec in (
        ModelSpec(
            id="text-detector",
            label="Detector de texto para cómics (comic-text-detector)",
            purpose="detection",
            description="Localiza globos, líneas de texto verticales y horizontales y genera la máscara de texto.",
            license="GPL-3.0 (pesos del proyecto comic-text-detector)",
            homepage="https://github.com/dmMaze/comic-text-detector",
            required=True,
            files=(
                ModelFile(
                    "comictextdetector.onnx",
                    ("https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt.onnx",),
                    "1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f",
                    94.7,
                ),
            ),
        ),
        ModelSpec(
            id="text-detector-manga",
            label="Detector ligero PP-OCRv6 Manga (EXPERIMENTAL)",
            purpose="detection",
            description="Detector de LÍNEAS de texto de 1,8 MB. Experimental: solo se usa si lo activas en Ajustes → Procesamiento. "
                        "El modelo no detecta globos ni da máscara de trazos: la agrupación en bloques y la máscara las hace STARBLITZ.",
            license="Apache-2.0 (declarada en la ficha; entrenado con Manga109-s)",
            homepage=f"{HF}/Kellenok/PP-OCRv6_manga",
            files=(
                ModelFile(
                    "manga_det.onnx",
                    (f"{HF}/Kellenok/PP-OCRv6_manga/resolve/v0.3/det/manga_det.onnx",),
                    "97c434ae8deaad83513fb132b605d5085a3af8ffac2cb15e2aa096815c206172",
                    1.8,
                ),
            ),
        ),
        ModelSpec(
            id="manga-ocr",
            label="Manga OCR (japonés)",
            purpose="ocr",
            description="OCR especializado en manga: texto vertical, furigana y tipografías estilizadas.",
            license="Apache-2.0",
            homepage="https://github.com/kha-white/manga-ocr",
            languages=("ja",),
            files=(
                ModelFile(
                    "encoder_model.onnx",
                    (f"{HF}/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/encoder_model.onnx",),
                    "df35f64c2400ea860c70a2d06f2a1f99892374a78c89fcf35308076557a3863f",
                    343.0,
                ),
                ModelFile(
                    "decoder_model.onnx",
                    (f"{HF}/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/decoder_model.onnx",),
                    "31ca14d6dee6b3966144e128d0481d5a91f5083cbced81fe7a9571713fa50cd4",
                    117.0,
                ),
                ModelFile("vocab.txt", (f"{HF}/kha-white/manga-ocr-base/resolve/main/vocab.txt",), None, 0.03),
                ModelFile(
                    "generation_config.json",
                    (f"{HF}/onnx-community/manga-ocr-base-ONNX/resolve/main/generation_config.json",),
                    None,
                    0.01,
                ),
            ),
        ),
        ModelSpec(
            id="lama",
            label="LaMa (reconstrucción de fondos)",
            purpose="inpainting",
            description="Reconstruye el dibujo bajo el texto que no está sobre un fondo liso (tramas, escenarios).",
            license="Apache-2.0",
            homepage="https://github.com/advimman/lama",
            files=(
                ModelFile(
                    "lama_fp32.onnx",
                    (f"{HF}/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",),
                    "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
                    208.0,
                ),
            ),
        ),
    )
}


def get_spec(model_id: str) -> ModelSpec | None:
    return REGISTRY.get(model_id)
