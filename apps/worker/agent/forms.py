"""Generic checks for human forms and durations (no knowledge of the workflow JSON)."""

from __future__ import annotations

import re
from typing import Any

from .models import FormField

DURATION_RE = re.compile(r"^\d+[smhd]$")
_UNIT_MS = {"s": 1_000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}


def duration_ms(d: str) -> int:
    return int(d[:-1]) * _UNIT_MS[d[-1]]


def validate_fields(fields: dict[str, FormField], values: dict[str, Any]) -> list[str]:
    errors = []
    for name, f in fields.items():
        v = values.get(name)
        if v is None or v == "":
            if f.required:
                errors.append(f'"{name}" is required')
            continue
        if f.type == "number" and (isinstance(v, bool) or not isinstance(v, (int, float))):
            errors.append(f'"{name}" must be a number')
        if f.type == "boolean" and not isinstance(v, bool):
            errors.append(f'"{name}" must be true or false')
        if f.type in ("string", "text") and not isinstance(v, str):
            errors.append(f'"{name}" must be text')
        if f.type == "duration" and not (isinstance(v, str) and DURATION_RE.match(v)):
            errors.append(f'"{name}" must be a duration like 30s, 10m, 2h or 1d')
    return errors
