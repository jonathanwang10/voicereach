"""/api/individuals routes end to end: real route, real IndividualService, urgency
calculator and normaliser; only Supabase is faked (strict FakeSupabase). Every test
asserts on what was written to the database, not on what a mock was told to return.
"""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from tests.helpers import FakeListDB, FakeSupabase, person

ID = "550e8400-e29b-41d4-a716-446655440001"
INTERACTION_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
T0 = "2026-01-01T00:00:00+00:00"
T1 = "2026-02-01T00:00:00+00:00"
LOCATION = {"latitude": 37.7749, "longitude": -122.4194, "address": "123 Market Street, San Francisco, CA"}

CATEGORIES = [
    {"name": "name", "type": "text", "is_required": True, "urgency_weight": 0},
    {"name": "height", "type": "number", "is_required": True, "urgency_weight": 0},
    {"name": "weight", "type": "number", "is_required": True, "urgency_weight": 0},
    {"name": "medical_conditions", "type": "multi_select", "is_required": False, "urgency_weight": 0,
     "options": ["Diabetes", "Mental Health"]},
    {"name": "veteran_status", "type": "single_select", "is_required": False, "urgency_weight": 20,
     "auto_trigger": False, "options": [{"label": "Yes", "value": 1}, {"label": "No", "value": 0}]},
    {"name": "housing_priority", "type": "single_select", "is_required": False, "urgency_weight": 30,
     "auto_trigger": False, "options": [{"label": "Critical", "value": 1}, {"label": "High", "value": 0.7}]},
    {"name": "behavior", "type": "single_select", "is_required": False, "urgency_weight": 40,
     "auto_trigger": True, "options": [{"label": "None", "value": 0}, {"label": "Physical", "value": 1}]},
]

EXISTING = {
    "id": ID, "name": "Ann Lee", "urgency_score": 0, "urgency_override": 80,
    "data": {"name": "Ann Lee", "height": 70, "weight": "150", "veteran_status": "No",
             "medical_conditions": ["Diabetes"]},
    "last_location": None, "created_at": T0, "updated_at": T0,
}


def _db(existing=EXISTING, interactions=()):
    """A database with CATEGORIES, `existing` (or nobody), and writes that echo their payload."""
    sb = FakeSupabase()
    sb.on("categories", "select", data=CATEGORIES)
    sb.on("individuals", "select", data=[existing] if existing else [])
    sb.on("interactions", "select", data=list(interactions))
    sb.on("individuals", "insert", data=lambda call: [
        {"id": ID, "urgency_override": None, "last_location": None, "created_at": T1, "updated_at": T1,
         **call.payload}])
    sb.on("individuals", "update", data=lambda call: [{**(existing or {}), **call.payload}])
    sb.on("interactions", "insert", data=lambda call: [
        {"id": INTERACTION_ID, "created_at": T1, **call.payload}])
    return sb


def _call(sb, method, path, **kwargs):
    with patch("api.individuals.get_supabase", return_value=sb):
        return TestClient(app).request(method, path, **kwargs)


def _writes(sb):
    return [(c.table, c.verb) for c in sb.calls if c.verb != "select"]


# --- POST /api/individuals: new person --------------------------------------------------

def test_new_person_insert_carries_normalised_data_computed_urgency_and_location():
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals", json={
        "data": {"name": " Ann Lee ", "height": "5'10", "weight": "150", "veteran_status": "yes",
                 "housing_priority": "High"},
        "location": LOCATION, "transcription": "Met Ann by the library", "audio_url": "audio/u/1.m4a",
    })
    assert r.status_code == 200, r.text
    data = {"name": "Ann Lee", "height": 70, "weight": 150, "veteran_status": "Yes", "housing_priority": "High"}
    # (1 * 20 + 0.7 * 30) / (20 + 30 + 40) * 100 = 45.5 -> 45 (OD-1: all weighted categories)
    assert sb.payloads("individuals", "insert") == [
        {"name": "Ann Lee", "urgency_score": 45, "data": data, "last_location": LOCATION}]
    assert sb.payloads("interactions", "insert") == [{
        "individual_id": ID, "user_id": "test-user-123", "user_name": "Demo User",
        "transcription": "Met Ann by the library", "audio_url": "audio/u/1.m4a",
        "location": LOCATION, "changes": data,  # a first visit records every field
    }]
    assert _writes(sb) == [("individuals", "insert"), ("interactions", "insert")]
    body = r.json()
    assert body["individual"]["urgency_score"] == 45 and body["individual"]["display_score"] == 45
    assert body["interaction"]["has_transcription"] is True


