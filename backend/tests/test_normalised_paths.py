"""The shared normaliser is applied on every path that writes or returns field data.

Covers the backend halves of C-09/C-14/C-15 and C-67: /api/transcribe output,
POST /api/individuals, IndividualService.save_individual (diff + urgency),
GPT key matching and embedding text.
"""
import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from main import app
from db.models import SaveIndividualRequest
from services.individual_service import IndividualService
from services.openai_service import OpenAIService

CATEGORIES = [
    {"name": "name", "type": "text", "is_required": True, "urgency_weight": 0},
    {"name": "height", "type": "number", "is_required": True, "urgency_weight": 0},
    {"name": "weight", "type": "number", "is_required": True, "urgency_weight": 0},
    {"name": "age", "type": "number", "is_required": False, "urgency_weight": 0},
    {"name": "gender", "type": "single_select", "is_required": False, "urgency_weight": 0,
     "options": [{"label": "Male", "value": 0}, {"label": "Female", "value": 0}]},
    {"name": "medical_conditions", "type": "multi_select", "is_required": False, "urgency_weight": 0,
     "options": ["Diabetes", "Cancer", "None"]},
    {"name": "housing_priority", "type": "single_select", "is_required": False, "urgency_weight": 30,
     "auto_trigger": False,
     "options": [{"label": "Critical", "value": 1}, {"label": "Low", "value": 0.1}]},
    {"name": "Housing_status", "type": "text", "is_required": False, "urgency_weight": 0},
]
NOW = datetime.now(timezone.utc).isoformat()


# --- /api/transcribe ---
def _transcribe(raw_categorized):
    openai_mock = MagicMock()
    openai_mock.transcribe_audio_file = AsyncMock(return_value="transcript")
    openai_mock.categorize_transcription = AsyncMock(return_value=raw_categorized)
    supabase = MagicMock()
    supabase.table.return_value.select.return_value.order.return_value.execute.return_value.data = [
        {**c, "options": c.get("options")} for c in CATEGORIES]
    dup = MagicMock()
    dup.return_value.find_duplicates = AsyncMock(return_value=[])
    with patch("api.transcription.get_openai_service", return_value=openai_mock), \
         patch("api.transcription.get_supabase", return_value=supabase), \
         patch("services.duplicate_detection_service.DuplicateDetectionService", dup):
        response = TestClient(app).post("/api/transcribe", json={"audio_data": "AAAA"})
    return response, dup.return_value.find_duplicates


def test_transcribe_returns_normalised_categorized_data():
    response, find_duplicates = _transcribe({
        "name": " Ann ", "height": "5'10", "weight": "150", "age": None, "gender": "female",
        "medical_conditions": "Diabetes, Cancer", "housing_priority": "",
    })
    assert response.status_code == 200, response.text
    body = response.json()
    expected = {"name": "Ann", "height": 70, "weight": 150, "gender": "Female",
                "medical_conditions": ["Diabetes", "Cancer"]}
    assert body["categorized_data"] == expected
    assert body["validation_errors"] == []
    assert body["missing_required"] == []
    find_duplicates.assert_awaited_once_with(expected)


def test_transcribe_reports_validation_errors():
    response, _ = _transcribe({"name": "Ann", "height": 70, "weight": 150, "age": -3})
    assert response.status_code == 200, response.text
    assert [e["field"] for e in response.json()["validation_errors"]] == ["age"]


# --- POST /api/individuals passes normalised data to the service ---
def test_save_route_passes_normalised_data():
    from db.models import SaveIndividualResponse
    iid = str(uuid4())
    result = SaveIndividualResponse(
        individual={"id": iid, "name": "Ann", "urgency_score": 0, "urgency_override": None, "display_score": 0,
                    "last_location": None, "data": {"name": "Ann"}, "created_at": NOW, "updated_at": NOW},
        interaction={"id": str(uuid4()), "user_name": "Demo User", "created_at": NOW,
                     "has_transcription": False, "location": None},
    )
    supabase = MagicMock()
    supabase.table.return_value.select.return_value.order.return_value.execute.return_value.data = CATEGORIES
    with patch("api.individuals.get_supabase", return_value=supabase), \
         patch("api.individuals.IndividualService") as svc:
        svc.return_value.save_individual = AsyncMock(return_value=result)
        response = TestClient(app).post("/api/individuals", json={"data": {
            "name": " Ann ", "height": "70", "weight": "150", "gender": "male", "age": ""}})
    assert response.status_code == 200, response.text
    sent = svc.return_value.save_individual.await_args.kwargs["data"]
    assert sent == {"name": "Ann", "height": 70, "weight": 150, "gender": "Male"}


def test_save_route_rejects_invalid_values_with_field_messages():
    supabase = MagicMock()
    supabase.table.return_value.select.return_value.execute.return_value.data = CATEGORIES
    with patch("api.individuals.get_supabase", return_value=supabase):
        response = TestClient(app).post("/api/individuals", json={"data": {
            "name": "Ann", "height": 70, "weight": 150, "gender": "maybe"}})
    assert response.status_code == 400
    assert response.json()["detail"].startswith("gender:")


