"""Errores de dominio con mensajes seguros para el cliente.

Los mensajes de `AppError` se muestran al usuario; nunca deben incluir rutas
internas, trazas ni datos sensibles. El detalle técnico va solo al log.
"""

from __future__ import annotations


class AppError(Exception):
    """Error controlado que la API traduce a una respuesta JSON homogénea."""

    status_code = 400

    def __init__(self, code: str, message: str, status_code: int | None = None, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}
        if status_code is not None:
            self.status_code = status_code


class NotFoundError(AppError):
    status_code = 404

    def __init__(self, what: str):
        super().__init__("not_found", f"No se encontró {what}.")


class ValidationError(AppError):
    status_code = 422


class LimitExceededError(AppError):
    status_code = 413


class ModelMissingError(AppError):
    """Un modelo requerido no está instalado; el cliente puede ofrecer descargarlo."""

    status_code = 409

    def __init__(self, model_id: str, label: str):
        super().__init__(
            "model_missing",
            f"Falta el modelo «{label}». Descárgalo desde Configuración → Modelos.",
            details={"model_id": model_id},
        )


class LLMUnavailableError(AppError):
    status_code = 503

    def __init__(self, message: str):
        super().__init__("llm_unavailable", message)


class CancelledError(AppError):
    status_code = 409

    def __init__(self):
        super().__init__("cancelled", "La tarea fue cancelada.")
