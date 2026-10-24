"""The server re-checks recording length with mutagen (H2-1.10)."""
import base64
from unittest.mock import AsyncMock, patch
import pytest
from fastapi.testclient import TestClient
from main import app
from services import openai_service
from services.openai_service import (OpenAIService, RECORDING_LIMITS,
                                     audio_duration_seconds, check_audio_duration)
from tests.helpers import FakeSupabase, fixture_audio

def _write(tmp_path, data):
    p = tmp_path / "a.m4a"; p.write_bytes(data); return str(p)

def test_duration_of_a_real_m4a(tmp_path):
    assert 6 < audio_duration_seconds(_write(tmp_path, fixture_audio("audio_6s.m4a"))) < 6.5

def test_m4a_header_that_mutagen_cannot_read_is_not_m4a(tmp_path):       # Review Focus 5
    with pytest.raises(ValueError, match="^File is not in M4A format$"):
        audio_duration_seconds(_write(tmp_path, b"\x00\x00\x00\x18ftypM4A " + b"x" * 100))

@pytest.mark.parametrize("seconds,error", [(4.9, "Audio must be at least 5 seconds long"), (5.0, None),
                                           (125.0, None), (125.1, "Audio must be less than 2 minutes")])
def test_recording_limits(monkeypatch, seconds, error):
    monkeypatch.setattr(openai_service, "audio_duration_seconds", lambda path: seconds)
    if error:
        with pytest.raises(ValueError, match=f"^{error}$"): check_audio_duration("x", RECORDING_LIMITS)
    else:
        assert check_audio_duration("x", RECORDING_LIMITS) == seconds

async def test_short_recording_never_reaches_whisper(tmp_path):
    svc = OpenAIService(); svc._whisper = AsyncMock(return_value="x")
    with pytest.raises(ValueError, match="at least 5 seconds"):
        await svc.transcribe_audio_file(_write(tmp_path, fixture_audio("audio_2s.m4a")))
    svc._whisper.assert_not_awaited()

def test_transcribe_route_rejects_a_2s_recording_with_400():
    svc = OpenAIService(); svc._whisper = AsyncMock(return_value="x")
    sb = FakeSupabase().on("categories", "select",
                           data=[{"name": "name", "type": "text", "is_required": True, "options": None}])
    with patch("api.transcription.get_supabase", return_value=sb), \
         patch("api.transcription.get_openai_service", return_value=svc):
        r = TestClient(app).post("/api/transcribe",
                                 json={"audio_data": base64.b64encode(fixture_audio("audio_2s.m4a")).decode()})
    assert (r.status_code, r.json()) == (400, {"detail": "Audio must be at least 5 seconds long"})
    svc._whisper.assert_not_awaited()

