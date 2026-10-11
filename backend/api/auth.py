"""Authentication: every API request must carry a valid Supabase access token.

Tokens are checked with Supabase Auth itself (auth.get_user), which works for
both legacy HS256 and asymmetric signing keys. Verified tokens are cached for a
minute so normal use costs one Auth round trip per minute per session.

Optional allowlist: when ALLOWED_USER_EMAILS is set (comma-separated,
case-insensitive), a valid user whose email is not listed gets a 403. It is read
on every call, cached tokens included, so tightening it takes effect at once.
Unset means any valid user of the Supabase project is accepted.
"""
import logging
import os
import time

import httpx
from fastapi import Header, HTTPException, status
from supabase import create_client
from supabase_auth.errors import AuthError, AuthRetryableError

_CACHE_TTL_SECONDS = 60
_CACHE_MAX_ENTRIES = 1000
_cache: dict[str, tuple[str, str, float]] = {}  # token -> (user id, email, expiry)
NOT_ALLOWED_DETAIL = "This account is not allowed to use this service"
_auth_client = None
logger = logging.getLogger(__name__)


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


def _unavailable() -> HTTPException:
    return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Auth service unavailable")


def _allowed_emails() -> set[str]:
    """Lower-cased ALLOWED_USER_EMAILS entries; empty set = no allowlist."""
    raw = os.getenv("ALLOWED_USER_EMAILS", "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def _check_allowed(email: str) -> None:
    allowed = _allowed_emails()
    if allowed and (email or "").strip().lower() not in allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=NOT_ALLOWED_DETAIL)


def verify_token(token: str) -> str:
    """Return the Supabase user id for a valid access token.

    401 for a missing, empty or invalid token; 403 for a valid user outside
    ALLOWED_USER_EMAILS (when set); 503 when Supabase Auth can't be reached.
    """
    if not token or not token.strip():
        # Never call get_user(""): it would fall back to the client's own session.
        raise _unauthorized("Missing bearer token")
    now = time.monotonic()
    cached = _cache.get(token)
    if cached and cached[2] > now:
        _check_allowed(cached[1])
        return cached[0]
    try:
        client = _get_auth_client()
    except Exception as e:
        logger.error("Auth client could not be created (check SUPABASE_URL / SUPABASE_ANON_KEY): %s",
                     type(e).__name__)
        raise _unavailable()
    try:
        response = client.auth.get_user(token)
        user = response.user if response else None
    except (httpx.TransportError, AuthRetryableError) as e:
        logger.warning("Auth service unreachable: %s", type(e).__name__)
        raise _unavailable()
    except AuthError as e:
        # Type, HTTP status and GoTrue error code only: the message text can carry an email
        logger.info("Token rejected by Supabase Auth: %s status=%s code=%s",
                    type(e).__name__, getattr(e, "status", None), getattr(e, "code", None))
        user = None
    except Exception as e:
        logger.error("Unexpected error verifying token: %s", type(e).__name__)
        user = None
    if user is None:
        raise _unauthorized("Invalid or expired session")
    email = getattr(user, "email", None) or ""
    _check_allowed(email)  # raises before caching, so only allowed users are cached
    if len(_cache) >= _CACHE_MAX_ENTRIES:
        _cache.clear()
    _cache[token] = (user.id, email, now + _CACHE_TTL_SECONDS)
    return user.id


def get_current_user(authorization: str = Header(None)) -> str:
    """FastAPI dependency. Sync on purpose: FastAPI runs it in a threadpool."""
    if not authorization or not authorization.startswith("Bearer "):
        raise _unauthorized("Missing bearer token")
    return verify_token(authorization[len("Bearer "):])
