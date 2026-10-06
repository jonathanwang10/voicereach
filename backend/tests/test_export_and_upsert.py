import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


def _client_with_rows(rows):
    sb = MagicMock()
    sb.table.return_value.select.return_value.order.return_value.execute.return_value.data = rows
    return sb


def test_export_uses_override_zero():
    from main import app
    rows = [{"name": "Ann", "data": {"height": 60, "weight": 120}, "urgency_score": 80,
             "urgency_override": 0, "updated_at": "2025-01-01T00:00:00Z"}]
    with patch("api.categories.create_client", return_value=_client_with_rows(rows)):
        body = TestClient(app).get("/api/export").text
    line = body.splitlines()[1]
    assert ",0," in line and ",80," not in line


def test_export_route_registered_once():
    from main import app
    from tests.test_security_routes import _all_paths
    paths = [p for p in _all_paths(app) if p == "/api/export"]
    assert len(paths) == 1


@pytest.mark.real_embedding_task
def test_embedding_upsert_conflicts_on_individual_id():
    from api import individuals
    sb = MagicMock()
    with patch("api.individuals.get_supabase_client", return_value=sb), \
         patch("services.embedding_service.EmbeddingService.generate_individual_embedding",
               new=AsyncMock(return_value=[0.0] * 3)):
        asyncio.run(individuals.generate_embedding_background("i-1", {"name": "Ann", "data": {}}))
    _, kwargs = sb.table.return_value.upsert.call_args
    assert kwargs.get("on_conflict") == "individual_id"
