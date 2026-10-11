"""
Per-user rate limits for the endpoints that cost OpenAI money (C-12, R-4).

A fixed 60-second window per (bucket, user id), kept in memory: limits reset on
restart and are per process (fine for one demo instance; several workers would
each allow the full limit). Each limit is read from its env var on every call,
so a change needs no code edit; a missing, non-numeric or < 1 value uses the
default. See backend/.env.example for the variables.
"""
import math
import os
import threading
import time
from typing import Callable

from fastapi import Depends, HTTPException, status

from api.auth import get_current_user

WINDOW_SECONDS = 60.0
TOO_MANY_DETAIL = "Too many requests. Try again in a minute."
_MAX_BUCKETS = 10_000

_lock = threading.Lock()
_buckets: dict[tuple[str, str], tuple[float, int]] = {}  # (bucket, key) -> (window start, count)


def limit_from_env(env_var: str, default: int) -> int:
    try:
        value = int(os.getenv(env_var, ""))
    except ValueError:
        return default
    return value if value >= 1 else default


def _seconds_left(bucket: str, key: str, window_s: float) -> int:
    with _lock:
        start, _count = _buckets.get((bucket, key), (time.monotonic(), 0))
    return max(1, math.ceil(window_s - (time.monotonic() - start)))


def check_rate_limit(bucket: str, key: str, limit: int, window_s: float = WINDOW_SECONDS) -> bool:
    """Count one call; False when `key` already made `limit` calls in this window."""
    now = time.monotonic()
    with _lock:
        if len(_buckets) >= _MAX_BUCKETS:
            for k in [k for k, (start, _) in _buckets.items() if now - start >= window_s]:
                del _buckets[k]
        start, count = _buckets.get((bucket, key), (now, 0))
        if now - start >= window_s:
            start, count = now, 0
        if count >= limit:
            return False
        _buckets[(bucket, key)] = (start, count + 1)
        return True


def reset_rate_limits() -> None:
    """Forget every window (tests)."""
    with _lock:
        _buckets.clear()


def rate_limit(bucket: str, env_var: str, default_per_minute: int) -> Callable[..., str]:
    """A FastAPI dependency: authenticates (get_current_user), counts the call, returns the user id.

    Over the limit it raises 429 with a Retry-After header.
    """
    def dependency(user_id: str = Depends(get_current_user)) -> str:
        if not check_rate_limit(bucket, user_id, limit_from_env(env_var, default_per_minute)):
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=TOO_MANY_DETAIL,
                headers={"Retry-After": str(_seconds_left(bucket, user_id, WINDOW_SECONDS))},
            )
        return user_id

    return dependency