def test_auto_trigger_option_inserts_urgency_100():
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals",
              json={"data": {"name": "Bo", "height": 70, "weight": 150, "behavior": "Physical"}})
    assert r.status_code == 200, r.text
    assert sb.payloads("individuals", "insert")[0]["urgency_score"] == 100


def test_zero_value_auto_trigger_option_does_not_trigger():
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals",
              json={"data": {"name": "Bo", "height": 70, "weight": 150, "behavior": "None"}})
    assert r.status_code == 200, r.text
    assert sb.payloads("individuals", "insert")[0]["urgency_score"] == 0


def test_without_location_no_last_location_is_written():
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals", json={"data": {"name": "Bo", "height": 70, "weight": 150}})
    assert r.status_code == 200, r.text
    assert "last_location" not in sb.payloads("individuals", "insert")[0]
    assert sb.payloads("interactions", "insert")[0]["location"] is None
    assert r.json()["interaction"]["has_transcription"] is False


def test_save_invalidates_the_assistant_cache():
    sb = _db(existing=None)
    with patch("api.individuals.invalidate_context_cache") as invalidate:
        r = _call(sb, "POST", "/api/individuals", json={"data": {"name": "Bo", "height": 70, "weight": 150}})
    assert r.status_code == 200, r.text
    invalidate.assert_called_once_with()


def test_missing_required_field_is_422_and_writes_nothing():
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals", json={"data": {"name": "Bo", "height": 70}})
    assert r.status_code == 422
    assert "Missing required fields: ['weight']" in str(r.json()["detail"])
    assert sb.calls == []


def test_missing_custom_required_field_is_400_with_a_readable_list():
    """Minor 7: the route's own required check names fields with ", ", not a Python list repr."""
    sb = FakeSupabase()
    sb.on("categories", "select", data=CATEGORIES + [
        {"name": "case_number", "type": "text", "is_required": True, "urgency_weight": 0},
        {"name": "shelter", "type": "text", "is_required": True, "urgency_weight": 0}])
    r = _call(sb, "POST", "/api/individuals", json={"data": {"name": "Bo", "height": 70, "weight": 150}})
    assert r.status_code == 400
    assert r.json()["detail"] == "Missing required fields: case_number, shelter"
    assert _writes(sb) == []


def test_invalid_select_option_is_400_and_writes_nothing():
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals",
              json={"data": {"name": "Bo", "height": 70, "weight": 150, "veteran_status": "Maybe"}})
    assert r.status_code == 400
    assert r.json()["detail"].startswith("veteran_status: ")
    assert _writes(sb) == []


def test_out_of_range_height_is_400_and_writes_nothing():
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals", json={"data": {"name": "Bo", "height": 400, "weight": 150}})
    assert r.status_code == 400
    assert "height" in r.json()["detail"]
    assert _writes(sb) == []


# --- POST /api/individuals: merge ---------------------------------------------------------

def _merge(sb, data, **extra):
    return _call(sb, "POST", "/api/individuals", json={"data": data, "merge_with_id": ID, **extra})


