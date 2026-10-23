"""POST /api/embeddings/search (H2-4.2): one call to search_individuals_hybrid with the query
embedding (or none: text only), results in SQL order. OpenAI is never called."""
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app
from services.embedding_service import EmbeddingService
from tests.helpers import FakeSupabase

VEC = [0.01] * 3072
T = "2026-01-01T00:00:00+00:00"


def _row(i, name, source, similarity=None, score=0.03):
    return {"id": f"00000000-0000-0000-0000-00000000000{i}", "name": name, "data": {}, "urgency_score": 10,
            "urgency_override": None, "last_location": None, "version": 1, "created_at": T, "updated_at": T,
            "score": score, "match_source": source, "similarity": similarity}


ROWS = [_row(1, "Ann", "exact", score=0.033), _row(2, "Annie", "name", score=0.03), _row(3, "Bob", "text", score=0.02),
        _row(4, "Cy", "semantic", similarity=0.42, score=0.016)]


def _sb(rows=(), error=None):
    sb = FakeSupabase().on("interactions", "select", data=[])
    if error is not None:
        return sb.on_rpc("search_individuals_hybrid", error=error)
    return sb.on_rpc("search_individuals_hybrid", data=list(rows))


def _post(sb, body):
    with patch("api.embeddings.get_supabase", return_value=sb):
        return TestClient(app, raise_server_exceptions=False).post("/api/embeddings/search", json=body)


def test_search_calls_the_hybrid_rpc_with_the_query_embedding(monkeypatch):
    monkeypatch.setattr(EmbeddingService, "embed_query", AsyncMock(return_value=VEC))
    sb = _sb()
    body = _post(sb, {"query": "veteran near market"}).json()
    assert sb.rpc_params("search_individuals_hybrid") == [{"p_query": "veteran near market",
        "p_query_embedding": VEC, "p_limit": 10, "p_min_similarity": 0.15}]
    assert body["semantic_used"] is True


def test_embedding_failure_falls_back_to_text_only(caplog):          # Review Focus 2 (conftest: embed_query raises)
    sb = _sb(ROWS[:1])
    r = _post(sb, {"query": "ann"})
    assert r.status_code == 200
    assert sb.rpc_params("search_individuals_hybrid")[0]["p_query_embedding"] is None
    assert r.json()["semantic_used"] is False and r.json()["results"][0]["name"] == "Ann"
    assert "Query embedding failed: RuntimeError" in caplog.text and "ann" not in caplog.text.lower().replace("query", "")


@pytest.mark.real_query_embedding
def test_short_query_is_text_only_without_an_openai_call(monkeypatch):
    generate = AsyncMock()
    monkeypatch.setattr(EmbeddingService, "generate_embeddings", generate)
    sb = _sb()
    assert _post(sb, {"query": "ab"}).status_code == 200
    assert sb.rpc_params("search_individuals_hybrid")[0]["p_query_embedding"] is None
    generate.assert_not_awaited()


def test_blank_query_returns_nothing_without_a_database_call():
    sb = _sb()
    body = _post(sb, {"query": "   "}).json()
    assert body["results"] == [] and sb.calls == []


@pytest.mark.parametrize("q", ["50%_", "a & !b", '"quoted', "O'Brien", "diab:*", "🙂 ann"])
def test_query_text_reaches_sql_unchanged(q):                       # Review Focus 1
    sb = _sb()
    assert _post(sb, {"query": f"  {q} "}).status_code == 200
    assert sb.rpc_params("search_individuals_hybrid")[0]["p_query"] == q.strip()


def test_results_keep_sql_order_and_map_match_source():
    body = _post(_sb(ROWS), {"query": "ann"}).json()
    results = body["results"]
    assert [(r["name"], r["search_type"], r["similarity_score"]) for r in results] == [
        ("Ann", "exact", 1.0), ("Annie", "name", None), ("Bob", "value", None), ("Cy", "semantic", 0.42)]
    assert results[0]["score"] == ROWS[0]["score"]
    assert (body["total_results"], body["normal_results"], body["semantic_results"]) == (4, 3, 1)


def test_search_database_error_is_500():                             # C-17
    r = _post(_sb(error=RuntimeError("db down")), {"query": "ann"})
    assert (r.status_code, r.json()) == (500, {"detail": "Search failed"})
