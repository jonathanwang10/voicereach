"""GET /api/individuals: last_seen, no N+1 (C-32, C-52, R-17); fetch_last_seen; display score; search fields."""
import asyncio
from unittest.mock import MagicMock, patch


from services.individual_service import IndividualService, fetch_last_seen
from services.urgency_calculator import get_display_urgency_score
from tests.helpers import ID1, ID2, FakeListDB, person


def test_fetch_last_seen_is_one_query_latest_wins_and_absent_ids_are_missing():
    sb = FakeListDB([], [
        {"individual_id": "a", "created_at": "2026-03-01T00:00:00+00:00", "location": {"address": "old"}},
        {"individual_id": "a", "created_at": "2026-05-01T00:00:00+00:00", "location": {"address": "new"}},
        {"individual_id": "b", "created_at": "2026-04-01T00:00:00+00:00", "location": None},
    ])
    out = fetch_last_seen(sb, ["a", "b", "c"])
    assert sb.count("interactions") == 1
    assert out["a"] == {"last_seen": "2026-05-01T00:00:00+00:00", "location": {"address": "new"}}
    assert out["b"]["location"] is None
    assert "c" not in out


def test_fetch_last_seen_with_no_ids_makes_no_query():
    sb = FakeListDB([], [])
    assert fetch_last_seen(sb, []) == {}
    assert sb.queries == []


def test_list_uses_one_interactions_query_for_many_people():
    people = [person(i) for i in range(1, 8)]
    sb = FakeListDB(people, [])
    asyncio.run(IndividualService(sb).search_individuals())
    assert sb.count("interactions") == 1


def test_last_seen_is_latest_interaction_else_created_at_never_updated_at():
    people = [person(1), person(2)]
    sb = FakeListDB(people, [{"individual_id": ID1, "created_at": "2026-08-01T00:00:00+00:00", "location": None}])
    res = asyncio.run(IndividualService(sb).search_individuals())
    by_id = {str(r.id): r for r in res.individuals}
    assert by_id[ID1].last_seen.isoformat() == "2026-08-01T00:00:00+00:00"
    assert by_id[ID2].last_seen.isoformat() == "2026-01-02T00:00:00+00:00"
    assert all(r.last_seen.month != 9 for r in res.individuals)  # updated_at is September
    assert [str(r.id) for r in res.individuals] == [ID1, ID2]  # newest first


def test_last_location_comes_from_the_latest_interaction_and_is_abbreviated():
    sb = FakeListDB([person(1)], [{"individual_id": ID1, "created_at": "2026-08-01T00:00:00+00:00",
                             "location": {"latitude": 1.0, "longitude": 2.0, "address": "Market Street & 5th Street, San Francisco"}}])
    res = asyncio.run(IndividualService(sb).search_individuals())
    assert res.individuals[0].last_location["address"] == "Market & 5th"


def test_display_score_prefers_override_even_when_zero():
    sb = FakeListDB([person(1, urgency_score=80, urgency_override=0)], [])
    res = asyncio.run(IndividualService(sb).search_individuals())
    assert res.individuals[0].display_score == 0


def test_search_term_never_reaches_a_sql_filter():
    # C-41: no PostgREST filter is built from raw input. Since Task 6 the term is
    # matched in Python by search_matching.match_individual (see test_search_matching.py).
    sb = FakeListDB([person(1)], [])
    asyncio.run(IndividualService(sb).search_individuals(search="50%_off\\"))
    assert [fs for t, fs in sb.queries if t == "individuals"] == [[]]


def test_pagination_only_looks_up_interactions_once_for_name_sort_too():
    people = [person(i) for i in range(1, 6)]
    sb = FakeListDB(people, [])
    res = asyncio.run(IndividualService(sb).search_individuals(sort_by="name", sort_order="asc", limit=2))
    assert sb.count("interactions") == 1
    assert [r.name for r in res.individuals] == ["Person 1", "Person 2"]
    assert res.total == 5


def test_get_display_urgency_score_is_the_single_helper():
    assert get_display_urgency_score({"urgency_score": 40, "urgency_override": 0}) == 0
    assert get_display_urgency_score({"urgency_score": 40, "urgency_override": None}) == 40
    assert get_display_urgency_score({"urgency_score": None, "urgency_override": None}) == 0


# --- /api/embeddings/search carries last_seen and display_score -----------------------------

def test_embeddings_search_results_carry_last_seen_and_display_score():
    from fastapi.testclient import TestClient
    from main import app

    people = [person(1, name="Sam", urgency_score=30, urgency_override=90)]
    sb = FakeListDB(people, [{"individual_id": ID1, "created_at": "2026-08-01T00:00:00+00:00", "location": None}])
    with patch("api.embeddings.get_supabase", return_value=sb), \
         patch("api.embeddings.embedding_service") as emb:
        emb.semantic_search = MagicMock(side_effect=lambda *a, **k: _none())
        r = TestClient(app, raise_server_exceptions=False).post("/api/embeddings/search", json={"query": "sam"})
    assert r.status_code == 200, r.text
    row = r.json()["results"][0]
    assert row["last_seen"] == "2026-08-01T00:00:00+00:00"
    assert row["display_score"] == 90
    assert sb.count("interactions") == 1


async def _none():
    return []


def test_one_default_similarity_threshold():
    from services import embedding_service as es
    from api.embeddings import SearchRequest
    assert es.DEFAULT_SIMILARITY_THRESHOLD == 0.15
    assert SearchRequest(query="x").similarity_threshold == es.DEFAULT_SIMILARITY_THRESHOLD
    import inspect
    for fn in (es.EmbeddingService.search_similar_individuals, es.EmbeddingService.semantic_search):
        assert inspect.signature(fn).parameters["similarity_threshold"].default == es.DEFAULT_SIMILARITY_THRESHOLD


def test_duplicate_prompt_loop_does_not_shadow_the_uuid_module():
    import inspect
    from services import duplicate_detection_service as d
    src = inspect.getsource(d)
    assert "for i, uuid in enumerate" not in src
