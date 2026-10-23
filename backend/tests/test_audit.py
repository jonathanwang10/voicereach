"""The audit log (H2-2.7): record_audit writes one row of ids, never raises, logs no personal data."""
import logging
import re
from pathlib import Path

from services.audit import AUDIT_ACTIONS, record_audit
from tests.helpers import FakeSupabase

ID = "550e8400-e29b-41d4-a716-446655440001"
FLAT_SCHEMA = re.sub(r"\s+", " ", re.sub(r"--[^\n]*", "", (
    Path(__file__).resolve().parents[2] / "supabase" / "schema.sql").read_text()))


def test_record_audit_inserts_one_row():
    sb = FakeSupabase().on("audit_log", "insert", data=lambda c: [c.payload])
    record_audit(sb, user_id="u1", device_id="device-1234", action="view_profile",
                 entity_type="individual", entity_id=ID)
    assert sb.payloads("audit_log", "insert") == [{"user_id": "u1", "device_id": "device-1234",
        "action": "view_profile", "entity_type": "individual", "entity_id": ID, "detail": {}}]


def test_record_audit_never_raises_and_logs_no_personal_data(caplog):
    sb = FakeSupabase().on("audit_log", "insert", error=RuntimeError("Ann Lee, HIV positive"))
    with caplog.at_level(logging.WARNING):
        assert record_audit(sb, user_id="u1", device_id=None, action="export_csv",
                            entity_type="export", entity_id=None, detail={"rows": 3}) is None
    assert "RuntimeError" in caplog.text and "export_csv" in caplog.text and "Ann" not in caplog.text


def test_an_unknown_action_is_not_written(caplog):
    sb = FakeSupabase()                      # nothing scripted: any write would fail
    with caplog.at_level(logging.WARNING):
        record_audit(sb, user_id="u1", device_id=None, action="read_minds",
                     entity_type="individual", entity_id=ID)
        record_audit(sb, user_id="u1", device_id=None, action="view_profile",
                     entity_type="planet", entity_id=ID)
    assert sb.calls == []
    assert "Audit skipped: unknown action read_minds" in caplog.text


def test_audit_actions_match_the_schema_check():
    check = re.search(r"action TEXT NOT NULL CHECK \(action IN \(([^)]*)\)\)", FLAT_SCHEMA).group(1)
    assert set(re.findall(r"'(\w+)'", check)) == AUDIT_ACTIONS


def test_audit_routes_use_phase_1s_device_dependency():
    from api import device, individuals, categories
    assert individuals.get_device_id is device.get_device_id and categories.get_device_id is device.get_device_id
