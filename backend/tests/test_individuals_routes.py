"""/api/individuals routes end to end: real route, real IndividualService, urgency
calculator and normaliser; only Supabase is faked (strict FakeSupabase). Every test
asserts on what was written to the database, not on what a mock was told to return.
"""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from tests.helpers import FakeListDB, FakeSupabase, person, pg_error, save_rpc

ID = "550e8400-e29b-41d4-a716-446655440001"
INTERACTION_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
T0 = "2026-01-01T00:00:00+00:00"
T1 = "2026-02-01T00:00:00+00:00"
KEY = "3f2b8c1e-0d4a-4c1e-9a7b-2b1f0c9d8e7a"
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
    """A database with CATEGORIES, `existing` (or nobody), and a save_individual function
    that plays the SQL from its params (save_rpc)."""
    sb = FakeSupabase()
    sb.on("categories", "select", data=CATEGORIES)
    sb.on("individuals", "select", data=[existing] if existing else [])
    sb.on("interactions", "select", data=list(interactions))
    sb.on_rpc("save_individual", data=save_rpc(existing, new_id=ID, interaction_id=INTERACTION_ID, at=T1))
    return sb


def _call(sb, method, path, **kwargs):
    with patch("api.individuals.get_supabase", return_value=sb):
        return TestClient(app).request(method, path, **kwargs)


def _writes(sb):
    """Every data write, a save_individual call included (as ("save_individual", "rpc")).
    Audit rows are left out: the audit section below checks them."""
    return [(c.table, c.verb) for c in sb.calls if c.verb != "select" and c.table != "audit_log"]


def _save_params(sb):
    [params] = sb.rpc_params("save_individual")
    return params


# --- POST /api/individuals: new person --------------------------------------------------

def test_new_person_is_one_rpc_with_normalised_data_urgency_and_location():
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals", json={
        "data": {"name": " Ann Lee ", "height": "5'10", "weight": "150", "veteran_status": "yes",
                 "housing_priority": "High"},
        "location": LOCATION, "transcription": "Met Ann by the library", "audio_url": "audio/u/1.m4a",
    })
    assert r.status_code == 200, r.text
    data = {"name": "Ann Lee", "height": 70, "weight": 150, "veteran_status": "Yes", "housing_priority": "High"}
    # (1 * 20 + 0.7 * 30) / (20 + 30 + 40) * 100 = 45.5 -> 45 (OD-1: all weighted categories)
    assert sb.rpc_params("save_individual") == [{
        "p_individual_id": None, "p_name": "Ann Lee", "p_data": data, "p_urgency_score": 45,
        "p_interaction": {"user_id": "test-user-123", "user_name": "Demo User",
                          "transcription": "Met Ann by the library", "audio_url": "audio/u/1.m4a",
                          "location": LOCATION, "changes": data},  # a first visit records every field
        "p_expected_version": None, "p_client_request_id": None}]
    assert _writes(sb) == [("save_individual", "rpc")]          # no table writes, no compensating delete
    body = r.json()
    assert body["individual"]["urgency_score"] == 45 and body["individual"]["display_score"] == 45
    assert body["individual"]["version"] == 1
    assert body["interaction"]["has_transcription"] is True
    assert body["replayed"] is False


def test_auto_trigger_option_saves_urgency_100():
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals",
              json={"data": {"name": "Bo", "height": 70, "weight": 150, "behavior": "Physical"}})
    assert r.status_code == 200, r.text
    assert _save_params(sb)["p_urgency_score"] == 100


def test_zero_value_auto_trigger_option_does_not_trigger():
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals",
              json={"data": {"name": "Bo", "height": 70, "weight": 150, "behavior": "None"}})
    assert r.status_code == 200, r.text
    assert _save_params(sb)["p_urgency_score"] == 0


