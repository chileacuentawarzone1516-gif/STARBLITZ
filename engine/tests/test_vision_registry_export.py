"""El registro de modelos de visión que usa Android (JSON) debe coincidir con el de Python (fuente de verdad)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))

from export_vision_registry import OUT, export  # noqa: E402


def test_json_matches_python_registry():
    assert json.loads(OUT.read_text(encoding="utf-8")) == export(), "Ejecuta: python tools/export_vision_registry.py"
