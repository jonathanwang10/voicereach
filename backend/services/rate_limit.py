"""
Rate limits for the endpoints that cost OpenAI money or do heavy work (C-12, R-4, H2-1.7).

A fixed 60-second window per (bucket, key), kept in memory: limits reset on
restart and are per process. That is deliberate while there is one process; several
workers would each allow the full limit. The key is the user id plus the caller's
X-Device-Id when it sends one (`limit_key`), because every phone shares the demo
account; each bucket also has a per-process total, so many device ids can't add up
to an unbounded budget. Each limit is read from its env var on every call, so a
change needs no code edit; a missing, non-numeric or < 1 value uses the default.
See backend/.env.example for the variables.
"""
import math
import os
import threading
import time
from typing import Callable

from fastapi import Depends, HTTPException, status

from api.auth import get_current_user
from api.device import get_device_id

WINDOW_SECONDS = 60.0
TOO_MANY_DETAIL = "Too many requests. Try again in a minute."
_MAX_BUCKETS = 10_000
# A bucket's per-process total, unless RATE_LIMIT_<NAME>_TOTAL_PER_MIN says otherwise
DEFAULT_TOTAL_MULTIPLIER = 5
_PROCESS_KEY = "__process__"

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


def limit_key(user_id: str, device_id: str | None) -> str:
    """The window key: the user id, plus the device id when the caller sent one."""
    return f"{user_id}:{device_id}" if device_id else user_id


def total_env_var(env_var: str) -> str:
    """RATE_LIMIT_SAVE_PER_MIN -> RATE_LIMIT_SAVE_TOTAL_PER_MIN (the per-process total)."""
    return env_var[: -len("_PER_MIN")] + "_TOTAL_PER_MIN" if env_var.endswith("_PER_MIN") else env_var + "_TOTAL"


def check_keyed_limit(bucket: str, user_id: str, device_id: str | None, env_var: str,
                      default_per_minute: int) -> int | None:
    """Count one call against the caller's window, then the bucket's per-process total.
    None when allowed, else the Retry-After seconds."""
    per_key = limit_from_env(env_var, default_per_minute)
    key = limit_key(user_id, device_id)
    if not check_rate_limit(bucket, key, per_key):
        return _seconds_left(bucket, key, WINDOW_SECONDS)
    total = limit_from_env(total_env_var(env_var), per_key * DEFAULT_TOTAL_MULTIPLIER)
    if not check_rate_limit(bucket, _PROCESS_KEY, total):
        return _seconds_left(bucket, _PROCESS_KEY, WINDOW_SECONDS)
    return None


def rate_limit(bucket: str, env_var: str, default_per_minute: int) -> Callable[..., str]:
    """A FastAPI dependency: authenticates (get_current_user), counts the call against the
    caller's user + device window and the bucket's total, returns the user id.

    Over a limit it raises 429 with a Retry-After header.
    """
    def dependency(user_id: str = Depends(get_current_user),
                   device_id: str | None = Depends(get_device_id)) -> str:
        retry_after = check_keyed_limit(bucket, user_id, device_id, env_var, default_per_minute)
        if retry_after is not None:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=TOO_MANY_DETAIL,
                headers={"Retry-After": str(retry_after)},
            )
        return user_id

    return dependency
