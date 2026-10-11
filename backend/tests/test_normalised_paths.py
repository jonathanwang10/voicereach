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
    with patch("api.transcription.OpenAIService", return_value=openai_mock), \
         patch("api.transcription.create_client", return_value=supabase), \
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
    supabase.table.return_value.select.return_value.execute.return_value.data = CATEGORIES
    with patch("api.individuals.get_supabase_client", return_value=supabase), \
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
    with patch("api.individuals.get_supabase_client", return_value=supabase):
        response = TestClient(app).post("/api/individuals", json={"data": {
            "name": "Ann", "height": 70, "weight": 150, "gender": "maybe"}})
    assert response.status_code == 400
    assert response.json()["detail"].startswith("gender:")


def test_model_rejects_whitespace_name():
    with pytest.raises(Exception):
        SaveIndividualRequest(data={"name": "   ", "height": 70, "weight": 150})


# --- IndividualService.save_individual normalises before urgency and diff ---
def _service(existing_data=None):
    sb = MagicMock()
    sb.table.return_value.select.return_value.execute.return_value.data = CATEGORIES
    row = {"id": str(uuid4()), "name": "Ann", "urgency_score": 0, "urgency_override": None, "data": {},
           "created_at": NOW, "updated_at": NOW, "last_location": None}
    # One row serves as both the inserted individual and the inserted interaction.
    sb.table.return_value.insert.return_value.execute.return_value.data = [{**row, "user_name": "Demo User"}]
    sb.table.return_value.update.return_value.eq.return_value.execute.return_value.data = [row]
    existing = {**row, "data": existing_data or {}}
    sb.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data = existing
    sb.table.return_value.select.return_value.eq.return_value.maybe_single.return_value.execute.return_value.data = existing
    return sb


@pytest.mark.asyncio
async def test_service_new_person_saves_normalised_data_and_score():
    sb = _service()
    await IndividualService(sb).save_individual(
        user_id="u", user_name="Demo User",
        data={"name": " Ann ", "height": "70", "weight": "150", "housing_priority": "critical",
              "age": None, "gender": ""})
    individual_insert = sb.table.return_value.insert.call_args_list[0].args[0]
    interaction_insert = sb.table.return_value.insert.call_args_list[1].args[0]
    clean = {"name": "Ann", "height": 70, "weight": 150, "housing_priority": "Critical"}
    assert individual_insert["data"] == clean
    assert individual_insert["name"] == "Ann"
    assert individual_insert["urgency_score"] == 100
    assert interaction_insert["changes"] == clean


@pytest.mark.asyncio
async def test_service_merge_records_no_phantom_changes():
    sb = _service(existing_data={"name": "Ann", "height": 70, "weight": "150", "age": None})
    await IndividualService(sb).save_individual(
        user_id="u", user_name="Demo User", merge_with_id=uuid4(),
        data={"name": "Ann", "height": 70, "weight": 150, "age": "", "gender": "female"})
    update = sb.table.return_value.update.call_args.args[0]
    interaction_insert = sb.table.return_value.insert.call_args.args[0]
    assert update["data"] == {"name": "Ann", "height": 70, "weight": 150, "gender": "Female"}
    assert interaction_insert["changes"] == {"gender": "Female"}


@pytest.mark.asyncio
async def test_service_rejects_invalid_values():
    sb = _service()
    with pytest.raises(ValueError):
        await IndividualService(sb).save_individual(
            user_id="u", user_name="Demo User", data={"name": "Ann", "height": 70, "weight": 999})


def test_get_changed_fields_ignores_empty_new_values():
    svc = IndividualService(MagicMock())
    assert svc.get_changed_fields({"age": 40}, {"age": 40, "gender": None, "notes": ""}) == {}


# --- C-67: GPT keys matched regardless of case/spacing ---
@pytest.mark.asyncio
async def test_categorize_matches_gpt_keys_case_insensitively():
    svc = OpenAIService.__new__(OpenAIService)
    reply = {"Name": "Ann", "Height": "5 ft 6", "weight": 140, "Housing Status": "Shelter",
             "Medical_Conditions": "diabetes, cancer"}
    completion = MagicMock()
    completion.choices = [MagicMock(message=MagicMock(content=json.dumps(reply)))]
    svc.client = MagicMock()
    svc.client.chat.completions.create = AsyncMock(return_value=completion)
    result = await svc.categorize_transcription("text", CATEGORIES)
    assert result["name"] == "Ann"
    assert result["height"] == 66
    assert result["Housing_status"] == "Shelter"
    assert result["medical_conditions"] == ["Diabetes", "Cancer"]


# --- embedding text joins list items with map(str) and never splits strings ---
@pytest.mark.asyncio
async def test_embedding_text_joins_lists_and_strings_safely():
    from services.embedding_service import EmbeddingService
    svc = EmbeddingService.__new__(EmbeddingService)
    svc.generate_embedding = AsyncMock(return_value=[0.0])
    await svc.generate_individual_embedding({"name": "Ann", "data": {
        "medical_conditions": "Diabetes", "substance_abuse_history": ["Mild", 3]}})
    text = svc.generate_embedding.await_args.args[0]
    assert "Medical conditions: Diabetes" in text
    assert "Substance abuse: Mild, 3" in text
