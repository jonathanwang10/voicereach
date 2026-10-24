"""Authentication: every API request must carry a valid Supabase access token.

An asymmetric (ES256/RS256) token is verified locally against the project's JWKS
(H2-8.3): signature, `aud` "authenticated", `iss` <SUPABASE_URL>/auth/v1 and expiry.
The key set is cached 10 minutes and re-fetched once for a key id rotated in since.
Anything else (legacy HS256, an unparseable token, an unreachable JWKS endpoint) is
checked with Supabase Auth itself (auth.get_user). A locally verified token stays
valid until it expires, even after Sign Out. Verified tokens are cached for a
minute so normal use costs at most one Auth round trip per minute per session.

Optional allowlist: when ALLOWED_USER_EMAILS is set (comma-separated,
case-insensitive), a valid user whose email is not listed gets a 403. It is read
on every call, cached tokens included, so tightening it takes effect at once.
Unset means any valid user of the Supabase project is accepted.
"""
import logging
import os
import time

import httpx
import jwt
from fastapi import Header, HTTPException, status
from supabase import create_client
from supabase_auth.errors import AuthError, AuthRetryableError

_CACHE_TTL_SECONDS = 60
_CACHE_MAX_ENTRIES = 1000
_cache: dict[str, tuple[str, str, float]] = {}  # token -> (user id, email, expiry)
NOT_ALLOWED_DETAIL = "This account is not allowed to use this service"
_auth_client = None
_jwks = None
ASYMMETRIC_ALGORITHMS = ("ES256", "RS256")
JWKS_CACHE_SECONDS = 600   # Supabase caches the endpoint 10 minutes; don't keep keys longer
logger = logging.getLogger(__name__)


def _base_url() -> str:
    return os.environ["SUPABASE_URL"].rstrip("/")


def _jwks_client() -> jwt.PyJWKClient:
    global _jwks
    if _jwks is None:
        # On an unknown kid PyJWKClient re-fetches the set once (a rotated key)
        _jwks = jwt.PyJWKClient(f"{_base_url()}/auth/v1/.well-known/jwks.json",
                                lifespan=JWKS_CACHE_SECONDS, timeout=5)
    return _jwks


def _verify_locally(token: str) -> tuple[str, str] | None:
    """(user id, email) for a valid ES256/RS256 token; None means "ask auth.get_user";
    a 401 for a token the JWKS rejects (no fallback then)."""
    try:
        header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError:
        return None
    alg = header.get("alg")
    if alg not in ASYMMETRIC_ALGORITHMS or not header.get("kid"):
        return None
    try:
        key = _jwks_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=[alg], audience="authenticated",
                            issuer=f"{_base_url()}/auth/v1",
                            options={"require": ["exp", "sub", "aud", "iss"]})
    except jwt.PyJWKClientConnectionError as e:
        logger.warning("JWKS unreachable, asking Supabase Auth instead: %s", type(e).__name__)
        return None
    except (jwt.PyJWKClientError, jwt.InvalidTokenError) as e:
        # The type only: claims (an email) never reach the log
        logger.info("Token rejected locally: %s", type(e).__name__)
        raise _unauthorized("Invalid or expired session")
    return claims["sub"], claims.get("email") or ""


def supabase_public_key() -> str | None:
    """The key for verifying tokens with Supabase Auth (H2-8.3): the new
    `sb_publishable_...` key, else the legacy anon key until legacy keys are disabled."""
    for name in ("SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"):
        value = (os.getenv(name) or "").strip()
        if value:
            return value
    return None


def _get_auth_client():
    global _auth_client
    if _auth_client is None:
        key = supabase_public_key()
        if not key:
            raise RuntimeError("no Supabase public key")
        _auth_client = create_client(os.environ["SUPABASE_URL"], key)
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
    local = _verify_locally(token)
    if local is not None:
        user_id, email = local
    else:
        user_id, email = _verify_with_auth(token)
    _check_allowed(email)  # raises before caching, so only allowed users are cached
    if len(_cache) >= _CACHE_MAX_ENTRIES:
        _cache.clear()
    _cache[token] = (user_id, email, now + _CACHE_TTL_SECONDS)
    return user_id


def _verify_with_auth(token: str) -> tuple[str, str]:
    """(user id, email) from Supabase Auth: legacy HS256 and anything not verified locally."""
    try:
        client = _get_auth_client()
    except Exception as e:
        logger.error("Auth client could not be created (check SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY, "
                     "or the legacy SUPABASE_ANON_KEY): %s",
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
    return user.id, getattr(user, "email", None) or ""


def get_current_user(authorization: str = Header(None)) -> str:
    """FastAPI dependency. Sync on purpose: FastAPI runs it in a threadpool."""
    if not authorization or not authorization.startswith("Bearer "):
        raise _unauthorized("Missing bearer token")
    return verify_token(authorization[len("Bearer "):])