def test_without_location_the_visit_has_none():
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals", json={"data": {"name": "Bo", "height": 70, "weight": 150}})
    assert r.status_code == 200, r.text
    params = _save_params(sb)
    assert params["p_individual_id"] is None and params["p_interaction"]["location"] is None
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
    assert "Missing required fields: weight" in str(r.json()["detail"])
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
    params = _save_params(sb)
    assert params["p_individual_id"] == ID
    assert params["p_data"] == {"name": "Ann Lee", "height": 71, "weight": 150, "veteran_status": "Yes"}
    assert params["p_urgency_score"] == 22  # 1 * 20 / 90 * 100
    # weight "150" (an old un-normalised row) vs 150 is not a change; the dropped
    # medical_conditions is recorded as removed (H2-2.5)
    assert params["p_interaction"]["changes"] == {
        "height": 71, "veteran_status": "Yes", "medical_conditions": None, "_removed": ["medical_conditions"]}
    assert _writes(sb) == [("save_individual", "rpc")]


def test_merge_sends_the_clients_expected_version_and_only_the_changes():
    sb = _db(existing={**EXISTING, "version": 3})
    r = _merge(sb, {"name": "Ann Lee", "height": 71, "weight": 150, "veteran_status": "Yes",
                    "medical_conditions": ["Diabetes"]}, expected_version=3)
    [params] = sb.rpc_params("save_individual")
    assert (params["p_individual_id"], params["p_expected_version"]) == (ID, 3)
    assert params["p_interaction"]["changes"] == {"height": 71, "veteran_status": "Yes"}
    assert r.json()["individual"]["version"] == 4


def test_merge_without_expected_version_guards_with_the_version_it_read():
    sb = _db(existing={**EXISTING, "version": 4})
    _merge(sb, {"name": "Ann Lee", "height": 70, "weight": 150, "medical_conditions": ["Diabetes"]})
    assert sb.rpc_params("save_individual")[0]["p_expected_version"] == 4


def test_merge_never_writes_urgency_override_so_a_manual_override_survives():
    sb = _db()
    r = _merge(sb, {"name": "Ann Lee", "height": 71, "weight": 150})
    assert r.status_code == 200, r.text
    assert "urgency_override" not in str(_save_params(sb))
    assert r.json()["individual"]["urgency_override"] == 80
    assert r.json()["individual"]["display_score"] == 80


def test_merge_replaces_data_wholesale_so_omitted_fields_are_dropped():
    """Documents current behaviour (README): the client sends the complete merged record."""
    sb = _db()
    r = _merge(sb, {"name": "Ann Lee", "height": 70, "weight": 150})
    assert r.status_code == 200, r.text
    assert "medical_conditions" not in _save_params(sb)["p_data"]
    # ...and the visit records the removal (H2-2.5)
    # EXISTING also had veteran_status "No", which this merge omits too
    assert _save_params(sb)["p_interaction"]["changes"] == {
        "medical_conditions": None, "veteran_status": None, "_removed": ["medical_conditions", "veteran_status"]}


def test_merge_with_location_sets_last_location_and_logs_it():
    sb = _db()
    r = _merge(sb, {"name": "Ann Lee", "height": 70, "weight": 150}, location=LOCATION)
    assert r.status_code == 200, r.text
    assert _save_params(sb)["p_interaction"]["location"] == LOCATION
    assert r.json()["individual"]["last_location"] == LOCATION


def test_merge_into_someone_who_does_not_exist_is_404_and_writes_nothing():
    sb = _db(existing=None)
    r = _merge(sb, {"name": "Ann Lee", "height": 70, "weight": 150})
    assert r.status_code == 404
    assert r.json() == {"detail": f"Individual not found: {ID}"}
    assert _writes(sb) == []


def _db_rpc_error(error, existing=EXISTING):
    sb = _db(existing=existing)
    sb.rules = [x for x in sb.rules if x.verb != "rpc"]
    sb.on_rpc("save_individual", error=error)
    return sb


def test_version_conflict_is_409_with_the_exact_message():
    sb = _db_rpc_error(pg_error("P0409"))
    with patch("api.individuals.invalidate_context_cache") as invalidate:
        r = _merge(sb, {"name": "Ann Lee", "height": 70, "weight": 150}, expected_version=1)
    assert r.status_code == 409
    assert r.json() == {"detail": "This person was changed by someone else. Reload and try again."}
    invalidate.assert_not_called()


