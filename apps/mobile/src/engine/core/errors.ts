/**
 * Errores de dominio con mensajes seguros para la persona (equivalente a `core/errors.py`).
 * Los mensajes se muestran tal cual en la interfaz: nunca llevan rutas internas ni trazas.
 */
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400, public details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) { super('not_found', `No se encontró ${what}.`, 404); }
}

export class ValidationError extends AppError {
  constructor(code: string, message: string) { super(code, message, 422); }
}

export class ModelMissingError extends AppError {
  constructor(modelId: string, label: string) {
    super('model_missing', `Falta el modelo «${label}». Descárgalo desde la sección Modelos.`, 409, { model_id: modelId });
  }
}

export class LLMUnavailableError extends AppError {
  constructor(message: string) { super('llm_unavailable', message, 503); }
}

export class CancelledError extends AppError {
  constructor() { super('cancelled', 'La tarea fue cancelada.', 409); }
}

export const isCancelled = (e: unknown): e is CancelledError => e instanceof CancelledError;
