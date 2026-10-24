"""POST/GET/DELETE /api/recordings (H2-7.2, H2-7.4): the upload is stored in the private
bucket and queued as a job; a repeated client_recording_id is the same recording."""
import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from main import app
from tests.helpers import FakeSupabase

M4A = b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 64
CRID = "6f1c0d1e-0000-4000-8000-000000000001"
RID = "7a2d0e1f-0000-4000-8000-000000000002"
LOC = {"latitude": 37.78, "longitude": -122.41, "address": "Market St"}
RESULT = {"transcription": "Met Ann", "categorized_data": {"name": "Ann Lee", "height": 70},
          "missing_required": ["weight"], "potential_matches": [], "validation_errors": [],
          "duplicate_check_failed": False}


def _call(sb, method, path, **kwargs):
    with patch("api.recordings.get_supabase", return_value=sb), \
         patch("services.recording_pipeline.check_audio_duration", return_value=61.5):
        return TestClient(app).request(method, path, **kwargs)


def _post(sb, audio=M4A, data=None, headers=None):
    body = {"client_recording_id": CRID, "duration_ms": "61000", "location": json.dumps(LOC)}
    body.update(data or {})
    return _call(sb, "POST", "/api/recordings", files={"audio": ("a.m4a", audio, "audio/mp4")},
                 data=body, headers=headers or {})


def _eqs(call):
    return [a for n, a, _ in call.mods if n == "eq"]


# --- POST ---------------------------------------------------------------------------

def test_upload_stores_the_file_and_queues_a_job_202():
    sb = FakeSupabase()
    sb.on("recordings", "select", data=[])
    sb.on("recordings", "insert", data=lambda c: [{"id": RID, **c.payload}])
    r = _post(sb, headers={"X-Device-Id": "dev-00000001"})
    assert r.status_code == 202, r.text
    assert r.json() == {"id": RID, "status": "queued"}
    assert sb.storage.calls == [("recordings", "upload", f"{CRID}.m4a", {"content-type": "audio/mp4", "upsert": "true"})]
    assert sb.storage.files[("recordings", f"{CRID}.m4a")] == M4A
    assert sb.payloads("recordings", "insert") == [{
        "user_id": "test-user-123", "device_id": "dev-00000001", "client_recording_id": CRID, "status": "queued",
        "storage_path": f"{CRID}.m4a", "duration_ms": 61500, "location": LOC}]


def test_upload_without_a_location_stores_none():
    sb = FakeSupabase()
    sb.on("recordings", "select", data=[])
    sb.on("recordings", "insert", data=lambda c: [{"id": RID, **c.payload}])
    r = _call(sb, "POST", "/api/recordings", files={"audio": ("a.m4a", M4A, "audio/mp4")},
              data={"client_recording_id": CRID, "duration_ms": "61000"})
    assert r.status_code == 202, r.text
    assert sb.payloads("recordings", "insert")[0]["location"] is None
    assert sb.payloads("recordings", "insert")[0]["device_id"] is None


def test_repeated_client_recording_id_returns_the_existing_row_without_reuploading():
    sb = FakeSupabase().on("recordings", "select", data=[{"id": RID, "user_id": "test-user-123", "status": "ready"}])
    r = _post(sb)
    assert r.status_code == 202 and r.json() == {"id": RID, "status": "ready"}
    assert sb.storage.calls == [] and sb.calls_to("recordings", "insert") == []
    assert _eqs(sb.calls_to("recordings", "select")[0]) == [("client_recording_id", CRID)]


def test_a_concurrent_duplicate_insert_returns_the_row_that_won():
    from postgrest.exceptions import APIError
    sb = FakeSupabase()
    sb.on("recordings", "select", data=[], times=1)
    sb.on("recordings", "insert", error=APIError({"code": "23505", "message": "duplicate key"}))
    sb.on("recordings", "select", data=[{"id": RID, "user_id": "test-user-123", "status": "queued"}])
    r = _post(sb)
    assert r.status_code == 202 and r.json()["id"] == RID


def test_another_users_client_recording_id_is_409():
    sb = FakeSupabase().on("recordings", "select", data=[{"id": RID, "user_id": "someone-else", "status": "queued"}])
    r = _post(sb)
    assert (r.status_code, r.json()) == (409, {"detail": "This recording id is already in use."})
    assert sb.storage.calls == []


@pytest.mark.parametrize("audio,measure,detail", [
    (b"not audio", None, "File is not in M4A format"),
    (M4A, ValueError("Audio must be at least 5 seconds long"), "Audio must be at least 5 seconds long"),
])
def test_bad_audio_is_400_before_any_storage_or_database_work(audio, measure, detail):
    sb = FakeSupabase()
    with patch("api.recordings.get_supabase", return_value=sb), \
         patch("services.recording_pipeline.check_audio_duration", side_effect=measure or (lambda p, lim: 61.5)):
        r = TestClient(app).post("/api/recordings", files={"audio": ("a.m4a", audio, "audio/mp4")},
                                 data={"client_recording_id": CRID, "duration_ms": "61000"})
    assert (r.status_code, r.json()) == (400, {"detail": detail})
    assert sb.calls == [] and sb.storage.calls == []


def test_bad_location_json_is_422():
    sb = FakeSupabase()
    r = _post(sb, data={"location": "{not json"})
    assert r.status_code == 422
    assert isinstance(r.json()["detail"], str)
    assert sb.calls == [] and sb.storage.calls == []


@pytest.mark.parametrize("duration", ["125001", "-1", "abc"])
def test_duration_ms_out_of_range_is_422(duration):
    sb = FakeSupabase()
    assert _post(sb, data={"duration_ms": duration}).status_code == 422
    assert sb.calls == []


