"""Shared error handling for API routes (R-13).

Route pattern:

    try:
        ...
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Save individual", e)

Every non-2xx body is {"detail": str}. A 500 never carries the exception text
(it can hold table names, upstream error bodies or personal data); the server log
records the action and the exception type only.
"""
import logging

from fastapi import HTTPException

logger = logging.getLogger(__name__)


def internal_error(action: str, exc: Exception) -> HTTPException:
    """Log `action` plus the exception type (no message, no PII) and return a generic 500."""
    logger.error("%s failed: %s", action, type(exc).__name__)
    return HTTPException(status_code=500, detail=f"{action} failed")
