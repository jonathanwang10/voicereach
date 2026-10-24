"""ES256/RS256 access tokens are verified locally against the project's JWKS (H2-8.3):
no Auth round trip, keys cached 10 minutes, one re-fetch for a key id rotated in
since. HS256 and anything else still go to auth.get_user. Keys are made at runtime:
no literal JWT is in this file."""
import os
import time
from unittest.mock import MagicMock

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi import HTTPException

from api import auth
from api.auth import NOT_ALLOWED_DETAIL, verify_token

pytestmark = pytest.mark.real_auth

EC_KEY = ec.generate_private_key(ec.SECP256R1())
NEW_KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_KEY = ec.generate_private_key(ec.SECP256R1())
RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _jwk(private, kid, alg):
    algorithm = jwt.algorithms.ECAlgorithm if alg == "ES256" else jwt.algorithms.RSAAlgorithm
    key = algorithm.to_jwk(private.public_key(), as_dict=True)
    return {**key, "kid": kid, "alg": alg, "use": "sig"}


state = {"keys": [], "calls": 0, "error": None}


@pytest.fixture(autouse=True)
def jwks(monkeypatch):
    state.update(keys=[_jwk(EC_KEY, "k1", "ES256"), _jwk(RSA_KEY, "r1", "RS256")], calls=0, error=None)

    def fetch_data(self):
        state["calls"] += 1
        if state["error"]:
            raise state["error"]
        return {"keys": list(state["keys"])}
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", fetch_data)
    auth._cache.clear()
    auth._jwks = None
    yield
    auth._jwks = None


@pytest.fixture
def get_user(monkeypatch):
    client = MagicMock()
    client.auth.get_user.return_value = MagicMock(user=MagicMock(id="user-hs", email="worker@example.org"))
    monkeypatch.setattr(auth, "_get_auth_client", lambda: client)
    return client.auth.get_user


def make_token(key=EC_KEY, kid="k1", alg="ES256", **claims):
    body = {"sub": "user-es", "email": "worker@example.org", "aud": "authenticated",
            "iss": os.environ["SUPABASE_URL"].rstrip("/") + "/auth/v1", "exp": int(time.time()) + 3600}
    body.update(claims)
    return jwt.encode(body, key, algorithm=alg, headers={"kid": kid})


def test_es256_token_is_verified_locally_without_get_user(get_user):
    assert verify_token(make_token()) == "user-es"
    get_user.assert_not_called()


def test_rs256_token_is_verified_locally(get_user):
    assert verify_token(make_token(key=RSA_KEY, kid="r1", alg="RS256", sub="user-rs")) == "user-rs"
    get_user.assert_not_called()


def test_jwks_is_fetched_once_and_cached_for_ten_minutes(get_user):
    verify_token(make_token(sub="a"))
    verify_token(make_token(sub="b"))
    assert state["calls"] == 1 and auth._jwks_client().jwk_set_cache.lifespan == 600


def test_rotated_signing_key_is_refetched_once(get_user):
    state["keys"] = [_jwk(EC_KEY, "k1", "ES256")]
    verify_token(make_token(sub="a"))
    state["keys"] = [_jwk(EC_KEY, "k1", "ES256"), _jwk(NEW_KEY, "k2", "ES256")]
    assert verify_token(make_token(key=NEW_KEY, kid="k2", sub="b")) == "b"
    assert state["calls"] == 2


@pytest.mark.parametrize("claims", [{"exp": int(time.time()) - 10}, {"aud": "anon"},
                                    {"iss": "https://evil.example/auth/v1"}])
def test_bad_claims_are_401_without_get_user(get_user, claims):
    with pytest.raises(HTTPException) as exc:
        verify_token(make_token(**claims))
    assert exc.value.status_code == 401
    get_user.assert_not_called()


def test_bad_signature_is_401(get_user):
    with pytest.raises(HTTPException) as exc:
        verify_token(make_token(key=OTHER_KEY, kid="k1"))
    assert exc.value.status_code == 401
    get_user.assert_not_called()


def test_unknown_kid_is_401(get_user):
    with pytest.raises(HTTPException) as exc:
        verify_token(make_token(kid="nope"))
    assert exc.value.status_code == 401
    get_user.assert_not_called()


def test_hs256_token_falls_back_to_get_user(get_user):
    token = jwt.encode({"sub": "user-hs", "aud": "authenticated"}, "secret-long-enough-for-hs256-1234", "HS256")
    assert verify_token(token) == "user-hs"
    get_user.assert_called_once_with(token)


def test_a_non_jwt_falls_back_to_get_user(get_user):
    assert verify_token("not-a-jwt") == "user-hs"
    get_user.assert_called_once()


def test_jwks_unreachable_falls_back_to_get_user(get_user):
    state["error"] = jwt.PyJWKClientConnectionError("down")
    assert verify_token(make_token()) == "user-hs"
    get_user.assert_called_once()


def test_allowlist_applies_to_locally_verified_tokens(monkeypatch, get_user):
    monkeypatch.setenv("ALLOWED_USER_EMAILS", "demo@sfgov.org")
    with pytest.raises(HTTPException) as exc:
        verify_token(make_token())
    assert exc.value.status_code == 403 and exc.value.detail == NOT_ALLOWED_DETAIL


def test_a_locally_verified_token_is_cached(get_user):
    token = make_token()
    verify_token(token)
    state["error"] = RuntimeError("must not fetch again")
    assert verify_token(token) == "user-es"


def test_supabase_url_trailing_slash_is_normalised(monkeypatch, get_user):
    monkeypatch.setenv("SUPABASE_URL", "http://127.0.0.1:9/")
    auth._jwks = None
    assert auth._jwks_client().uri == "http://127.0.0.1:9/auth/v1/.well-known/jwks.json"
    assert verify_token(make_token(iss="http://127.0.0.1:9/auth/v1")) == "user-es"
