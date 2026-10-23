"""Error contract (C-16, C-17, C-37, C-40, C-66; R-13).

- Client errors raised inside a route's try block keep their status (no 500 rewrap).
- Every 500 carries a fixed "<action> failed" detail; the exception text never reaches
  the client, and the server log names only the exception type.
- Services re-raise database errors instead of turning them into "not found" or [].
- OpenAI clients have short timeouts; CORS comes from CORS_ALLOW_ORIGINS without credentials.
"""
import asyncio
import logging
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from main import app

SECRET = 'relation "individuals" violates constraint fk_secret_42 for Jane Doe'


def _broken_supabase():
    sb = MagicMock()
    sb.table.side_effect = RuntimeError(SECRET)
    return sb


def _client():
    return TestClient(app, raise_server_exceptions=False)


# --- internal_error -------------------------------------------------------------------

def test_internal_error_is_generic_and_logs_only_the_type(caplog):
    from api.errors import internal_error

    with caplog.at_level(logging.ERROR):
        exc = internal_error("Save individual", RuntimeError(SECRET))
    assert isinstance(exc, HTTPException)
    assert exc.status_code == 500
    assert exc.detail == "Save individual failed"
    assert "RuntimeError" in caplog.text
    assert "Save individual" in caplog.text
    assert "fk_secret_42" not in caplog.text
    assert "Jane Doe" not in caplog.text


# --- 500s are generic, on every route -------------------------------------------------

IND_ID = str(uuid4())
BROKEN_ROUTES = [
    ("get", "/api/categories", None, "api.categories.get_supabase"),
    ("post", "/api/categories", {"name": "Shoes", "type": "text", "priority": "low"}, "api.categories.get_supabase"),
    ("get", "/api/export", None, "api.categories.get_supabase"),
    ("get", "/api/individuals", None, "api.individuals.get_supabase"),
    ("get", f"/api/individuals/{IND_ID}", None, "api.individuals.get_supabase"),
    ("get", f"/api/individuals/{IND_ID}/interactions", None, "api.individuals.get_supabase"),
    ("put", f"/api/individuals/{IND_ID}/urgency-override", {"urgency_override": 50}, "api.individuals.get_supabase"),
    ("post", "/api/individuals", {"data": {"name": "Ann", "height": 60, "weight": 120}}, "api.individuals.get_supabase"),
    ("post", "/api/embeddings/search", {"query": "veteran"}, "api.embeddings.get_supabase"),
    ("post", "/api/embeddings/generate", {"individual_id": IND_ID}, "api.embeddings.get_supabase"),
    ("post", "/api/embeddings/generate-all", None, "api.embeddings.get_supabase"),
    ("get", "/api/embeddings/status", None, "api.embeddings.get_supabase"),
    ("post", "/api/transcribe", {"audio_data": "AAAA"}, "api.transcription.get_supabase"),
]


@pytest.mark.parametrize("method,path,body,target", BROKEN_ROUTES)
def test_database_failure_returns_generic_500(method, path, body, target):
    with patch(target, return_value=_broken_supabase()), \
         patch("api.transcription.get_openai_service"):
        kwargs = {"json": body} if body is not None else {}
        response = getattr(_client(), method)(path, **kwargs)
    assert response.status_code == 500, response.text
    detail = response.json()["detail"]
    assert isinstance(detail, str) and detail.endswith(" failed")
    assert "fk_secret_42" not in response.text
    assert "Jane Doe" not in response.text


def test_check_duplicates_failure_is_generic_500():
    dup = MagicMock()
    dup.return_value.find_duplicates = AsyncMock(side_effect=RuntimeError(SECRET))
    with patch("api.individuals.get_supabase", return_value=MagicMock()), \
         patch("api.individuals.get_openai_service"), \
         patch("api.individuals.DuplicateDetectionService", dup):
        response = _client().post("/api/individuals/check-duplicates", json={"name": "Ann"})
    assert response.status_code == 500
    assert response.json() == {"detail": "Duplicate check failed"}


def test_assistant_transcribe_failure_is_generic_500():
    svc = MagicMock()
    svc.return_value.transcribe_audio_file = AsyncMock(side_effect=RuntimeError(SECRET))
    with patch("api.voice_assistant.get_openai_service", svc):
        response = _client().post(
            "/api/voice-assistant/transcribe",
            files={"audio": ("q.m4a", b"\x00\x00\x00\x18ftypM4A ", "audio/m4a")},
        )
    assert response.status_code == 500
    assert "fk_secret_42" not in response.text


