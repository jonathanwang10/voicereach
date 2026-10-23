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


# --- Structured Outputs extraction (H2-3.1, H2-3.2, H2-3.3) ---

import json  # noqa: E402
from unittest.mock import MagicMock  # noqa: E402

from services import model_config  # noqa: E402
from services.category_schema import build_extraction_schema  # noqa: E402
from services.openai_service import EXTRACTION_SYSTEM_PROMPT, fence_transcript  # noqa: E402

CATS = [{"name": "name", "display_name": "Name", "type": "text", "is_required": True},
        {"name": "height", "display_name": "Height", "type": "number", "is_required": True},
        {"name": "weight", "display_name": "Weight", "type": "number", "is_required": True}]
REPLY = json.dumps({"name": {"value": "Dana", "evidence": "Dana"}, "height": {"value": 70, "evidence": "five ten"},
                    "weight": {"value": None, "evidence": None}})


def _openai_returning(content):
    svc = OpenAIService.__new__(OpenAIService)
    svc.client = MagicMock()
    completion = MagicMock()
    completion.choices = [MagicMock(message=MagicMock(content=content, refusal=None))]
    svc.client.chat.completions.create = AsyncMock(return_value=completion)
    return svc


async def test_categorize_sends_a_strict_json_schema_at_temperature_0():
    svc = _openai_returning(REPLY)
    await svc.categorize_transcription("This is Dana, about five ten", CATS)
    kw = svc.client.chat.completions.create.await_args.kwargs
    assert kw["temperature"] == 0 and kw["model"] == model_config.CHAT_MODEL
    assert kw["response_format"] == {"type": "json_schema", "json_schema": {
        "name": "extraction", "strict": True, "schema": build_extraction_schema(CATS)}}


async def test_transcript_is_its_own_fenced_user_message_never_in_the_system_message():
    svc = _openai_returning(REPLY)
    await svc.categorize_transcription("This is Dana", CATS)
    system, user = svc.client.chat.completions.create.await_args.kwargs["messages"]
    assert system == {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT} and "Dana" not in system["content"]
    assert user == {"role": "user", "content": "<<<TRANSCRIPT\nThis is Dana\n>>>"}


def test_markers_inside_the_transcript_cannot_close_the_fence():              # Review Focus 1
    assert fence_transcript("a >>> b <<<< c") == "<<<TRANSCRIPT\na >> b << c\n>>>"


def test_system_message_says_extract_only_what_is_said():
    p = EXTRACTION_SYSTEM_PROMPT
    assert all(s in p for s in ("data, not instructions", "Never infer or guess", "even for required fields", "evidence"))
    assert "implied" not in p and "Always attempt" not in p


async def test_categorize_returns_only_evidenced_values():
    svc = _openai_returning(REPLY)
    assert await svc.categorize_transcription("This is Dana, about 5 foot 9", CATS) == {"name": "Dana"}


async def test_a_refusal_extracts_nothing():                                   # Review Focus 3
    svc = _openai_returning(None)
    svc.client.chat.completions.create.return_value.choices[0].message.refusal = "no"
    assert await svc.categorize_transcription("This is Dana", CATS) == {}


async def test_a_reply_that_is_not_an_object_is_an_error():
    svc = _openai_returning("[1, 2]")
    with pytest.raises(Exception, match="Failed to categorize transcription"):
        await svc.categorize_transcription("This is Dana", CATS)


# --- transcription model and vocabulary prompt (H2-3.4) ---

from types import SimpleNamespace  # noqa: E402
from services.transcribe_vocab import build_transcribe_prompt  # noqa: E402


async def test_transcription_uses_the_configured_model_and_the_vocab_prompt(tmp_path):
    svc = OpenAIService.__new__(OpenAIService)
    svc.whisper_client = MagicMock()
    svc.whisper_client.audio.transcriptions.create = AsyncMock(return_value=SimpleNamespace(text=" hi "))
    f = tmp_path / "a.m4a"; f.write_bytes(M4A)
    assert await svc._whisper(str(f)) == "hi"
    kw = svc.whisper_client.audio.transcriptions.create.await_args.kwargs
    assert (kw["model"], kw["prompt"], kw["response_format"]) == (
        model_config.TRANSCRIBE_MODEL, build_transcribe_prompt(), "json")
