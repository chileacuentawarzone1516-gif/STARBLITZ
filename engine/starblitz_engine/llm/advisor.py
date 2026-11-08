"""Asesor de modelos: qué perfil de rendimiento tiene este dispositivo y qué modelos le convienen.

Todo se decide midiendo el dispositivo (RAM, GPU y VRAM en PC; RAM y almacenamiento en Android);
nunca se descarga nada por sorpresa: aquí solo se *recomienda*.
"""

from __future__ import annotations

from ..core.hardware import HardwareInfo
from .catalog import CATALOG, PROFILES, Profile, Tier, classify, estimate_memory_gb, fit_model, pick_default
from .library import InstalledModel, LLMLibrary

GIB = 1024 ** 3
VISION_RESERVE_GB = 1.2  # VRAM que se deja libre para los modelos de visión (detector, OCR, LaMa)


def device_caps(hw: HardwareInfo) -> dict:
    gpu = hw.best_gpu
    return {"ram_gb": round(hw.ram_mb / 1024, 1), "vram_gb": round((gpu.vram_mb / 1024) if gpu else 0.0, 1),
            "gpu": gpu.name if gpu else "", "cpu": hw.cpu, "threads": hw.threads}


def current_profile(hw: HardwareInfo, override: str = "auto") -> Profile:
    """Perfil activo: el elegido por el usuario o el detectado."""
    if override in PROFILES:
        return PROFILES[override]  # type: ignore[index]
    caps = device_caps(hw)
    return PROFILES[classify(caps["ram_gb"], caps["vram_gb"])]


def effective_context(profile: Profile, configured: int, native: int = 0) -> int:
    """Ventana de contexto con la que se carga el modelo: nunca más de lo que el perfil aguanta ni el modelo admite."""
    ctx = min(configured, profile.context)
    if native:
        ctx = min(ctx, native)
    return max(2048, ctx)


def resolve_model(library: LLMLibrary, wanted: str, hw: HardwareInfo, override: str = "auto") -> InstalledModel | None:
    """Modelo a usar: el elegido si está instalado; si no, el instalado que mejor encaja con el equipo."""
    installed = library.installed()
    for m in installed:
        if m.id == wanted:
            return m
    if not installed:
        return None
    caps = device_caps(hw)
    profile = current_profile(hw, override)
    target = pick_default(profile.id, caps["vram_gb"])
    ranked = sorted(installed, key=lambda m: (
        m.id != target,
        fit_for(m, hw, profile.context)["fits"] == "no",
        -m.params_b,
    ))
    return ranked[0]


def fit_for(model: InstalledModel, hw: HardwareInfo, context: int) -> dict:
    gpu = hw.best_gpu
    need = estimate_memory_gb(model.size, model.params_b or 4.0, context, 0, model.arch)
    return fit_model(need, hw.ram_mb / 1024, max(0.0, (gpu.vram_mb / 1024) - VISION_RESERVE_GB) if gpu else 0.0)


def advise(hw: HardwareInfo, library: LLMLibrary, active_id: str, override: str = "auto") -> dict:
    """Ficha completa para la pantalla «Modelos»: perfil, recomendación y compatibilidad de cada modelo."""
    caps = device_caps(hw)
    profile = current_profile(hw, override)
    recommended = pick_default(profile.id, caps["vram_gb"])
    installed = {m.id for m in library.installed()}
    gpu = hw.best_gpu
    vram = (gpu.vram_mb / 1024) if gpu else 0.0
    options = []
    for m in CATALOG:
        # La parte visual solo se carga si el perfil la usa: no se cuenta contra la memoria cuando no se va a emplear.
        need = estimate_memory_gb(m.file.size, m.params_b, profile.context, m.mmproj.size if (m.mmproj and profile.vision_llm) else 0,
                                  "qwen35" if m.family == "qwen3.5" else m.family)
        fit = fit_model(need, caps["ram_gb"], max(0.0, vram - VISION_RESERVE_GB) if gpu else 0.0)
        options.append({**m.to_dict(), "fit": fit, "installed": m.id in installed, "recommended": m.id == recommended,
                        "active": m.id == active_id})
    best = next(o for o in options if o["recommended"])
    supported = any(o["fit"]["fits"] != "no" for o in options)
    reason = _reason(profile.id, caps, best) if best["fit"]["fits"] != "no" else (
        f"Este equipo ({caps['ram_gb']:.0f} GB de RAM) no tiene memoria suficiente para ejecutar un modelo de traducción "
        "local de forma fiable. Puedes seguir usando un servidor de modelos externo que ya tengas instalado.")
    return {"device": caps, "profile": _profile_dict(profile), "profiles": [_profile_dict(p) for p in PROFILES.values()],
            "recommended": recommended, "reason": reason, "options": options, "supported": supported}


def _profile_dict(p: Profile) -> dict:
    return {"id": p.id, "label": p.label, "description": p.description, "context": p.context, "vision_llm": p.vision_llm,
            "quality": p.quality, "ocr_japanese": p.ocr_japanese, "inpaint": p.inpaint, "default_model": p.default_model}


def _reason(tier: Tier, caps: dict, best: dict) -> str:
    if caps["vram_gb"] >= 5.5:
        base = f"Tu tarjeta gráfica ({caps['gpu']}, {caps['vram_gb']:.0f} GB de memoria) ejecuta {best['label']} con aceleración."
    elif tier == "low":
        base = f"Con {caps['ram_gb']:.0f} GB de RAM y sin GPU dedicada, {best['label']} es el más ligero que mantiene una calidad aceptable."
    else:
        base = f"Con {caps['ram_gb']:.0f} GB de RAM y sin GPU dedicada, {best['label']} se ejecuta en el procesador."
    return base


__all__ = ["advise", "current_profile", "device_caps", "effective_context", "fit_for", "resolve_model", "VISION_RESERVE_GB"]