def test_target_deleted_before_the_rpc_is_404():       # P0002 from the function
    sb = _db_rpc_error(pg_error("P0002"))
    r = _merge(sb, {"name": "Ann Lee", "height": 70, "weight": 150})
    assert (r.status_code, r.json()) == (404, {"detail": f"Individual not found: {ID}"})


def test_other_database_error_from_the_rpc_is_a_500_without_its_text():
    sb = _db_rpc_error(pg_error("XX000", "Ann Lee leaked"))
    r = TestClient(app, raise_server_exceptions=False)
    with patch("api.individuals.get_supabase", return_value=sb):
        r = r.post("/api/individuals", json={"data": {"name": "Ann Lee", "height": 70, "weight": 150},
                                             "merge_with_id": ID})
    assert (r.status_code, r.json()) == (500, {"detail": "Save individual failed"})
    assert "Ann Lee" not in r.text


def test_idempotency_key_becomes_client_request_id():
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals", json={"data": {"name": "Bo", "height": 70, "weight": 150}},
              headers={"Idempotency-Key": KEY})
    assert r.status_code == 200, r.text
    assert _save_params(sb)["p_client_request_id"] == KEY


@pytest.mark.parametrize("key", ["abc", "", "550e8400-e29b-41d4-a716"])
def test_a_key_that_is_not_a_uuid_is_400_before_any_query(key):
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals", json={"data": {"name": "Bo", "height": 70, "weight": 150}},
              headers={"Idempotency-Key": key})
    assert (r.status_code, r.json()) == (400, {"detail": "Idempotency-Key must be a UUID"})
    assert sb.calls == []


def _replay(first_id=ID):
    def play(call):
        out = save_rpc(None, new_id=first_id, interaction_id=INTERACTION_ID, at=T0)(call)
        return {**out, "replayed": True}
    return play


def test_a_replayed_save_returns_the_first_result_and_schedules_no_embedding():
    first = "6ba7b812-9dad-11d1-80b4-00c04fd430c8"
    sb = _db(existing=None)
    sb.rules = [x for x in sb.rules if x.verb != "rpc"]
    sb.on_rpc("save_individual", data=_replay(first))
    with patch("api.individuals.generate_embedding_background") as embed:
        r = _call(sb, "POST", "/api/individuals", json={"data": {"name": "Bo", "height": 70, "weight": 150}},
                  headers={"Idempotency-Key": KEY})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["individual"]["id"] == first and body["replayed"] is True
    embed.assert_not_called()


def test_retry_with_a_stale_expected_version_replays_instead_of_409():   # Review Focus 2
    sb = _db(existing={**EXISTING, "version": 2})
    sb.rules = [x for x in sb.rules if x.verb != "rpc"]
    sb.on_rpc("save_individual", data=lambda call: {
        **save_rpc({**EXISTING, "version": 1}, at=T1)(call), "replayed": True})
    r = _call(sb, "POST", "/api/individuals", json={"data": {"name": "Ann Lee", "height": 70, "weight": 150},
                                                    "merge_with_id": ID, "expected_version": 1},
              headers={"Idempotency-Key": KEY})
    assert r.status_code == 200, r.text
    assert r.json()["replayed"] is True
    assert sb.rpc_params("save_individual")[-1]["p_expected_version"] == 1


def test_expected_version_without_merge_with_id_is_422():
    sb = _db(existing=None)
    r = _call(sb, "POST", "/api/individuals",
              json={"data": {"name": "Bo", "height": 70, "weight": 150}, "expected_version": 2})
    assert r.status_code == 422
    assert "expected_version needs merge_with_id" in r.text
    assert sb.calls == []


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


def test_profile_includes_version():
    r = _call(_db(existing={**EXISTING, "version": 7}), "GET", f"/api/individuals/{ID}")
    assert r.status_code == 200, r.text
    assert r.json()["individual"]["version"] == 7


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


# --- the audit log (H2-2.7) ----------------------------------------------------------------

DEVICE = {"X-Device-Id": "device-1234"}


def _audited(sb):
    return sb.on("audit_log", "insert", data=lambda c: [c.payload])


def _audit_row(action, entity_id, detail=None):
    return {"user_id": "test-user-123", "device_id": "device-1234", "action": action,
            "entity_type": "individual", "entity_id": entity_id, "detail": detail or {}}


