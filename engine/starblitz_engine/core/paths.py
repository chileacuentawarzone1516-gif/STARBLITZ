"""Ubicación de datos del motor (proyectos, modelos, ajustes, registros)."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path


def default_data_dir() -> Path:
    env = os.environ.get("STARBLITZ_DATA_DIR")
    if env:
        return Path(env)
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "STARBLITZ"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "STARBLITZ"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "starblitz"


@dataclass(frozen=True)
class DataPaths:
    root: Path

    @property
    def projects(self) -> Path:
        return self.root / "projects"

    @property
    def models(self) -> Path:
        return self.root / "models"

    @property
    def logs(self) -> Path:
        return self.root / "logs"

    @property
    def tmp(self) -> Path:
        return self.root / "tmp"

    @property
    def settings_file(self) -> Path:
        return self.root / "settings.json"

    def ensure(self) -> "DataPaths":
        for p in (self.root, self.projects, self.models, self.logs, self.tmp):
            p.mkdir(parents=True, exist_ok=True)
        return self