def test_assistant_context_failure_is_generic_500():
    ctx = MagicMock()
    ctx.get_context_for_message = AsyncMock(side_effect=RuntimeError(SECRET))
    with patch("api.voice_assistant.get_context_service", return_value=ctx):
        response = _client().post("/api/voice-assistant/context", json={"message": "Is John ok?"})
    assert response.status_code == 500
    assert "fk_secret_42" not in response.text


# --- client errors keep their status (C-40) -------------------------------------------

def _categories_supabase():
    sb = MagicMock()
    sb.table.return_value.select.return_value.order.return_value.execute.return_value.data = [
        {"name": "name", "type": "text", "is_required": True, "options": None}]
    return sb


def test_transcribe_without_audio_is_400_not_500():
    with patch("api.transcription.get_supabase", return_value=_categories_supabase()), \
         patch("api.transcription.get_openai_service"):
        response = _client().post("/api/transcribe", json={})
    assert response.status_code == 400
    assert response.json() == {"detail": "Either audio_url or audio_data must be provided"}


def test_assistant_transcribe_non_audio_is_400_not_500():
    response = _client().post(
        "/api/voice-assistant/transcribe", files={"audio": ("x.txt", b"hello", "text/plain")})
    assert response.status_code == 400
    assert response.json() == {"detail": "File must be an audio file"}


def test_generate_embedding_missing_individual_is_404_not_500():
    sb = MagicMock()
    sb.table.return_value.select.return_value.eq.return_value.execute.return_value.data = []
    with patch("api.embeddings.get_supabase", return_value=sb):
        response = _client().post("/api/embeddings/generate", json={"individual_id": IND_ID})
    assert response.status_code == 404
    assert response.json() == {"detail": "Individual not found"}


def test_generate_embedding_malformed_id_is_422():
    with patch("api.embeddings.get_supabase", return_value=_broken_supabase()):
        response = _client().post("/api/embeddings/generate", json={"individual_id": "not-a-uuid"})
    assert response.status_code == 422


# --- services re-raise instead of hiding outages (C-17) -------------------------------

def test_profile_on_database_outage_is_500_not_404():
    with patch("api.individuals.get_supabase", return_value=_broken_supabase()):
        response = _client().get(f"/api/individuals/{IND_ID}")
    assert response.status_code == 500


def test_search_on_database_outage_is_500_not_empty_200():
    with patch("api.individuals.get_supabase", return_value=_broken_supabase()):
        response = _client().get("/api/individuals?search=ann")
    assert response.status_code == 500


def test_service_get_individual_by_id_reraises_database_errors():
    from services.individual_service import IndividualService
    with pytest.raises(RuntimeError):
        asyncio.run(IndividualService(_broken_supabase()).get_individual_by_id(uuid4()))


def test_service_get_individual_by_id_zero_rows_is_none():
    from services.individual_service import IndividualService
    sb = MagicMock()
    sb.table.return_value.select.return_value.eq.return_value.maybe_single.return_value.execute.return_value = None
    assert asyncio.run(IndividualService(sb).get_individual_by_id(uuid4())) is None


def test_service_search_reraises_database_errors():
    from services.individual_service import IndividualService
    with pytest.raises(RuntimeError):
        asyncio.run(IndividualService(_broken_supabase()).search_individuals(search="ann"))


# --- OpenAI timeouts (C-37) -----------------------------------------------------------

def test_openai_clients_have_short_timeouts():
    from services.openai_service import OpenAIService
    from services.embedding_service import EmbeddingService
    for svc in (OpenAIService(), EmbeddingService()):
        assert svc.client.timeout == 30
        assert svc.client.max_retries == 1
    assert not hasattr(OpenAIService, "_recreate_client")


def test_whisper_call_gets_a_60s_timeout(tmp_path):
    from services.openai_service import OpenAIService
    audio = tmp_path / "a.m4a"
    from tests.helpers import fixture_audio
    audio.write_bytes(fixture_audio("audio_6s.m4a"))
    svc = OpenAIService()
    from types import SimpleNamespace
    create = AsyncMock(return_value=SimpleNamespace(text=" hi "))   # response_format="json" (H2-3.4)
    with patch.object(svc.whisper_client.audio.transcriptions, "create", create):
        assert asyncio.run(svc.transcribe_audio_file(str(audio))) == "hi"
    assert create.call_args.kwargs["timeout"] == 60


