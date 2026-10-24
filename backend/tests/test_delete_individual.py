"""DELETE /api/individuals/{id} (R-1 backend, C-10) and the atomic save (R-11, C-57, H2-2.2)."""
import asyncio
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from main import app
from postgrest.exceptions import APIError

from services.individual_service import IndividualService
from tests.helpers import FakeSupabase, pg_error, save_rpc

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


def test_delete_route_deletes():
    with patch("api.individuals.get_supabase"), \
         patch("api.individuals.IndividualService") as svc:
        svc.return_value.delete_individual = MagicMock(side_effect=lambda _id: _async(True))
        r = _client().delete(f"/api/individuals/{IND_ID}")
    assert r.status_code == 200
    assert r.json() == {"id": IND_ID, "deleted": True}


def test_delete_route_404_when_missing():
    with patch("api.individuals.get_supabase"), \
         patch("api.individuals.IndividualService") as svc:
        svc.return_value.delete_individual = MagicMock(side_effect=lambda _id: _async(False))
        r = _client().delete(f"/api/individuals/{IND_ID}")
    assert r.status_code == 404


def test_delete_route_rejects_a_bad_uuid():
    assert _client().delete("/api/individuals/not-a-uuid").status_code == 422


def test_delete_route_500_is_generic():
    with patch("api.individuals.get_supabase", side_effect=RuntimeError("secret detail")):
        r = _client().delete(f"/api/individuals/{IND_ID}")
    assert r.status_code == 500
    assert r.json() == {"detail": "Delete individual failed"}


async def _async(value):
    return value


# --- R-11: the save is not transactional, so a failed first interaction deletes the new person ---

CATEGORIES = [
    {"name": "height", "type": "number", "is_required": True, "urgency_weight": 0, "auto_trigger": False},
    {"name": "weight", "type": "number", "is_required": True, "urgency_weight": 0, "auto_trigger": False},
]
DATA = {"name": "Sam", "height": 70, "weight": 180}
EXISTING = {"id": IND_ID, "name": "Sam", "data": {"height": 70, "weight": 170}, "urgency_score": 0, "version": 1,
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"}


def _sb(existing=None, rpc_error=None):
    sb = FakeSupabase().on("categories", "select", data=CATEGORIES)
    sb.on("individuals", "select", data=[existing] if existing else [])
    if rpc_error is not None:
        sb.on_rpc("save_individual", error=rpc_error)
    else:
        sb.on_rpc("save_individual", data=save_rpc(existing, new_id=IND_ID))
    return sb


def test_a_failed_save_surfaces_its_error_and_writes_no_table_directly():
    """H2-2.2: the person and the visit are one save_individual transaction, so a
    failure leaves nothing behind and there is no compensating delete to run."""
    sb = _sb(rpc_error=pg_error("XX000", "interaction insert failed"))
    with pytest.raises(APIError, match="interaction insert failed"):
        asyncio.run(IndividualService(sb).save_individual("u", "Demo User", dict(DATA)))
    assert [(c.table, c.verb) for c in sb.calls if c.verb != "select"] == [("save_individual", "rpc")]


def test_successful_new_save_is_one_rpc_and_never_deletes():
    sb = _sb()
    asyncio.run(IndividualService(sb).save_individual("u", "Demo User", dict(DATA)))
    assert [(c.table, c.verb) for c in sb.calls if c.verb != "select"] == [("save_individual", "rpc")]


def test_a_failed_merge_writes_no_table_directly():
    sb = _sb(existing=EXISTING, rpc_error=pg_error("XX000", "interaction insert failed"))
    with pytest.raises(APIError):
        asyncio.run(IndividualService(sb).save_individual("u", "Demo User", dict(DATA), merge_with_id=IND_ID))
    assert [(c.table, c.verb) for c in sb.calls if c.table == "individuals"] == [("individuals", "select")]


def test_merge_into_a_missing_person_raises_not_found_not_an_attribute_error():
    from services.individual_service import IndividualNotFound
    sb = _sb(existing=None)
    with pytest.raises(IndividualNotFound, match="not found"):
        asyncio.run(IndividualService(sb).save_individual("u", "Demo User", dict(DATA), merge_with_id=IND_ID))
