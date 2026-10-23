"""
The optional X-Device-Id header (H2-1.7).

Every phone signs in as the shared demo account, so the user id alone can't tell
phones apart. The app sends a random id it creates once; rate limits (and the
audit log) key on it. This module is the only backend reader of the header.
A missing or malformed header is None, never an error: an older app still works,
and the per-process totals still cap it.
"""
import re

from fastapi import Header

DEVICE_ID_HEADER = "X-Device-Id"
_DEVICE_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")


def clean_device_id(value: str | None) -> str | None:
    """The header value with surrounding whitespace stripped, if it looks like an id; else None."""
    if value is None:
        return None
    value = value.strip()
    return value if _DEVICE_ID.match(value) else None


def get_device_id(x_device_id: str | None = Header(None, alias=DEVICE_ID_HEADER)) -> str | None:
    """FastAPI dependency: the caller's cleaned device id, or None."""
    return clean_device_id(x_device_id)
