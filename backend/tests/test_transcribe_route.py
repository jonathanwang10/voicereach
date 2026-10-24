"""POST /api/transcribe with OpenAI and duplicate detection mocked and a strict FakeSupabase.

The normalised output and the duplicate_check_failed flag are covered in
test_normalised_paths.py and test_duplicate_service_unit.py; the missing-audio 400 in
test_error_contract.py. This file covers the rest of the route's contract.
"""
import base64
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app
from services.openai_service import AudioTooLarge
from tests.helpers import FakeSupabase

CATEGORIES = [
    {"id": "c1", "name": "name", "display_name": "Name", "type": "text", "is_required": True, "options": None},
    {"id": "c2", "name": "height", "display_name": "Height", "type": "number", "is_required": True, "options": None},
    {"id": "c3", "name": "weight", "display_name": "Weight", "type": "number", "is_required": True, "options": None},
    {"id": "c4", "name": "gender", "display_name": "Gender", "type": "single_select", "is_required": False,
     "options": [{"label": "Male", "value": 0}, {"label": "Female", "value": 0}]},
]
MATCH = {"id": "550e8400-e29b-41d4-a716-446655440001", "name": "Ann Lee", "confidence": 90}
AUDIO_URL = "https://proj.supabase.co/storage/v1/object/audio/u/1.m4a"


def _run(body, categorized=None, categories=CATEGORIES, openai=None, matches=(MATCH,)):
    """POST body; returns (response, openai mock, FakeSupabase, find_duplicates mock)."""
    if openai is None:
        openai = MagicMock()
        openai.transcribe_audio = AsyncMock(return_value="Met Ann, about 5 foot 10")
        openai.transcribe_audio_file = AsyncMock(return_value="Met Ann, about 5 foot 10")
        openai.categorize_transcription = AsyncMock(
            return_value=categorized if categorized is not None else {"name": "Ann Lee", "height": "5'10"})
    sb = FakeSupabase().on("categories", "select", data=categories)
    dup = MagicMock()
    dup.return_value.find_duplicates = AsyncMock(return_value=list(matches))
    with patch("api.transcription.get_openai_service", return_value=openai), \
         patch("api.transcription.get_supabase", return_value=sb), \
         patch("services.recording_pipeline.DuplicateDetectionService", dup):
        response = TestClient(app).post("/api/transcribe", json=body)
    return response, openai, sb, dup.return_value.find_duplicates


def test_audio_url_is_transcribed_categorised_validated_and_checked_for_duplicates():
    r, openai, sb, find_duplicates = _run({"audio_url": AUDIO_URL})
    assert r.status_code == 200, r.text
    assert r.json() == {
        "transcription": "Met Ann, about 5 foot 10",
        "categorized_data": {"name": "Ann Lee", "height": 70},
        "missing_required": ["weight"],
        "potential_matches": [MATCH],
        "validation_errors": [],
        "duplicate_check_failed": False,
    }
    openai.transcribe_audio.assert_awaited_once_with(AUDIO_URL)
    openai.transcribe_audio_file.assert_not_called()
    find_duplicates.assert_awaited_once()
    assert find_duplicates.await_args.args[0] == {"name": "Ann Lee", "height": 70}  # the normalised data
    assert [c["name"] for c in find_duplicates.await_args.kwargs["categories"]] == [c["name"] for c in CATEGORIES]
    [q] = sb.calls
    assert (q.table, q.verb, q.mod("order")) == ("categories", "select", (("created_at",), {}))


def test_gpt_gets_every_category_with_its_type_required_flag_and_options():
    _, openai, _, _ = _run({"audio_url": AUDIO_URL})
    text, categories = openai.categorize_transcription.await_args.args
    assert text == "Met Ann, about 5 foot 10"
    assert categories == [{"name": c["name"], "display_name": c.get("display_name"), "type": c["type"],
                           "is_required": c["is_required"], "is_sensitive": c.get("is_sensitive", False),
                           "options": c["options"]} for c in CATEGORIES]


def test_invalid_values_come_back_as_validation_errors():
    r, _, _, _ = _run({"audio_url": AUDIO_URL},
                      categorized={"name": "Ann", "height": 400, "weight": 150, "gender": "robot"})
    assert r.status_code == 200, r.text
    assert {e["field"] for e in r.json()["validation_errors"]} == {"height", "gender"}


def test_base64_audio_goes_through_a_temp_m4a_file_that_is_removed():
    seen = {}

    async def transcribe_file(path):
        with open(path, "rb") as f:
            seen["path"], seen["bytes"] = path, f.read()
        return "Met Ann"

    openai = MagicMock()
    openai.transcribe_audio_file = AsyncMock(side_effect=transcribe_file)
    openai.categorize_transcription = AsyncMock(return_value={"name": "Ann"})
    audio = b"\x00\x00\x00\x18ftypM4A audio"
    data_url = "data:audio/m4a;base64," + base64.b64encode(audio).decode()
    r, _, _, _ = _run({"audio_data": data_url}, openai=openai)
    assert r.status_code == 200, r.text
    assert seen["path"].endswith(".m4a")
    assert seen["bytes"] == audio  # the data-URL prefix was stripped before decoding
    assert not os.path.exists(seen["path"])


def test_temp_file_is_removed_when_whisper_fails():
    seen = {}

    async def transcribe_file(path):
        seen["path"] = path
        raise RuntimeError("upstream down")

    openai = MagicMock()
    openai.transcribe_audio_file = AsyncMock(side_effect=transcribe_file)
    r, _, _, _ = _run({"audio_data": base64.b64encode(b"ftyp").decode()}, openai=openai)
    assert r.status_code == 500
    assert r.json() == {"detail": "Transcription failed"}
    assert not os.path.exists(seen["path"])


def test_invalid_base64_is_a_400_not_a_500():
    r, openai, _, _ = _run({"audio_data": "not base64!"})
    assert r.status_code == 400
    openai.transcribe_audio_file.assert_not_called()


@pytest.mark.parametrize("error,status,detail", [
    (ValueError("URL must be from this project's Supabase Storage"), 400,
     "URL must be from this project's Supabase Storage"),
    (ValueError("Audio must be at least 5 seconds long"), 400, "Audio must be at least 5 seconds long"),
    (AudioTooLarge("Audio file is larger than 5 MB"), 413, "Audio file is larger than 5 MB"),
    (RuntimeError("secret upstream detail"), 500, "Transcription failed"),
])
def test_transcription_errors_map_to_status_codes(error, status, detail):
    openai = MagicMock()
    openai.transcribe_audio = AsyncMock(side_effect=error)
    r, _, _, find_duplicates = _run({"audio_url": AUDIO_URL}, openai=openai)
    assert r.status_code == status
    assert r.json() == {"detail": detail}
    find_duplicates.assert_not_called()


def test_no_categories_is_a_500_before_any_openai_call():
    r, openai, _, _ = _run({"audio_url": AUDIO_URL}, categories=[])
    assert r.status_code == 500
    assert "No categories found" in r.json()["detail"]
    openai.transcribe_audio.assert_not_called()


def test_transcribe_route_is_marked_deprecated():
    from api.transcription import router
    route = next(r for r in router.routes if getattr(r, "path", "") == "/api/transcribe")
    assert route.deprecated is True