def test_merge_updates_the_target_and_records_only_what_changed():
    sb = _db()
    r = _merge(sb, {"name": "Ann Lee", "height": 71, "weight": 150, "veteran_status": "Yes"})
    assert r.status_code == 200, r.text

    [update] = sb.calls_to("individuals", "update")
    assert update.mod("eq") == (("id", ID), {})
    assert set(update.payload) == {"name", "urgency_score", "data", "updated_at"}
    assert update.payload["data"] == {"name": "Ann Lee", "height": 71, "weight": 150, "veteran_status": "Yes"}
    assert update.payload["urgency_score"] == 22  # 1 * 20 / 90 * 100
    # weight "150" (an old un-normalised row) vs 150 is not a change
    assert [p["changes"] for p in sb.payloads("interactions", "insert")] == [{"height": 71, "veteran_status": "Yes"}]
    assert sb.payloads("interactions", "insert")[0]["individual_id"] == ID
    assert _writes(sb) == [("individuals", "update"), ("interactions", "insert")]


def test_merge_never_writes_urgency_override_so_a_manual_override_survives():
    sb = _db()
    r = _merge(sb, {"name": "Ann Lee", "height": 71, "weight": 150})
    assert r.status_code == 200, r.text
    assert "urgency_override" not in sb.payloads("individuals", "update")[0]
    assert r.json()["individual"]["urgency_override"] == 80
    assert r.json()["individual"]["display_score"] == 80


def test_merge_replaces_data_wholesale_so_omitted_fields_are_dropped():
    """Documents current behaviour (README): the client sends the complete merged record."""
    sb = _db()
    r = _merge(sb, {"name": "Ann Lee", "height": 70, "weight": 150})
    assert r.status_code == 200, r.text
    assert "medical_conditions" not in sb.payloads("individuals", "update")[0]["data"]


def test_merge_with_location_sets_last_location_and_logs_it():
    sb = _db()
    r = _merge(sb, {"name": "Ann Lee", "height": 70, "weight": 150}, location=LOCATION)
    assert r.status_code == 200, r.text
    assert sb.payloads("individuals", "update")[0]["last_location"] == LOCATION
    assert sb.payloads("interactions", "insert")[0]["location"] == LOCATION


def test_merge_into_someone_who_does_not_exist_is_404_and_writes_nothing():
    sb = _db(existing=None)
    r = _merge(sb, {"name": "Ann Lee", "height": 70, "weight": 150})
    assert r.status_code == 404
    assert r.json() == {"detail": f"Individual not found: {ID}"}
    assert _writes(sb) == []


# --- GET /api/individuals ---------------------------------------------------------------

def test_list_defaults_to_twenty_newest_first():
    sb = FakeListDB([person(i) for i in range(1, 4)], [])
    r = _call(sb, "GET", "/api/individuals")
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["total"], body["limit"], body["offset"]) == (3, 20, 0)
    assert [p["name"] for p in body["individuals"]] == ["Person 3", "Person 2", "Person 1"]


@pytest.mark.parametrize("query", ["sort_by=created_at", "sort_order=up", "limit=0", "limit=101", "offset=-1"])
def test_list_rejects_bad_paging_and_sorting_with_422(query):
    sb = FakeListDB([], [])
    assert _call(sb, "GET", f"/api/individuals?{query}").status_code == 422
    assert sb.queries == []


# --- GET /api/individuals/{id} ------------------------------------------------------------

