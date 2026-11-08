"""Identificadores seguros para usar como nombres de carpeta y en URLs."""

from __future__ import annotations

import re
import secrets

from .errors import ValidationError

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")


def new_id(prefix: str = "") -> str:
    token = secrets.token_hex(6)
    return f"{prefix}{token}" if prefix else token


def validate_id(value: str, what: str = "identificador") -> str:
    """Rechaza cualquier id que pudiera escapar de su carpeta (path traversal)."""
    if not isinstance(value, str) or not _ID_RE.match(value):
        raise ValidationError("invalid_id", f"El {what} no es válido.")
    return value