def test_model_rejects_whitespace_name():
    with pytest.raises(Exception):
        SaveIndividualRequest(data={"name": "   ", "height": 70, "weight": 150})


# --- IndividualService.save_individual normalises before urgency and diff ---
def _service(existing_data=None):
    from tests.helpers import FakeSupabase, save_rpc
    row = {"id": str(uuid4()), "name": "Ann", "urgency_score": 0, "urgency_override": None, "data": {},
           "created_at": NOW, "updated_at": NOW, "last_location": None}
    existing = {**row, "data": existing_data or {}}
    sb = FakeSupabase().on("categories", "select", data=CATEGORIES).on("individuals", "select", data=[existing])
    return sb.on_rpc("save_individual", data=save_rpc(existing))


async def test_service_new_person_saves_normalised_data_and_score():
    sb = _service()
    await IndividualService(sb).save_individual(
        user_id="u", user_name="Demo User",
        data={"name": " Ann ", "height": "70", "weight": "150", "housing_priority": "critical",
              "age": None, "gender": ""})
    [params] = sb.rpc_params("save_individual")
    clean = {"name": "Ann", "height": 70, "weight": 150, "housing_priority": "Critical"}
    assert params["p_data"] == clean
    assert params["p_name"] == "Ann"
    assert params["p_urgency_score"] == 100
    assert params["p_interaction"]["changes"] == clean


async def test_service_merge_records_no_phantom_changes():
    sb = _service(existing_data={"name": "Ann", "height": 70, "weight": "150", "age": None})
    await IndividualService(sb).save_individual(
        user_id="u", user_name="Demo User", merge_with_id=uuid4(),
        data={"name": "Ann", "height": 70, "weight": 150, "age": "", "gender": "female"})
    [params] = sb.rpc_params("save_individual")
    assert params["p_data"] == {"name": "Ann", "height": 70, "weight": 150, "gender": "Female"}
    assert params["p_interaction"]["changes"] == {"gender": "Female"}


async def test_service_rejects_invalid_values():
    sb = _service()
    with pytest.raises(ValueError):
        await IndividualService(sb).save_individual(
            user_id="u", user_name="Demo User", data={"name": "Ann", "height": 70, "weight": 999})


def test_get_changed_fields_ignores_empty_new_values():
    svc = IndividualService(MagicMock())
    assert svc.get_changed_fields({"age": 40}, {"age": 40, "gender": None, "notes": ""}) == {}


# --- C-67 superseded by the strict schema (H2-3.1): only category keys are read ---
async def test_categorize_takes_only_the_schema_keys():
    """The strict schema fixes the keys (H2-3.1), so the old case-insensitive key repair
    (C-67) is gone: a key that isn't a category key is ignored, never guessed at."""
    svc = OpenAIService.__new__(OpenAIService)
    reply = {"Name": {"value": "Ann", "evidence": "Ann"}, "name": {"value": "Ann", "evidence": "Ann"},
             "height": {"value": 66, "evidence": "5 ft 6"}}
    completion = MagicMock()
    completion.choices = [MagicMock(message=MagicMock(content=json.dumps(reply), refusal=None))]
    svc.client = MagicMock()
    svc.client.chat.completions.create = AsyncMock(return_value=completion)
    result = await svc.categorize_transcription("This is Ann, 5 ft 6", CATEGORIES)
    assert result == {"name": "Ann", "height": 66}


# --- embedding text joins list items with map(str) and never splits strings ---
async def test_embedding_text_joins_lists_and_strings_safely():
    from services.embedding_service import EmbeddingService
    svc = EmbeddingService.__new__(EmbeddingService)
    svc.dimensions = 1
    svc.generate_embedding = AsyncMock(return_value=[0.0])
    cats = [{"name": "medical_conditions", "display_name": "Medical Conditions"},
            {"name": "substance_abuse_history", "display_name": "Substance Abuse History"}]
    _, text = await svc.generate_individual_embedding({"name": "Ann", "data": {
        "medical_conditions": "Diabetes", "substance_abuse_history": ["Mild", 3]}}, cats)
    assert svc.generate_embedding.await_args.args[0] == text
    assert "Medical Conditions: Diabetes" in text
    assert "Substance Abuse History: Mild, 3" in text


@pytest.mark.parametrize("gpt_height,evidence,expected", [
    (6, "six feet", 72), (5.5, "five and a half feet", 66), (70, "70 inches", 70), (9, "9 feet", 108)])
async def test_categorize_still_treats_small_gpt_numbers_as_feet(gpt_height, evidence, expected):
    svc = OpenAIService.__new__(OpenAIService)
    reply = {"height": {"value": gpt_height, "evidence": evidence}}
    completion = MagicMock()
    completion.choices = [MagicMock(message=MagicMock(content=json.dumps(reply), refusal=None))]
    svc.client = MagicMock()
    svc.client.chat.completions.create = AsyncMock(return_value=completion)
    result = await svc.categorize_transcription(f"He is {evidence} tall", CATEGORIES)
    assert result["height"] == expected
