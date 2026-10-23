"""Query embeddings: a process cache (256 entries, 10 min) and no semantic leg under 3 characters (H2-4.5)."""
import asyncio
from unittest.mock import AsyncMock

import pytest

from services import embedding_service
from services.embedding_service import EmbeddingService, normalize_query

pytestmark = pytest.mark.real_query_embedding


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def svc():
    s = EmbeddingService.__new__(EmbeddingService)
    s.dimensions = 3072
    s.generate_embeddings = AsyncMock(side_effect=lambda texts: [[0.1] * 3072 for _ in texts])
    return s


def test_normalize_query():
    assert normalize_query("  Veteran \t near\nMarket ") == "veteran near market"


def test_same_normalised_query_embeds_once(svc):
    run(svc.embed_query("Veteran  near Market ")); run(svc.embed_query("veteran near market"))
    svc.generate_embeddings.assert_awaited_once_with(["veteran near market"])


@pytest.mark.parametrize("query,embedded", [("ab", False), ("  ab  ", False), ("a b", True), ("Al ", False), ("abc", True)])
def test_semantic_leg_needs_three_characters(svc, query, embedded):                    # Review Focus 3
    assert (run(svc.embed_query(query)) is not None) is embedded
    assert svc.generate_embeddings.await_count == (1 if embedded else 0)


def test_entries_expire_after_ten_minutes(svc, monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(embedding_service, "_now", lambda: clock[0])
    run(svc.embed_query("veteran"))
    clock[0] = 599
    run(svc.embed_query("veteran"))
    assert svc.generate_embeddings.await_count == 1
    clock[0] = 601
    run(svc.embed_query("veteran"))
    assert svc.generate_embeddings.await_count == 2


def test_cache_keeps_the_256_most_recently_used(svc):
    for i in range(256):
        run(svc.embed_query(f"q{i:03d}"))
    run(svc.embed_query("q000"))                         # touch q000
    run(svc.embed_query("q256"))                         # evicts q001
    calls = svc.generate_embeddings.await_count
    run(svc.embed_query("q000"))
    assert svc.generate_embeddings.await_count == calls  # still cached
    run(svc.embed_query("q001"))
    assert svc.generate_embeddings.await_count == calls + 1


def test_failures_are_not_cached(svc):
    svc.generate_embeddings = AsyncMock(side_effect=[RuntimeError("down"), [[0.2] * 3072]])
    with pytest.raises(RuntimeError):
        run(svc.embed_query("veteran"))
    assert run(svc.embed_query("veteran")) == [0.2] * 3072
    assert svc.generate_embeddings.await_count == 2
