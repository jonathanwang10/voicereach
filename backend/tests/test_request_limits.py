"""Size caps and request validation on the paid endpoints (C-12, R-4), the name length
cap (C-28), the bounded Whisper budget, and temp-file cleanup (C-65)."""
import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app

MB = 1024 * 1024


def _client():
    return TestClient(app, raise_server_exceptions=False)


# --- body caps (413) -----------------------------------------------------------------

def test_transcribe_body_over_8mb_is_413_before_any_work():
    with patch("api.transcription.create_client") as create_client:
        r = _client().post("/api/transcribe", json={"audio_data": "A" * (8 * MB + 1)})
    assert r.status_code == 413
    assert "detail" in r.json()
    create_client.assert_not_called()


def test_chunked_body_without_content_length_is_still_capped():
    """A body streamed without Content-Length is counted as it arrives."""
    from main import BodySizeLimitMiddleware

    async def inner_app(scope, receive, send):
        while (await receive()).get("more_body"):
            pass
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    chunks = [{"type": "http.request", "body": b"x" * 600, "more_body": True} for _ in range(3)]
    chunks.append({"type": "http.request", "body": b"", "more_body": False})

    async def receive():
        return chunks.pop(0)

    sent = []

    async def send(message):
        sent.append(message)

    mw = BodySizeLimitMiddleware(inner_app, {"/x": 1000})
    asyncio.run(mw({"type": "http", "path": "/x", "headers": []}, receive, send))
    assert sent[0]["status"] == 413


def test_chunked_body_through_fastapi_is_413_not_400():
    def chunks():
        for _ in range(30):
            yield b"x" * 1024
    with patch("api.individuals.get_supabase_client") as gsc:
        r = _client().post("/api/individuals/check-duplicates", content=chunks(),
                           headers={"content-type": "application/json"})
    assert r.request.headers.get("transfer-encoding") == "chunked"
    assert r.status_code == 413
    assert r.json()["detail"].startswith("Request body too large")
    gsc.assert_not_called()


def test_assistant_audio_over_3mb_is_413():
    with patch("api.voice_assistant.OpenAIService") as svc:
        r = _client().post("/api/voice-assistant/transcribe",
                           files={"audio": ("q.m4a", b"\x00" * (3 * MB + 1), "audio/m4a")})
    assert r.status_code == 413
    svc.assert_not_called()


def test_assistant_audio_under_cap_is_transcribed():
    svc = MagicMock()
    svc.return_value.transcribe_audio_file = AsyncMock(return_value="hello")
    with patch("api.voice_assistant.OpenAIService", svc):
        r = _client().post("/api/voice-assistant/transcribe",
                           files={"audio": ("q.m4a", b"\x00\x00\x00\x18ftypM4A ", "audio/m4a")})
    assert r.status_code == 200
    assert r.json()["transcription"] == "hello"


def test_check_duplicates_body_over_20kb_is_413():
    with patch("api.individuals.get_supabase_client") as gsc:
        r = _client().post("/api/individuals/check-duplicates", json={"name": "A", "notes": "x" * 21_000})
    assert r.status_code == 413
    gsc.assert_not_called()


def test_check_duplicates_needs_an_object_body():
    r = _client().post("/api/individuals/check-duplicates", json=["not", "a", "dict"])
    assert r.status_code == 422


# --- embeddings search request bounds (422) ------------------------------------------

@pytest.mark.parametrize("body", [
    {"query": "x", "top_k": -5},
    {"query": "x", "top_k": 0},
    {"query": "x", "top_k": 51},
    {"query": "x", "similarity_threshold": -0.1},
    {"query": "x", "similarity_threshold": 1.5},
    {"query": "x" * 501},
])
def test_embeddings_search_rejects_out_of_range_requests(body):
    with patch("api.embeddings.get_supabase_client") as gsc:
        r = _client().post("/api/embeddings/search", json=body)
    assert r.status_code == 422
    gsc.assert_not_called()


def test_embeddings_search_accepts_bounds():
    sb = MagicMock()
    sb.table.return_value.select.return_value.execute.return_value.data = []
    with patch("api.embeddings.get_supabase_client", return_value=sb):
        r = _client().post("/api/embeddings/search",
                           json={"query": "x" * 500, "top_k": 50, "similarity_threshold": 1})
    assert r.status_code == 200


# --- name length (C-28) --------------------------------------------------------------

def test_save_rejects_a_name_over_200_chars():
    from db.models import SaveIndividualRequest
    with pytest.raises(Exception):
        SaveIndividualRequest(data={"name": "A" * 201, "height": 70, "weight": 150})
    assert SaveIndividualRequest(data={"name": "A" * 200, "height": 70, "weight": 150})


def test_save_route_gives_422_for_a_long_name():
    r = _client().post("/api/individuals", json={"data": {"name": "A" * 201, "height": 70, "weight": 150}})
    assert r.status_code == 422


# --- audio URL download: same host as SUPABASE_URL, 5 MB cap --------------------------

def _svc():
    from services.openai_service import OpenAIService
    return OpenAIService()


