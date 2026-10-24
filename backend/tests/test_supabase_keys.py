"""Supabase's new keys (H2-8.3): `sb_secret_...` and `sb_publishable_...` are read first,
the legacy service-role and anon keys are the fallback until they are disabled."""
import re
from pathlib import Path

import pytest
from fastapi import HTTPException

from api import auth
from api.auth import supabase_public_key
from db import client as db_client
from db.client import supabase_secret_key

BACKEND = Path(__file__).resolve().parents[1]
KEY_NAMES = ("SUPABASE_SERVICE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY")


def test_secret_key_preferred_over_service_key(monkeypatch):
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_new")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "legacy")
    assert supabase_secret_key() == "sb_secret_new"


def test_service_key_is_the_fallback(monkeypatch):
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "legacy")
    assert supabase_secret_key() == "legacy"


def test_publishable_key_preferred_over_anon_key(monkeypatch):
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_new")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "legacy")
    assert supabase_public_key() == "sb_publishable_new"


def test_anon_key_is_the_fallback(monkeypatch):
    monkeypatch.delenv("SUPABASE_PUBLISHABLE_KEY", raising=False)
    monkeypatch.setenv("SUPABASE_ANON_KEY", "legacy")
    assert supabase_public_key() == "legacy"


def test_blank_values_count_as_unset(monkeypatch):
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "  ")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "legacy")
    assert supabase_secret_key() == "legacy"


@pytest.mark.real_auth
def test_missing_public_key_gives_503(monkeypatch):
    monkeypatch.delenv("SUPABASE_PUBLISHABLE_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_ANON_KEY", raising=False)
    auth._cache.clear()
    auth._auth_client = None
    with pytest.raises(HTTPException) as exc:
        auth.verify_token("not-a-jwt")
    assert exc.value.status_code == 503 and exc.value.detail == "Auth service unavailable"


def test_get_supabase_error_names_both_variables(monkeypatch):
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    db_client._client = None
    with pytest.raises(RuntimeError) as exc:
        db_client.get_supabase()
    assert "SUPABASE_SECRET_KEY" in str(exc.value) and "SUPABASE_SERVICE_KEY" in str(exc.value)


def test_only_the_two_helpers_read_key_variables():
    allowed = {BACKEND / "db" / "client.py", BACKEND / "api" / "auth.py"}
    offenders = []
    for path in BACKEND.rglob("*.py"):
        if "tests" in path.relative_to(BACKEND).parts or ".venv" in path.parts or path in allowed:
            continue
        text = path.read_text()
        if any(re.search(rf"\b{name}\b", text) for name in KEY_NAMES):
            offenders.append(str(path.relative_to(BACKEND)))
    assert offenders == []
