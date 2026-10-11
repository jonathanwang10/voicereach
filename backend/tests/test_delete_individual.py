"""DELETE /api/individuals/{id} (R-1 backend, C-10) and the atomic save (R-11, C-57)."""
import asyncio
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from main import app
from services.individual_service import IndividualService

IND_ID = str(uuid4())


def _client():
    return TestClient(app, raise_server_exceptions=False)


def test_service_delete_returns_true_when_a_row_was_deleted():
    sb = MagicMock()
    sb.table.return_value.delete.return_value.eq.return_value.execute.return_value.data = [{"id": IND_ID}]
    assert asyncio.run(IndividualService(sb).delete_individual(IND_ID)) is True
    sb.table.assert_called_with("individuals")
    sb.table.return_value.delete.return_value.eq.assert_called_with("id", IND_ID)


def test_service_delete_returns_false_when_no_row():
    sb = MagicMock()
    sb.table.return_value.delete.return_value.eq.return_value.execute.return_value.data = []
    assert asyncio.run(IndividualService(sb).delete_individual(IND_ID)) is False


def test_delete_route_deletes_and_invalidates_the_assistant_cache():
    with patch("api.individuals.get_supabase_client"), \
         patch("api.individuals.IndividualService") as svc, \
         patch("api.individuals.invalidate_context_cache") as invalidate:
        svc.return_value.delete_individual = MagicMock(side_effect=lambda _id: _async(True))
        r = _client().delete(f"/api/individuals/{IND_ID}")
    assert r.status_code == 200
    assert r.json() == {"id": IND_ID, "deleted": True}
    invalidate.assert_called_once()


def test_delete_route_404_and_no_cache_invalidation_when_missing():
    with patch("api.individuals.get_supabase_client"), \
         patch("api.individuals.IndividualService") as svc, \
         patch("api.individuals.invalidate_context_cache") as invalidate:
        svc.return_value.delete_individual = MagicMock(side_effect=lambda _id: _async(False))
        r = _client().delete(f"/api/individuals/{IND_ID}")
    assert r.status_code == 404
    invalidate.assert_not_called()


def test_delete_route_rejects_a_bad_uuid():
    assert _client().delete("/api/individuals/not-a-uuid").status_code == 422


def test_delete_route_500_is_generic():
    with patch("api.individuals.get_supabase_client", side_effect=RuntimeError("secret detail")):
        r = _client().delete(f"/api/individuals/{IND_ID}")
    assert r.status_code == 500
    assert r.json() == {"detail": "Delete individual failed"}


async def _async(value):
    return value


# --- R-11: the save is not transactional, so a failed first interaction deletes the new person ---

class _Table:
    def __init__(self, sb, name):
        self.sb, self.name, self.op, self.payload = sb, name, None, None

    def select(self, *a, **k):
        self.op = "select"
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, *a):
        self.eq_args = a
        return self

    def maybe_single(self):
        return self

    def execute(self):
        self.sb.calls.append((self.name, self.op, self.payload))
        if self.name == "categories":
            return MagicMock(data=self.sb.categories)
        if self.name == "interactions" and self.op == "insert" and self.sb.fail_interaction:
            raise RuntimeError("interaction insert failed")
        if self.name == "individuals" and self.op == "insert":
            return MagicMock(data=[{**self.payload, "id": IND_ID, "created_at": "2026-01-01T00:00:00Z",
                                    "updated_at": "2026-01-01T00:00:00Z"}])
        if self.name == "individuals" and self.op == "select":
            return MagicMock(data=self.sb.existing)
        if self.name == "individuals" and self.op == "update":
            return MagicMock(data=[{**(self.sb.existing or {}), **self.payload}])
        if self.name == "individuals" and self.op == "delete":
            return MagicMock(data=[{"id": IND_ID}])
        if self.name == "interactions" and self.op == "insert":
            return MagicMock(data=[{"id": str(uuid4()), "created_at": "2026-01-01T00:00:00Z",
                                    "user_name": "Demo User", "location": None}])
        return MagicMock(data=[])


class _FakeSupabase:
    def __init__(self, fail_interaction=False, existing=None):
        self.calls, self.fail_interaction, self.existing = [], fail_interaction, existing
        self.categories = [
            {"name": "height", "type": "number", "is_required": True, "urgency_weight": 0, "auto_trigger": False},
            {"name": "weight", "type": "number", "is_required": True, "urgency_weight": 0, "auto_trigger": False},
        ]

    def table(self, name):
        return _Table(self, name)


DATA = {"name": "Sam", "height": 70, "weight": 180}


def test_new_person_is_deleted_when_the_interaction_insert_fails():
    sb = _FakeSupabase(fail_interaction=True)
    with pytest.raises(RuntimeError):
        asyncio.run(IndividualService(sb).save_individual("u", "Demo User", dict(DATA)))
    ops = [(t, o) for t, o, _ in sb.calls]
    assert ("individuals", "insert") in ops
    assert ops[-1] == ("individuals", "delete")


def test_compensating_delete_failure_does_not_mask_the_original_error():
    sb = _FakeSupabase(fail_interaction=True)
    real_execute = _Table.execute

    def boom(self):
        if self.name == "individuals" and self.op == "delete":
            raise ConnectionError("delete also failed")
        return real_execute(self)

    with patch.object(_Table, "execute", boom), pytest.raises(RuntimeError, match="interaction insert failed"):
        asyncio.run(IndividualService(sb).save_individual("u", "Demo User", dict(DATA)))


def test_successful_new_save_never_deletes():
    sb = _FakeSupabase()
    asyncio.run(IndividualService(sb).save_individual("u", "Demo User", dict(DATA)))
    assert ("individuals", "delete") not in [(t, o) for t, o, _ in sb.calls]


def test_merge_is_update_then_interaction_and_never_deletes_on_failure():
    existing = {"id": IND_ID, "name": "Sam", "data": {"height": 70, "weight": 170}, "urgency_score": 0,
                "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"}
    sb = _FakeSupabase(fail_interaction=True, existing=existing)
    with pytest.raises(RuntimeError):
        asyncio.run(IndividualService(sb).save_individual("u", "Demo User", dict(DATA), merge_with_id=IND_ID))
    ops = [(t, o) for t, o, _ in sb.calls if t == "individuals"]
    assert ops == [("individuals", "select"), ("individuals", "update")]


def test_merge_into_a_missing_person_raises_value_error_not_an_attribute_error():
    sb = _FakeSupabase(existing=None)
    with pytest.raises(ValueError, match="not found"):
        asyncio.run(IndividualService(sb).save_individual("u", "Demo User", dict(DATA), merge_with_id=IND_ID))