@pytest.mark.parametrize("url", [
    "https://other-project.supabase.co/storage/v1/object/a.m4a",   # any *.supabase.co used to pass
    "https://127.0.0.1.evil.example/a.m4a",
    "ftp://127.0.0.1:9/a.m4a",
])
def test_audio_url_must_be_on_our_supabase_host(url, monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://ourproject.supabase.co")
    with pytest.raises(ValueError):
        asyncio.run(_svc().transcribe_audio(url))


class _StreamResponse:
    def __init__(self, chunks, status=200):
        self.chunks, self.status_code = chunks, status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def raise_for_status(self):
        pass

    async def aiter_bytes(self):
        for c in self.chunks:
            yield c


class _StreamClient:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def stream(self, method, url, **kwargs):
        assert kwargs.get("follow_redirects") is False
        return self.response


def test_audio_url_download_over_5mb_is_rejected(monkeypatch):
    from services import openai_service
    monkeypatch.setenv("SUPABASE_URL", "https://ourproject.supabase.co")
    big = _StreamResponse([b"\x00\x00\x00\x18ftyp" + b"\x00" * MB] * 6)
    monkeypatch.setattr(openai_service.httpx, "AsyncClient", lambda *a, **k: _StreamClient(big))
    svc = _svc()
    svc.whisper_client = MagicMock()
    with pytest.raises(openai_service.AudioTooLarge):
        asyncio.run(svc.transcribe_audio("https://ourproject.supabase.co/storage/v1/object/a.m4a"))
    svc.whisper_client.audio.transcriptions.create.assert_not_called()


def test_audio_url_too_large_is_413_from_the_route(monkeypatch):
    from services.openai_service import AudioTooLarge
    sb = MagicMock()
    sb.table.return_value.select.return_value.order.return_value.execute.return_value.data = [
        {"name": "name", "type": "text", "is_required": True, "options": None}]
    svc = MagicMock()
    svc.return_value.transcribe_audio = AsyncMock(side_effect=AudioTooLarge("Audio file is larger than 5 MB"))
    with patch("api.transcription.create_client", return_value=sb), \
         patch("api.transcription.OpenAIService", svc):
        r = _client().post("/api/transcribe", json={"audio_url": "https://x.supabase.co/a.m4a"})
    assert r.status_code == 413


def test_audio_url_download_within_cap_is_transcribed(monkeypatch):
    from services import openai_service
    monkeypatch.setenv("SUPABASE_URL", "https://ourproject.supabase.co")
    ok = _StreamResponse([b"\x00\x00\x00\x18ftypM4A ", b"\x00" * 100])
    monkeypatch.setattr(openai_service.httpx, "AsyncClient", lambda *a, **k: _StreamClient(ok))
    svc = _svc()
    svc.whisper_client = MagicMock()
    svc.whisper_client.audio.transcriptions.create = AsyncMock(return_value=" words ")
    text = asyncio.run(svc.transcribe_audio("https://ourproject.supabase.co/storage/v1/object/a.m4a"))
    assert text == "words"


# --- Whisper budget --------------------------------------------------------------------

def test_whisper_calls_are_not_retried():
    svc = _svc()
    assert svc.whisper_client.max_retries == 0
    assert svc.whisper_client.timeout == 60
    assert svc.client.max_retries == 1          # GPT calls keep their single retry


def test_transcribe_route_answers_before_the_app_gives_up(monkeypatch):
    from api import transcription
    monkeypatch.setattr(transcription, "TRANSCRIBE_DEADLINE_SECONDS", 0.2)
    sb = MagicMock()
    sb.table.return_value.select.return_value.order.return_value.execute.return_value.data = [
        {"name": "name", "type": "text", "is_required": True, "options": None}]

    async def slow(*a, **k):
        await asyncio.sleep(5)

    svc = MagicMock()
    svc.return_value.transcribe_audio_file = slow
    with patch("api.transcription.create_client", return_value=sb), \
         patch("api.transcription.OpenAIService", svc):
        r = _client().post("/api/transcribe", json={"audio_data": "AAAA"})
    assert r.status_code == 504
    assert transcription.TRANSCRIBE_DEADLINE_SECONDS < 120


# --- temp files are always removed (C-65) ----------------------------------------------

def test_temp_audio_file_is_removed_even_if_writing_fails(monkeypatch):
    from services import openai_service
    made = []
    real_mkstemp = openai_service.tempfile.mkstemp

    def mkstemp(*a, **k):
        fd, path = real_mkstemp(*a, **k)
        made.append(path)
        return fd, path

    class _BadFile:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def write(self, data):
            raise OSError("disk full")

    monkeypatch.setattr(openai_service.tempfile, "mkstemp", mkstemp)
    monkeypatch.setattr(openai_service.os, "fdopen", lambda fd, mode: (os.close(fd), _BadFile())[1])
    with pytest.raises(OSError):
        with openai_service.temp_audio_file(b"abc"):
            pass
    assert made and not os.path.exists(made[0])


@pytest.mark.parametrize("route,kwargs", [
    ("/api/transcribe", {"json": {"audio_data": "AAAA"}}),
    ("/api/voice-assistant/transcribe", {"files": {"audio": ("q.m4a", b"\x00\x00\x00\x18ftypM4A ", "audio/m4a")}}),
])
def test_routes_remove_their_temp_file_when_whisper_fails(route, kwargs):
    seen = []

    async def failing(path):
        seen.append(path)
        assert os.path.exists(path)
        raise RuntimeError("whisper down")

    sb = MagicMock()
    sb.table.return_value.select.return_value.order.return_value.execute.return_value.data = [
        {"name": "name", "type": "text", "is_required": True, "options": None}]
    svc = MagicMock()
    svc.return_value.transcribe_audio_file = failing
    with patch("api.transcription.create_client", return_value=sb), \
         patch("api.transcription.OpenAIService", svc), \
         patch("api.voice_assistant.OpenAIService", svc):
        r = _client().post(route, **kwargs)
    assert r.status_code == 500
    assert seen and not os.path.exists(seen[0])
