"""OpenAIService: height parsing and the audio-URL guards of transcribe_audio (no network)."""
import asyncio
from unittest.mock import AsyncMock

import pytest

from services.openai_service import OpenAIService
from tests.helpers import fixture_audio

M4A = fixture_audio("audio_6s.m4a")
PROJECT_URL = "https://proj.supabase.co"


@pytest.mark.parametrize("raw,expected", [
    ("5 ft 10", 70), ("5 feet 10 inches", 70), ("5'10", 70), ("5' 10\"", 70),
    ("6 feet", 72),
    ("6 ft 180 lbs", 72), ("5 foot 150 pounds", 60), ("5'", 60), ("5 ft", 60), ("6 foot 2", 74), ("70 inches", 70), ("70", 70),
    ("5 feet, 10 inches", 70), ("6 ft, 2 in", 74),
])
def test_parse_height(raw, expected):
    assert OpenAIService.__new__(OpenAIService)._parse_height(raw) == expected


@pytest.fixture
def svc(monkeypatch):
    """A service whose download and Whisper call are fakes; SUPABASE_URL is PROJECT_URL."""
    monkeypatch.setenv("SUPABASE_URL", PROJECT_URL)
    s = OpenAIService.__new__(OpenAIService)
    s._download_audio = AsyncMock(return_value=M4A)
    s._whisper = AsyncMock(return_value="Met Ann by the library")
    return s


def _transcribe(svc, url):
    return asyncio.run(svc.transcribe_audio(url))


@pytest.mark.parametrize("url", ["not-a-url", "ftp://proj.supabase.co/a.m4a", "https:///a.m4a"])
def test_malformed_url_is_rejected_before_any_download(svc, url):
    with pytest.raises(ValueError, match="Invalid URL format"):
        _transcribe(svc, url)
    svc._download_audio.assert_not_called()


@pytest.mark.parametrize("url", [
    "https://other.supabase.co/storage/v1/object/audio/a.m4a",   # another Supabase project
    "https://proj.supabase.co.evil.com/storage/a.m4a",            # lookalike
    "https://example.com/a.m4a",
])
def test_url_on_another_host_is_rejected_before_any_download(svc, url):
    with pytest.raises(ValueError, match="this project's Supabase Storage"):
        _transcribe(svc, url)
    svc._download_audio.assert_not_called()


def test_non_m4a_content_is_rejected_before_whisper(svc):
    svc._download_audio.return_value = b"ID3\x03\x00 an mp3 file"
    with pytest.raises(ValueError, match="not in M4A format"):
        _transcribe(svc, f"{PROJECT_URL}/storage/v1/object/audio/a.mp3")
    svc._whisper.assert_not_called()


def test_m4a_from_this_project_is_transcribed(svc):
    url = f"{PROJECT_URL}/storage/v1/object/audio/a.m4a"
    assert _transcribe(svc, url) == "Met Ann by the library"
    svc._download_audio.assert_awaited_once_with(url)


import openai
from services.openai_service import QUESTION_LIMITS
from tests.helpers import openai_bad_request

URL = f"{PROJECT_URL}/storage/v1/object/audio/a.m4a"

@pytest.mark.parametrize("code,message", [("audio_too_short", "Audio must be at least 5 seconds long"),
                                          ("audio_too_long", "Audio must be less than 2 minutes")])
def test_typed_whisper_errors_become_client_messages(svc, code, message):
    svc._whisper.side_effect = openai_bad_request(code)
    with pytest.raises(ValueError) as exc:
        _transcribe(svc, URL)
    assert str(exc.value) == message

def test_error_text_alone_is_no_longer_matched(svc):
    svc._whisper.side_effect = RuntimeError("Audio file is too short")
    with pytest.raises(RuntimeError):
        _transcribe(svc, URL)

def test_other_bad_requests_propagate(svc):
    svc._whisper.side_effect = openai_bad_request("invalid_value", param="model")
    with pytest.raises(openai.BadRequestError):
        _transcribe(svc, URL)

async def test_short_question_message_never_says_5_seconds(tmp_path):
    path = tmp_path / "q.m4a"; path.write_bytes(fixture_audio("audio_2s.m4a"))
    s = OpenAIService(); s._whisper = AsyncMock(side_effect=openai_bad_request("audio_too_short"))
    with pytest.raises(ValueError) as exc:
        await s.transcribe_audio_file(str(path), limits=QUESTION_LIMITS)
    assert str(exc.value) == "Question must be at least 1 second long" and "5 seconds" not in str(exc.value)


from pathlib import Path
from services.openai_service import get_openai_service

def test_get_openai_service_returns_one_shared_service():
    assert get_openai_service() is get_openai_service()
    assert isinstance(get_openai_service(), OpenAIService)

def test_no_route_builds_its_own_openai_service():
    api_dir = Path(__file__).resolve().parents[1] / "api"
    assert not [p.name for p in api_dir.glob("*.py") if "OpenAIService()" in p.read_text()]
