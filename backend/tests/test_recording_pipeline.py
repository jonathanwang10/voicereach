"""The transcription pipeline as stage functions (H2-7.3): /api/transcribe and the
recordings worker run the same code."""
import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.recording_pipeline import (NoCategories, build_transcribe_response, check_upload, duplicate_stage,
                                         extract_stage, load_categories)
from tests.helpers import FakeSupabase

CATEGORIES = [
    {"id": "c1", "name": "name", "display_name": "Name", "type": "text", "is_required": True, "options": None},
    {"id": "c2", "name": "height", "display_name": "Height", "type": "number", "is_required": True, "options": None},
    {"id": "c3", "name": "weight", "display_name": "Weight", "type": "number", "is_required": True, "options": None},
    {"id": "c4", "name": "gender", "display_name": "Gender", "type": "single_select", "is_required": False,
     "options": [{"label": "Male", "value": 0}, {"label": "Female", "value": 0}]},
]


def test_load_categories_formats_rows_for_the_extractor():
    sb = FakeSupabase().on("categories", "select", data=CATEGORIES)
    cats = asyncio.run(load_categories(sb))
    assert [c["name"] for c in cats] == ["name", "height", "weight", "gender"]
    assert sb.calls[0].mod("order") == (("created_at",), {})
    assert set(cats[0]) == {"name", "display_name", "type", "is_required", "options", "is_sensitive"}
    assert cats[0]["is_sensitive"] is False


def test_load_categories_with_none_raises_no_categories():
    with pytest.raises(NoCategories, match="No categories found in database"):
        asyncio.run(load_categories(FakeSupabase().on("categories", "select", data=[])))


def test_extract_stage_returns_the_normalised_validation():
    openai = MagicMock(categorize_transcription=AsyncMock(return_value={"name": "Ann", "height": "5'10"}))
    v = asyncio.run(extract_stage("Met Ann", CATEGORIES, openai))
    assert v.normalized_data == {"name": "Ann", "height": 70} and v.missing_required == ["weight"]


def test_duplicate_stage_reports_a_failed_check_instead_of_no_match():
    with patch("services.recording_pipeline.DuplicateDetectionService") as dup:
        dup.return_value.find_duplicates = AsyncMock(side_effect=RuntimeError("db down"))
        assert asyncio.run(duplicate_stage({"name": "Ann"}, object(), object())) == ([], True)


def test_duplicate_stage_passes_categories_and_location():
    with patch("services.recording_pipeline.DuplicateDetectionService") as dup:
        dup.return_value.find_duplicates = AsyncMock(return_value=[{"id": "x"}])
        loc = {"latitude": 1, "longitude": 2}
        out = asyncio.run(duplicate_stage({"name": "Ann"}, object(), object(), categories=CATEGORIES, location=loc))
    assert out == ([{"id": "x"}], False)
    dup.return_value.find_duplicates.assert_awaited_once_with({"name": "Ann"}, categories=CATEGORIES, location=loc)


def test_check_upload_rejects_non_m4a_before_measuring():
    with patch("services.recording_pipeline.check_audio_duration") as dur:
        with pytest.raises(ValueError, match="File is not in M4A format"):
            check_upload(b"not audio")
        dur.assert_not_called()


def test_check_upload_returns_milliseconds_and_removes_its_temp_file():
    seen = {}

    def measure(path, limits):
        seen["path"] = path
        return 61.5
    with patch("services.recording_pipeline.check_audio_duration", side_effect=measure):
        assert check_upload(b"\x00\x00\x00\x18ftypM4A rest") == 61500
    assert not os.path.exists(seen["path"])


def test_build_transcribe_response_carries_the_validation():
    openai = MagicMock(categorize_transcription=AsyncMock(return_value={"name": "Ann", "height": "5'10"}))
    v = asyncio.run(extract_stage("Met Ann", CATEGORIES, openai))
    r = build_transcribe_response("Met Ann", v, [{"id": "x"}], False)
    assert r.model_dump() == {"transcription": "Met Ann", "categorized_data": {"name": "Ann", "height": 70},
                              "missing_required": ["weight"], "potential_matches": [{"id": "x"}],
                              "validation_errors": [], "duplicate_check_failed": False}