def test_a_malformed_client_recording_id_is_422():
    assert _post(FakeSupabase(), data={"client_recording_id": "nope"}).status_code == 422


def test_failed_insert_removes_the_uploaded_file_and_is_500():
    sb = FakeSupabase().on("recordings", "select", data=[])
    sb.on("recordings", "insert", error=RuntimeError("db down"))
    r = _post(sb)
    assert r.status_code == 500 and r.json() == {"detail": "Recording upload failed"}
    assert ("recordings", "remove", [f"{CRID}.m4a"], None) in sb.storage.calls


# --- GET one ------------------------------------------------------------------------

def _row(**kw):
    row = {"id": RID, "user_id": "test-user-123", "device_id": None, "client_recording_id": CRID,
           "status": "ready", "storage_path": None, "duration_ms": 61500, "location": LOC,
           "transcription": "Met Ann", "result": RESULT, "error": None, "attempts": 1,
           "created_at": "2026-11-07T10:00:00+00:00", "updated_at": "2026-11-07T10:01:00+00:00"}
    row.update(kw)
    return row


def test_get_returns_status_and_result_for_the_owner():
    sb = FakeSupabase().on("recordings", "select", data=[_row()])
    r = _call(sb, "GET", f"/api/recordings/{RID}")
    assert r.status_code == 200, r.text
    assert r.json() == {"id": RID, "status": "ready", "error": None, "result": RESULT, "location": LOC,
                        "duration_ms": 61500, "created_at": "2026-11-07T10:00:00+00:00"}
    assert _eqs(sb.calls[0]) == [("id", RID), ("user_id", "test-user-123")]


def test_get_an_in_progress_recording_has_no_result():
    sb = FakeSupabase().on("recordings", "select", data=[_row(status="transcribing", result=None, transcription=None)])
    body = _call(sb, "GET", f"/api/recordings/{RID}").json()
    assert body["status"] == "transcribing" and body["result"] is None


def test_get_someone_elses_recording_is_404():
    sb = FakeSupabase().on("recordings", "select", data=[])
    r = _call(sb, "GET", f"/api/recordings/{RID}")
    assert (r.status_code, r.json()) == (404, {"detail": "Recording not found"})


def test_get_a_bad_id_is_422():
    assert _call(FakeSupabase(), "GET", "/api/recordings/not-a-uuid").status_code == 422


# --- GET list -----------------------------------------------------------------------

def test_list_is_the_callers_newest_first_with_the_name_from_the_result():
    rows = [_row(), _row(id="7a2d0e1f-0000-4000-8000-000000000003", status="queued", result=None)]
    sb = FakeSupabase().on("recordings", "select", data=rows)
    r = _call(sb, "GET", "/api/recordings?status=ready", headers={"X-Device-Id": "dev-00000001"})
    assert r.status_code == 200, r.text
    call = sb.calls[0]
    assert _eqs(call) == [("user_id", "test-user-123"), ("device_id", "dev-00000001"), ("status", "ready")]
    assert call.mod("order") == (("created_at",), {"desc": True})
    assert call.mod("limit") == ((50,), {})
    names = [s["name"] for s in r.json()["recordings"]]
    assert names == ["Ann Lee", None]
    assert set(r.json()["recordings"][0]) == {"id", "status", "error", "name", "duration_ms", "created_at"}


def test_list_without_a_device_header_filters_by_user_only():
    sb = FakeSupabase().on("recordings", "select", data=[])
    assert _call(sb, "GET", "/api/recordings").json() == {"recordings": []}
    assert _eqs(sb.calls[0]) == [("user_id", "test-user-123")]


def test_list_rejects_an_unknown_status_with_422():
    sb = FakeSupabase()
    assert _call(sb, "GET", "/api/recordings?status=done").status_code == 422
    assert sb.calls == []


# --- DELETE -------------------------------------------------------------------------

def test_delete_removes_the_stored_file_then_the_row_204():
    sb = FakeSupabase().on("recordings", "select", data=[_row(storage_path=f"{CRID}.m4a")])
    sb.on("recordings", "delete", data=[{"id": RID}])
    sb.storage.files[("recordings", f"{CRID}.m4a")] = M4A
    r = _call(sb, "DELETE", f"/api/recordings/{RID}")
    assert r.status_code == 204
    assert sb.storage.calls == [("recordings", "remove", [f"{CRID}.m4a"], None)]
    [delete] = sb.calls_to("recordings", "delete")
    assert _eqs(delete) == [("id", RID), ("user_id", "test-user-123")]


def test_delete_skips_storage_when_the_file_is_already_gone():
    sb = FakeSupabase().on("recordings", "select", data=[_row(storage_path=None)])
    sb.on("recordings", "delete", data=[{"id": RID}])
    assert _call(sb, "DELETE", f"/api/recordings/{RID}").status_code == 204
    assert sb.storage.calls == []


def test_delete_is_404_when_not_the_callers():
    sb = FakeSupabase().on("recordings", "select", data=[])
    r = _call(sb, "DELETE", f"/api/recordings/{RID}")
    assert (r.status_code, r.json()) == (404, {"detail": "Recording not found"})
    assert sb.calls_to("recordings", "delete") == []


def test_delete_keeps_the_row_when_storage_removal_fails_500():
    sb = FakeSupabase().on("recordings", "select", data=[_row(storage_path=f"{CRID}.m4a")])
    sb.storage.fail["remove"] = RuntimeError("storage down")
    r = _call(sb, "DELETE", f"/api/recordings/{RID}")
    assert r.status_code == 500 and r.json() == {"detail": "Delete recording failed"}
    assert sb.calls_to("recordings", "delete") == []