def test_view_profile_is_audited_with_user_and_device():
    sb = _audited(_db())
    assert _call(sb, "GET", f"/api/individuals/{ID}", headers=DEVICE).status_code == 200
    assert sb.payloads("audit_log", "insert") == [_audit_row("view_profile", ID)]


def test_delete_individual_is_audited_with_user_and_device():
    sb = _audited(FakeSupabase().on("individuals", "delete", data=[{"id": ID}]))
    assert _call(sb, "DELETE", f"/api/individuals/{ID}", headers=DEVICE).status_code == 200
    assert sb.payloads("audit_log", "insert") == [_audit_row("delete_individual", ID)]


def test_override_urgency_is_audited_with_user_and_device():
    sb = _audited(FakeSupabase().on("individuals", "update", data=lambda call: [
        {"id": ID, "urgency_score": 45, **call.payload}]))
    r = _call(sb, "PUT", f"/api/individuals/{ID}/urgency-override", json={"urgency_override": 70}, headers=DEVICE)
    assert r.status_code == 200
    assert sb.payloads("audit_log", "insert") == [_audit_row("override_urgency", ID, {"urgency_override": 70})]


def test_merge_individual_is_audited_with_user_and_device():
    sb = _audited(_db())
    r = _call(sb, "POST", "/api/individuals", headers=DEVICE,
              json={"data": {"name": "Ann Lee", "height": 70, "weight": 150}, "merge_with_id": ID})
    assert r.status_code == 200, r.text
    assert sb.payloads("audit_log", "insert") == [_audit_row("merge_individual", ID, {"interaction_id": INTERACTION_ID})]


def test_create_individual_is_audited_with_user_and_device():
    sb = _audited(_db(existing=None))
    r = _call(sb, "POST", "/api/individuals", headers=DEVICE, json={"data": {"name": "Bo", "height": 70, "weight": 150}})
    assert r.status_code == 200, r.text
    assert sb.payloads("audit_log", "insert") == [_audit_row("create_individual", ID, {"interaction_id": INTERACTION_ID})]


def test_a_404_profile_is_not_audited():
    sb = _audited(_db(existing=None))
    assert _call(sb, "GET", f"/api/individuals/{ID}").status_code == 404
    assert sb.payloads("audit_log", "insert") == []


def test_a_404_delete_is_not_audited():
    sb = _audited(FakeSupabase().on("individuals", "delete", data=[]))
    assert _call(sb, "DELETE", f"/api/individuals/{ID}").status_code == 404
    assert sb.payloads("audit_log", "insert") == []


def test_a_409_merge_is_not_audited():
    sb = _audited(_db_rpc_error(pg_error("P0409")))
    assert _merge(sb, {"name": "Ann Lee", "height": 70, "weight": 150}).status_code == 409
    assert sb.payloads("audit_log", "insert") == []


def test_a_replayed_save_is_not_audited():
    sb = _audited(_db(existing=None))
    sb.rules = [x for x in sb.rules if x.verb != "rpc"]
    sb.on_rpc("save_individual", data=_replay())
    r = _call(sb, "POST", "/api/individuals", json={"data": {"name": "Bo", "height": 70, "weight": 150}},
              headers={"Idempotency-Key": KEY})
    assert r.status_code == 200 and r.json()["replayed"] is True
    assert sb.payloads("audit_log", "insert") == []


def test_an_audit_failure_never_fails_the_request():
    sb = _db().on("audit_log", "insert", error=RuntimeError("audit down"))
    assert _call(sb, "GET", f"/api/individuals/{ID}").status_code == 200


def test_audit_detail_never_carries_names_or_field_values():
    import json
    sb = _audited(_db(existing=None))
    _call(sb, "POST", "/api/individuals", json={"data": {"name": "Ann Lee", "height": 70, "weight": 150}})
    sb2 = _audited(_db())
    _merge(sb2, {"name": "Ann Lee", "height": 71, "weight": 150})
    rows = sb.payloads("audit_log", "insert") + sb2.payloads("audit_log", "insert")
    assert len(rows) == 2 and "Ann" not in json.dumps(rows)