# --- CORS (C-66) ----------------------------------------------------------------------

def test_cors_origins_parsing():
    from main import cors_allow_origins
    assert cors_allow_origins(None) == []
    assert cors_allow_origins("") == []
    assert cors_allow_origins(" https://a.example , https://b.example ,") == [
        "https://a.example", "https://b.example"]


def test_cors_middleware_has_no_credentials_and_no_wildcard():
    cors = [m for m in app.user_middleware if m.cls is CORSMiddleware]
    assert len(cors) == 1
    options = cors[0].kwargs
    assert options["allow_credentials"] is False
    assert "*" not in options["allow_origins"]


def test_cors_does_not_reflect_unknown_origin():
    response = _client().get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in response.headers


# --- WebSocket error text (C-66) ------------------------------------------------------

class _FakeHttpx:
    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, *a, **k):
        r = MagicMock()
        r.is_success = False
        r.status_code = 401
        r.text = '{"error": "Incorrect API key provided: sk-live-SECRETKEY"}'
        return r


def test_ws_upstream_failure_sends_generic_error(monkeypatch):
    import main
    monkeypatch.setattr(main, "verify_token", lambda token: "user-1")
    monkeypatch.setattr(main.httpx, "AsyncClient", _FakeHttpx)
    with _client().websocket_connect(
        "/api/voice-assistant/realtime/ws", headers={"Authorization": "Bearer t"}
    ) as ws:
        message = ws.receive_json()
    assert message["type"] == "error"
    assert "SECRETKEY" not in str(message)
    assert "Incorrect API key" not in str(message)


# --- error mapping (H2-1.4) -----------------------------------------------------------

from tests.test_individuals_routes import ID, T1, _db  # noqa: E402


def test_merge_whose_target_is_deleted_before_the_update_is_404():
    from tests.helpers import pg_error
    sb = _db()                                 # the service's read sees EXISTING
    sb.rules = [r for r in sb.rules if r.verb != "rpc"]
    sb.on_rpc("save_individual", error=pg_error("P0002"))   # ...then save_individual finds no row
    with patch("api.individuals.get_supabase", return_value=sb):
        r = _client().post("/api/individuals", json={"data": {"name": "Ann Lee", "height": 70, "weight": 150},
                                                     "merge_with_id": ID})
    assert (r.status_code, r.json()) == (404, {"detail": f"Individual not found: {ID}"})
    assert sb.calls_to("interactions", "insert") == []


def test_bad_stored_row_on_save_is_a_generic_500_that_echoes_nothing():
    from tests.helpers import save_rpc
    sb = _db(existing=None)
    sb.rules = [r for r in sb.rules if r.verb != "rpc"]

    def bad_row(call):
        out = save_rpc(None, new_id=ID, at=T1)(call)
        out["individual"]["urgency_score"] = "SECRET-not-a-number"
        return out
    sb.on_rpc("save_individual", data=bad_row)
    with patch("api.individuals.get_supabase", return_value=sb):
        r = _client().post("/api/individuals", json={"data": {"name": "Ann", "height": 70, "weight": 150}})
    assert (r.status_code, r.json()) == (500, {"detail": "Save individual failed"})
    assert "SECRET" not in r.text


def test_bad_match_shape_on_transcribe_is_a_generic_500_that_echoes_nothing():
    from tests.helpers import FakeSupabase
    sb = FakeSupabase().on("categories", "select",
                           data=[{"name": "name", "type": "text", "is_required": True, "options": None}])
    openai = MagicMock()
    openai.transcribe_audio_file = AsyncMock(return_value="t")
    openai.categorize_transcription = AsyncMock(return_value={})
    dup = MagicMock()
    dup.return_value.find_duplicates = AsyncMock(return_value=["SECRET-MATCH"])
    with patch("api.transcription.get_supabase", return_value=sb), \
         patch("api.transcription.get_openai_service", return_value=openai), \
         patch("services.duplicate_detection_service.DuplicateDetectionService", dup):
        r = _client().post("/api/transcribe", json={"audio_data": "AAAA"})
    assert (r.status_code, r.json()) == (500, {"detail": "Transcription failed"})
    assert "SECRET" not in r.text
