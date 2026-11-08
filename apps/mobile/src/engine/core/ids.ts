/** Identificadores seguros para claves de almacenamiento y rutas (equivalente a `core/ids.py`). */
import { ValidationError } from './errors';

const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

export function newId(prefix = ''): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Rechaza cualquier id que pudiera escapar de su clave (`/`, `..`…). */
export function validateId(value: unknown, what = 'identificador'): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new ValidationError('invalid_id', `El ${what} no es válido.`);
  return value;
}
