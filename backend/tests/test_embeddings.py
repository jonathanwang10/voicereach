"""Semantic search ranking: cosine order, the 0.15 threshold, top_k, and the route's use of it.
OpenAI is never called: the query embedding is a fake vector."""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from services.embedding_service import EmbeddingService
from tests.helpers import FakeListDB, person

QUERY = [1.0, 0.0]
STORED = [
    ("orthogonal", [0.0, 1.0]),    # cosine 0.0  -> below 0.15, dropped
    ("close", [1.0, 0.2]),         # cosine 0.98
    ("diagonal", [1.0, 1.0]),      # cosine 0.71
    ("opposite", [-1.0, 0.0]),     # cosine -1.0 -> dropped
    ("same", [2.0, 0.0]),          # cosine 1.0 (length doesn't matter)
    ("weak", [0.1, 1.0]),          # cosine 0.0995 -> dropped
]


def _service():
    svc = EmbeddingService.__new__(EmbeddingService)
    svc.dimensions = 2
    svc.generate_embedding = AsyncMock(return_value=QUERY)
    return svc


def _rank(**kwargs):
    return asyncio.run(_service().search_similar_individuals(QUERY, STORED, **kwargs))


def test_results_are_by_cosine_similarity_highest_first_and_below_threshold_dropped():
    results = _rank()
    assert [r["individual_id"] for r in results] == ["same", "close", "diagonal"]
    assert results[0]["similarity_score"] == pytest.approx(1.0)
    assert results[2]["similarity_score"] == pytest.approx(0.7071, abs=1e-4)


def test_threshold_is_inclusive_and_adjustable():
    assert [r["individual_id"] for r in _rank(similarity_threshold=0.9)] == ["same", "close"]
    assert [r["individual_id"] for r in _rank(similarity_threshold=0.0)] == ["same", "close", "diagonal", "weak", "orthogonal"]


def test_top_k_keeps_the_best():
    assert [r["individual_id"] for r in _rank(top_k=2)] == ["same", "close"]


def test_no_stored_embeddings_is_no_results():
    assert asyncio.run(_service().search_similar_individuals(QUERY, [])) == []


def test_semantic_search_embeds_the_query_once_and_ranks():
    svc = _service()
    results = asyncio.run(svc.semantic_search("veteran near market", STORED, top_k=1))
    svc.generate_embedding.assert_awaited_once_with("veteran near market")
    assert [r["individual_id"] for r in results] == ["same"]


def test_search_route_returns_semantic_hits_in_score_order():
    import api.embeddings as emb
    from main import app
    ids = {name: f"00000000-0000-0000-0000-00000000000{i}" for i, (name, _) in enumerate(STORED, start=1)}
    people = [person(i, name=name.title()) for i, (name, _) in enumerate(STORED, start=1)]
    rows = [{"individual_id": ids[name], "embedding_data": vec, "individuals": people[i]}
            for i, (name, vec) in enumerate(STORED)]
    sb = FakeListDB(people, [], embeddings=rows)
    with patch.object(emb, "get_supabase", return_value=sb), patch.object(emb, "embedding_service", _service()):
        r = TestClient(app).post("/api/embeddings/search", json={"query": "zzz"})  # no text match
    assert r.status_code == 200, r.text
    body = r.json()
    assert [x["name"] for x in body["results"]] == ["Same", "Close", "Diagonal"]
    assert all(x["search_type"] == "semantic" for x in body["results"])
    assert (body["semantic_results"], body["normal_results"], body["similarity_threshold"]) == (3, 0, 0.15)
