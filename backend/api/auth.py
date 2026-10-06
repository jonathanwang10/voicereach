"""Authentication: every API request must carry a valid Supabase access token.

Tokens are checked with Supabase Auth itself (auth.get_user), which works for
both legacy HS256 and asymmetric signing keys. Verified tokens are cached for a
minute so normal use costs one Auth round trip per minute per session.
"""
import os
import time

from fastapi import Header, HTTPException, status
from supabase import create_client

_CACHE_TTL_SECONDS = 60
_CACHE_MAX_ENTRIES = 1000
_cache: dict[str, tuple[str, float]] = {}
_auth_client = None


def _get_auth_client():
    global _auth_client
    if _auth_client is None:
        _auth_client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_ANON_KEY"])
    return _auth_client


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def verify_token(token: str) -> str:
    """Return the Supabase user id for a valid access token; raise 401 otherwise."""
    now = time.monotonic()
    cached = _cache.get(token)
    if cached and cached[1] > now:
        return cached[0]
    try:
        response = _get_auth_client().auth.get_user(token)
        user = response.user if response else None
    except Exception:
        user = None
    if user is None:
        raise _unauthorized("Invalid or expired session")
    if len(_cache) >= _CACHE_MAX_ENTRIES:
        _cache.clear()
    _cache[token] = (user.id, now + _CACHE_TTL_SECONDS)
    return user.id


def get_current_user(authorization: str = Header(None)) -> str:
    """FastAPI dependency. Sync on purpose: FastAPI runs it in a threadpool."""
    if not authorization or not authorization.startswith("Bearer "):
        raise _unauthorized("Missing bearer token")
    return verify_token(authorization[len("Bearer "):])
