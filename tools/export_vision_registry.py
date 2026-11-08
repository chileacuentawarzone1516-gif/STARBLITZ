"""Exporta el registro de modelos de visión (Python) a JSON para el motor de Android (TypeScript).

La fuente de verdad es `engine/starblitz_engine/models/registry.py`. Tras cambiarlo:  python tools/export_vision_registry.py
`engine/tests/test_vision_registry_export.py` comprueba que el JSON y el registro coinciden.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))

from starblitz_engine.models.registry import REGISTRY  # noqa: E402

OUT = ROOT / "apps" / "mobile" / "src" / "engine" / "models" / "vision-registry.json"


def export() -> list[dict]:
    return [
        {
            "id": s.id, "label": s.label, "purpose": s.purpose, "description": s.description, "license": s.license,
            "homepage": s.homepage, "required": s.required, "languages": list(s.languages),
            "files": [{"rel": f.rel_path, "url": f.urls[0], "sha256": f.sha256, "approx_mb": f.approx_mb} for f in s.files],
        }
        for s in REGISTRY.values()
    ]


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(export(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Escrito {OUT.relative_to(ROOT)}")
