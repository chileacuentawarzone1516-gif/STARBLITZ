"""Fábrica de sesiones ONNX Runtime con selección automática de acelerador.

Orden de preferencia: CUDA → DirectML (cualquier GPU en Windows) → CPU.
Si un proveedor de GPU falla al crear la sesión se reintenta en CPU para que
el procesamiento nunca se bloquee por un controlador problemático.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Literal

import onnxruntime as ort

log = logging.getLogger(__name__)

Device = Literal["auto", "gpu", "cpu"]

_lock = threading.Lock()


def _provider_chain(device: Device) -> list:
    available = set(ort.get_available_providers())
    chain: list = []
    if device != "cpu":
        if "CUDAExecutionProvider" in available:
            chain.append(("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}))
        if "DmlExecutionProvider" in available:
            # En portátiles con gráfica híbrida el adaptador 0 suele ser la iGPU:
            # se pide explícitamente el de alto rendimiento.
            chain.append(("DmlExecutionProvider", {"performance_preference": "high_performance", "device_filter": "gpu"}))
    chain.append("CPUExecutionProvider")
    return chain


def _base_options() -> ort.SessionOptions:
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    opts.log_severity_level = 3
    # Los pesos de comic-text-detector contienen números desnormalizados: en CPU x86 cada operación con ellos es lentísima
    # (medido en un i7-13620H con ONNX Runtime 1.31: 140 s por inferencia frente a 1,9 s tratándolos como cero). Redondearlos
    # a cero no cambia el resultado de forma apreciable (valores < 1e-38; comprobado con páginas reales, ver
    # docs/EVALUACION-CORPUS-USM.md). No afecta a CUDA/DirectML.
    opts.add_session_config_entry("session.set_denormal_as_zero", "1")
    return opts


def create_session(model_path: Path, device: Device = "auto", threads: int = 0) -> ort.InferenceSession:
    opts = _base_options()
    if threads:
        opts.intra_op_num_threads = threads
    chain = _provider_chain(device)
    uses_dml = any(isinstance(p, tuple) and p[0] == "DmlExecutionProvider" for p in chain)
    if uses_dml:
        # Requisito de DirectML.
        opts.enable_mem_pattern = False
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    with _lock:
        try:
            sess = ort.InferenceSession(str(model_path), sess_options=opts, providers=chain)
        except Exception as exc:  # proveedor GPU no disponible o modelo incompatible con él
            if len(chain) == 1:
                raise
            log.warning("Fallo al crear sesión con GPU para %s (%s). Se usa CPU.", model_path.name, exc)
            cpu_opts = _base_options()
            sess = ort.InferenceSession(str(model_path), sess_options=cpu_opts, providers=["CPUExecutionProvider"])
    log.info("Sesión ONNX %s con %s", model_path.name, sess.get_providers()[0])
    return sess
