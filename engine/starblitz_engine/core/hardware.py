"""Detección de hardware y recomendación de modelos ejecutables.

STARBLITZ no asume la potencia del equipo: mide GPU, VRAM y RAM, y con eso
elige el modelo de lenguaje y el proveedor de ONNX Runtime adecuados.
"""

from __future__ import annotations

import logging
import os
import platform
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from functools import lru_cache

import psutil

log = logging.getLogger(__name__)

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW


@dataclass
class GPUInfo:
    name: str
    vram_mb: int
    vendor: str
    driver: str = ""


@dataclass
class HardwareInfo:
    os: str
    cpu: str
    cores: int
    threads: int
    ram_mb: int
    gpus: list[GPUInfo] = field(default_factory=list)
    onnx_providers: list[str] = field(default_factory=list)

    @property
    def best_gpu(self) -> GPUInfo | None:
        dedicated = [g for g in self.gpus if g.vendor in ("nvidia", "amd") or g.vram_mb >= 2048]
        return max(dedicated, key=lambda g: g.vram_mb, default=None)

    def to_dict(self) -> dict:
        data = asdict(self)
        best = self.best_gpu
        data["best_gpu"] = asdict(best) if best else None
        return data


def _vendor(name: str) -> str:
    n = name.lower()
    if "nvidia" in n or "geforce" in n or "rtx" in n or "quadro" in n:
        return "nvidia"
    if "amd" in n or "radeon" in n:
        return "amd"
    if "intel" in n or "arc" in n:
        return "intel"
    return "other"


def _run(cmd: list[str], timeout: float = 6.0) -> str:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, creationflags=_NO_WINDOW)
        return out.stdout if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _nvidia_smi() -> list[GPUInfo]:
    exe = shutil.which("nvidia-smi")
    if not exe and sys.platform == "win32":
        candidate = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe")
        exe = candidate if os.path.exists(candidate) else None
    if not exe:
        return []
    raw = _run([exe, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"])
    gpus = []
    for line in raw.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 3 and parts[1].isdigit():
            gpus.append(GPUInfo(name=parts[0], vram_mb=int(parts[1]), vendor="nvidia", driver=parts[2]))
    return gpus


def _windows_gpus() -> list[GPUInfo]:
    """Lee la VRAM real del registro (Win32_VideoController la trunca a 4 GB)."""
    try:
        import winreg  # type: ignore[import-not-found]
    except ImportError:
        return []
    key_path = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
    gpus: list[GPUInfo] = []
    try:
        root = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path)
    except OSError:
        return []
    with root:
        for i in range(32):
            sub = f"{i:04d}"
            try:
                with winreg.OpenKey(root, sub) as k:
                    name = str(winreg.QueryValueEx(k, "DriverDesc")[0])
                    vram = 0
                    for value_name in ("HardwareInformation.qwMemorySize", "HardwareInformation.MemorySize"):
                        try:
                            raw, _ = winreg.QueryValueEx(k, value_name)
                            vram = int.from_bytes(raw, "little") if isinstance(raw, (bytes, bytearray)) else int(raw)
                            if vram:
                                break
                        except OSError:
                            continue
                    try:
                        driver = str(winreg.QueryValueEx(k, "DriverVersion")[0])
                    except OSError:
                        driver = ""
                    if "basic display" in name.lower() or "virtual" in name.lower():
                        continue
                    gpus.append(GPUInfo(name=name, vram_mb=vram // (1024 * 1024), vendor=_vendor(name), driver=driver))
            except OSError:
                continue
    return gpus


def _cpu_name() -> str:
    if sys.platform == "win32":
        try:
            import winreg  # type: ignore[import-not-found]

            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
                return str(winreg.QueryValueEx(k, "ProcessorNameString")[0]).strip()
        except OSError:
            pass
    try:
        with open("/proc/cpuinfo", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or platform.machine()


def onnx_providers() -> list[str]:
    try:
        import onnxruntime as ort

        return list(ort.get_available_providers())
    except Exception:  # pragma: no cover - onnxruntime ausente
        return []


@lru_cache(maxsize=1)
def detect() -> HardwareInfo:
    gpus = _nvidia_smi()
    if sys.platform == "win32":
        known = {g.name for g in gpus}
        gpus += [g for g in _windows_gpus() if g.name not in known]
    info = HardwareInfo(
        os=f"{platform.system()} {platform.release()}",
        cpu=_cpu_name(),
        cores=psutil.cpu_count(logical=False) or 1,
        threads=psutil.cpu_count(logical=True) or 1,
        ram_mb=int(psutil.virtual_memory().total / (1024 * 1024)),
        gpus=gpus,
        onnx_providers=onnx_providers(),
    )
    log.info("Hardware: %s", info.to_dict())
    return info
