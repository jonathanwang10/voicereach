"""Read-only smoke test against a running backend and its real Supabase project.

    VOICEREACH_API_URL=http://localhost:8001 VOICEREACH_LIVE_TOKEN=<access token> \
        python -m pytest backend/tests/integration

The token is a Supabase access token for a user the backend accepts (see
ALLOWED_USER_EMAILS). Nothing here writes data or calls OpenAI.
"""
import httpx
import pytest

from tests.integration.conftest import API_URL, LIVE_TOKEN

pytestmark = pytest.mark.real_auth  # the live server checks the token, not the test fake


@pytest.fixture
def api():
    with httpx.Client(base_url=API_URL, timeout=15) as client:
        yield client


@pytest.fixture
def auth():
    return {"Authorization": f"Bearer {LIVE_TOKEN}"}


def test_health(api):
    r = api.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_api_rejects_a_missing_token(api):
    r = api.get("/api/individuals")
    assert r.status_code == 401
    assert r.json() == {"detail": "Missing bearer token"}


def test_api_rejects_a_bad_token(api):
    r = api.get("/api/individuals", headers={"Authorization": "Bearer not-a-real-token"})
    assert r.status_code == 401


def test_categories_include_the_required_presets(api, auth):
    r = api.get("/api/categories", headers=auth)
    assert r.status_code == 200, r.text
    by_name = {c["name"]: c for c in r.json()["categories"]}
    for required in ("name", "height", "weight"):
        assert by_name[required]["is_required"] is True


def test_list_individuals(api, auth):
    r = api.get("/api/individuals", params={"limit": 5}, headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["limit"], body["offset"]) == (5, 0)
    assert len(body["individuals"]) <= 5 and body["total"] >= len(body["individuals"])