def test_profile_reads_the_person_and_their_ten_latest_interactions():
    row = dict(EXISTING, urgency_score=60, urgency_override=0)
    sb = _db(existing=row, interactions=[
        {"id": INTERACTION_ID, "created_at": T1, "user_name": "Demo User", "location": None,
         "transcription": "Met Ann"},
        {"id": "6ba7b811-9dad-11d1-80b4-00c04fd430c8", "created_at": T0, "user_name": None,
         "location": LOCATION, "transcription": None},
    ])
    r = _call(sb, "GET", f"/api/individuals/{ID}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["individual"]["display_score"] == 0  # an override of 0 wins over 60
    assert [i["has_transcription"] for i in body["recent_interactions"]] == [True, False]
    assert body["recent_interactions"][1]["user_name"] is None  # C-55: a NULL user_name is not a 500

    [person_q] = sb.calls_to("individuals", "select")
    assert person_q.mod("eq") == (("id", ID), {}) and person_q.mod("maybe_single")
    [history_q] = sb.calls_to("interactions", "select")
    assert history_q.mod("eq") == (("individual_id", ID), {})
    assert history_q.mod("order") == (("created_at",), {"desc": True})
    assert history_q.mod("limit") == ((10,), {})


def test_profile_of_someone_who_does_not_exist_is_404():
    r = _call(_db(existing=None), "GET", f"/api/individuals/{ID}")
    assert r.status_code == 404
    assert r.json() == {"detail": f"Individual not found: {ID}"}


@pytest.mark.parametrize("path", ["/api/individuals/not-a-uuid", "/api/individuals/not-a-uuid/interactions"])
def test_malformed_id_is_422_without_touching_the_database(path):
    sb = _db()
    assert _call(sb, "GET", path).status_code == 422
    assert sb.calls == []


# --- GET /api/individuals/{id}/interactions ----------------------------------------------

def test_history_is_newest_first_and_paged_by_range():
    sb = _db(interactions=[{
        "id": INTERACTION_ID, "created_at": T1, "user_name": None, "transcription": "Met Ann",
        "location": LOCATION, "changes": {"height": 71},
    }])
    r = _call(sb, "GET", f"/api/individuals/{ID}/interactions?limit=10&offset=20")
    assert r.status_code == 200, r.text
    [q] = sb.calls_to("interactions", "select")
    assert q.mod("eq") == (("individual_id", ID), {})
    assert q.mod("order") == (("created_at",), {"desc": True})
    assert q.mod("range") == ((20, 29), {})
    [item] = r.json()["interactions"]
    assert item["location"]["address"] == LOCATION["address"]  # full address, not abbreviated
    assert item["changes"] == {"height": 71}
    assert item["transcription"] == "Met Ann"
    assert item["user_name"] is None  # C-55: one NULL user_name does not 500 the route


def test_history_row_without_changes_shows_an_empty_dict():
    sb = _db(interactions=[{"id": INTERACTION_ID, "created_at": T1, "user_name": "Demo User"}])
    r = _call(sb, "GET", f"/api/individuals/{ID}/interactions")
    assert r.status_code == 200, r.text
    assert r.json()["interactions"][0]["changes"] == {}


# --- PUT /api/individuals/{id}/urgency-override -----------------------------------------

def _override(sb, value):
    with patch("api.individuals.invalidate_context_cache") as invalidate:
        r = _call(sb, "PUT", f"/api/individuals/{ID}/urgency-override", json={"urgency_override": value})
    return r, invalidate


@pytest.mark.parametrize("value,display", [(85, 85), (0, 0), (100, 100), (None, 45)])
def test_override_writes_only_the_override_and_returns_the_stored_scores(value, display):
    sb = FakeSupabase().on("individuals", "update", data=lambda call: [
        {"id": ID, "urgency_score": 45, **call.payload}])
    r, invalidate = _override(sb, value)
    assert r.status_code == 200, r.text
    [update] = sb.calls_to("individuals", "update")
    assert update.payload == {"urgency_override": value}
    assert update.mod("eq") == (("id", ID), {})
    assert r.json() == {"urgency_score": 45, "urgency_override": value, "display_score": display}
    invalidate.assert_called_once_with()


def test_override_for_someone_who_does_not_exist_is_404():
    sb = FakeSupabase().on("individuals", "update", data=[])
    r, invalidate = _override(sb, 50)
    assert r.status_code == 404
    assert r.json() == {"detail": f"Individual not found: {ID}"}
    invalidate.assert_not_called()


@pytest.mark.parametrize("value", [-1, 101])
def test_override_out_of_range_is_422_without_touching_the_database(value):
    sb = FakeSupabase()
    r, _ = _override(sb, value)
    assert r.status_code == 422
    assert sb.calls == []
