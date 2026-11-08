"""Servicios compartidos por las rutas de la API."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..core.jobs import EventBus, JobManager
from ..core.paths import DataPaths
from ..core.settings import SettingsStore
from ..llm.library import LLMLibrary
from ..llm.runtime import LlamaRuntime
from ..models.manager import ModelManager
from ..pipeline.processor import Processor
from ..projects.store import ProjectStore


@dataclass
class Services:
    paths: DataPaths
    token: str
    settings: SettingsStore
    store: ProjectStore
    models: ModelManager
    library: LLMLibrary
    runtime: LlamaRuntime
    bus: EventBus
    jobs: JobManager
    processor: Processor
    port: int = 0

    @classmethod
    def build(cls, paths: DataPaths, token: str, llama_dir: Path | None = None) -> "Services":
        settings = SettingsStore(paths.settings_file)
        store = ProjectStore(paths.projects)
        models = ModelManager(paths.models)
        library = LLMLibrary(paths.models / "llm")
        runtime = LlamaRuntime(library, settings, paths.logs, llama_dir)
        bus = EventBus()
        return cls(paths=paths, token=token, settings=settings, store=store, models=models, library=library,
                   runtime=runtime, bus=bus, jobs=JobManager(bus),
                   processor=Processor(store, models, settings, library, runtime, bus.publish))

    def shutdown(self) -> None:
        self.runtime.shutdown()
