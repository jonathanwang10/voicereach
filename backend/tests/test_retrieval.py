"""The assistant's read-only retrieval functions (H2-4.7): compact, clipped dicts from the
hybrid search, the person, their visits and the most urgent people. Phase 5 serialises
these as delimited tool outputs."""
import asyncio
import inspect
from unittest.mock import AsyncMock, patch

import pytest

from services import retrieval
from services.embedding_service import EmbeddingService
from tests.helpers import FakeSupabase

PID = "00000000-0000-0000-0000-0000000000a1"
CID = "00000000-0000-0000-0000-0000000000c3"
VEC = [0.01] * 3072
T0, T1, T2 = "2026-01-01T00:00:00+00:00", "2026-03-01T00:00:00+00:00", "2026-05-01T00:00:00+00:00"
CATEGORIES = [
    {"name": "name", "display_name": "Name", "type": "text", "is_required": True},
    {"name": "housing_priority", "display_name": "Housing Priority", "type": "single_select"},
    {"name": "hiv_status", "display_name": "HIV status", "type": "text", "is_sensitive": True},
    {"name": "behavior", "display_name": "Behavior", "type": "single_select"},
]
ANN = {"id": PID, "name": "Ann Lee", "urgency_score": 30, "urgency_override": 80, "version": 1,
       "data": {"name": "Ann Lee", "housing_priority": "High", "hiv_status": "Negative", "aka": "Annie"},
       "last_location": {"latitude": 37.7847, "longitude": -122.4145, "address": "100 Turk St, SF"},
       "created_at": T0, "updated_at": T0}
NEWEST_INTERACTION = {"id": "00000000-0000-0000-0000-0000000000f2", "individual_id": PID, "created_at": T2,
                      "user_name": "Demo User", "transcription": "y" * 600,
                      "location": {"latitude": 37.7599, "longitude": -122.4148, "address": "16th & Mission"},
                      "changes": {"housing_priority": "High", "behavior": None, "_removed": ["behavior"]}}
OLDER_INTERACTION = {"id": "00000000-0000-0000-0000-0000000000f1", "individual_id": PID, "created_at": T1,
                     "user_name": "Demo User", "transcription": None, "location": None, "changes": {"name": "Ann Lee"}}
SUMMARY_KEYS = {"id", "name", "urgency", "urgency_overridden", "last_seen", "last_seen_area", "facts"}


def run(coro):
    return asyncio.run(coro)


def _hybrid(row, source="exact", similarity=None):
    return {**row, "score": 0.03, "match_source": source, "similarity": similarity}


def _db(**extra):
    sb = FakeSupabase().on("categories", "select", data=CATEGORIES)
    sb.on("interactions", "select", data=[NEWEST_INTERACTION, OLDER_INTERACTION])
    for name, data in extra.items():
        sb.on_rpc(name, data=data)
    return sb


@pytest.fixture
def patched():
    def apply(sb):
        return patch("services.retrieval.get_supabase", return_value=sb)
    return apply


def test_signatures_match_the_roadmap():
    assert str(inspect.signature(retrieval.search_people)) == "(query: str, limit: int = 5) -> list[dict]"
    assert str(inspect.signature(retrieval.get_person)) == "(individual_id: str) -> dict | None"
    assert str(inspect.signature(retrieval.recent_interactions)) == "(individual_id: str, limit: int = 5) -> list[dict]"
    assert str(inspect.signature(retrieval.most_urgent)) == "(near: str | None = None, limit: int = 5) -> list[dict]"
    assert all(inspect.iscoroutinefunction(f) for f in (retrieval.search_people, retrieval.get_person,
                                                       retrieval.recent_interactions, retrieval.most_urgent))




def test_search_people_returns_compact_summaries_without_sensitive_facts(patched, monkeypatch):
    monkeypatch.setattr(EmbeddingService, "embed_query", AsyncMock(return_value=VEC))
    sb = _db(search_individuals_hybrid=[_hybrid(ANN)], match_interactions=[])
    with patched(sb):
        [ann] = run(retrieval.search_people("Ann Lee"))
    assert set(ann) == SUMMARY_KEYS | {"match", "matched_visit"}
    assert (ann["match"], ann["urgency"], ann["urgency_overridden"]) == ("exact", 80, True)
    assert "HIV status" not in ann["facts"] and ann["facts"]["Housing Priority"] == "High"
    assert ann["last_seen"] == NEWEST_INTERACTION["created_at"]
    assert ann["last_seen_area"] == "Mission"            # the newest visit's location
    assert ann["matched_visit"] is None
    assert sb.rpc_params("search_individuals_hybrid") == [{"p_query": "Ann Lee", "p_query_embedding": VEC,
                                                           "p_limit": 5, "p_min_similarity": 0.15}]


@pytest.mark.real_query_embedding
def test_search_people_under_three_characters_is_text_only(patched, monkeypatch):
    monkeypatch.setattr(EmbeddingService, "generate_embeddings", AsyncMock())
    sb = _db(search_individuals_hybrid=[])
    with patched(sb):
        assert run(retrieval.search_people("Al")) == []
    assert sb.rpc_params("search_individuals_hybrid")[0]["p_query_embedding"] is None
    assert sb.rpc_params("match_interactions") == []


def test_search_people_embedding_outage_still_answers(patched, caplog):          # Review Focus 2
    sb = _db(search_individuals_hybrid=[_hybrid(ANN)])                         # conftest: embed_query raises
    with patched(sb):
        rows = run(retrieval.search_people("Ann Lee"))
    assert [r["name"] for r in rows] == ["Ann Lee"]
    assert "RuntimeError" in caplog.text and "Ann" not in caplog.text


def test_search_people_appends_people_found_only_through_a_visit(patched, monkeypatch):
    monkeypatch.setattr(EmbeddingService, "embed_query", AsyncMock(return_value=VEC))
    cy = {**ANN, "id": CID, "name": "Cy Moss", "urgency_override": None, "data": {"name": "Cy Moss"}}
    visit = {"interaction_id": "00000000-0000-0000-0000-0000000000e1", "individual_id": CID, "created_at": T1,
             "transcription": "z" * 400, "location": None, "similarity": 0.5}
    weak = {**visit, "interaction_id": "00000000-0000-0000-0000-0000000000e2", "similarity": 0.1}
    sb = _db(search_individuals_hybrid=[_hybrid(ANN)], match_interactions=[visit, weak])
    sb.on("individuals", "select", data=[cy])
    with patched(sb):
        rows = run(retrieval.search_people("lost his id"))
    assert [r["name"] for r in rows] == ["Ann Lee", "Cy Moss"]
    assert rows[-1]["match"] == "visit" and len(rows[-1]["matched_visit"]["excerpt"]) == 200
    assert rows[-1]["matched_visit"]["date"] == T1
    assert sb.calls_to("individuals", "select")[0].mod("in_") == (("id", [CID]), {})


def _person(n: int) -> dict:
    return {**ANN, "id": f"00000000-0000-0000-0000-0000000001{n:02d}", "name": f"Person {n}",
            "urgency_override": None, "data": {"name": f"Person {n}"}}


def _visit_for(person: dict, similarity: float) -> dict:
    return {"interaction_id": person["id"].replace("01", "0e", 1), "individual_id": person["id"],
            "created_at": T1, "transcription": "dog bite", "location": None, "similarity": similarity}


@pytest.mark.parametrize("hybrid_count,visit_count,limit,expected", [
    (5, 1, 5, ["Person 0", "Person 1", "Person 2", "Person 3", "Person 50"]),       # review I-2
    (5, 3, 5, ["Person 0", "Person 1", "Person 2", "Person 50", "Person 51"]),      # at most limit // 2 visits
    (2, 1, 5, ["Person 0", "Person 1", "Person 50"]),                               # room for all
    (1, 1, 1, ["Person 0"]),                                                        # limit 1: no reserve
])
def test_search_people_keeps_room_for_people_found_only_through_a_visit(
        patched, monkeypatch, hybrid_count, visit_count, limit, expected):
    monkeypatch.setattr(EmbeddingService, "embed_query", AsyncMock(return_value=VEC))
    hybrid = [_person(n) for n in range(hybrid_count)]
    visit_people = [_person(50 + n) for n in range(visit_count)]
    visits = [_visit_for(p, 0.6 - 0.01 * n) for n, p in enumerate(visit_people)]
    sb = _db(search_individuals_hybrid=[_hybrid(p, "semantic", 0.3) for p in hybrid], match_interactions=visits)
    sb.on("individuals", "select", data=visit_people)
    with patched(sb):
        rows = run(retrieval.search_people("who mentioned a dog bite", limit=limit))
    assert [r["name"] for r in rows] == expected
    assert all(r["match"] == "visit" for r in rows if r["name"].startswith("Person 5"))


def test_search_people_clamps_the_limit_and_ignores_blank_queries(patched):
    sb = _db(search_individuals_hybrid=[])
    with patched(sb):
        run(retrieval.search_people("Ann Lee", limit=100))
    assert sb.rpc_params("search_individuals_hybrid")[0]["p_limit"] == 20
    sb = _db()
    with patched(sb):
        assert run(retrieval.search_people("   ")) == []
    assert sb.calls == []


def _person_db(person=ANN, visits=(NEWEST_INTERACTION, OLDER_INTERACTION)):
    return (FakeSupabase().on("categories", "select", data=CATEGORIES)
            .on("individuals", "select", data=[person] if person else [])
            .on("interactions", "select", data=list(visits)))


def test_get_person_has_every_field_sensitive_included_and_five_visits(patched):
    sb = _person_db()
    with patched(sb):
        p = run(retrieval.get_person(PID))
    assert p["fields"]["HIV status"] == "Negative" and p["sensitive_fields"] == ["HIV status"]
    assert p["fields"]["Aka"] == "Annie" and "Name" not in p["fields"]
    assert (p["first_seen"], p["last_seen"], p["last_seen_area"]) == (T0, T2, "Mission")
    assert len(p["recent_interactions"]) <= 5
    assert sb.calls_to("interactions", "select")[0].mod("limit") == ((5,), {})
    v = p["recent_interactions"][0]
    assert set(v) == {"id", "date", "area", "worker", "transcript", "changed_fields"}
    assert len(v["transcript"]) == 500 and "Behavior (removed)" in v["changed_fields"]
    assert v["changed_fields"] == ["Housing Priority", "Behavior (removed)"]
    assert p["recent_interactions"][1]["area"] is None


@pytest.mark.parametrize("bad", ["not-a-uuid", "", "1; drop table individuals"])
def test_get_person_malformed_id_is_none_without_a_query(patched, bad):
    sb = _person_db()
    with patched(sb):
        assert run(retrieval.get_person(bad)) is None
        assert run(retrieval.recent_interactions(bad)) == []
    assert sb.calls == []


def test_get_person_unknown_id_is_none(patched):
    sb = _person_db(person=None)
    with patched(sb):
        assert run(retrieval.get_person(PID)) is None


def test_values_and_labels_are_clipped(patched):
    long_label = {"name": "notes", "display_name": "L" * 300, "type": "text"}
    person = {**ANN, "data": {"name": "Ann Lee", "notes": "v" * 300}}
    sb = (FakeSupabase().on("categories", "select", data=CATEGORIES + [long_label])
          .on("individuals", "select", data=[person]).on("interactions", "select", data=[]))
    with patched(sb):
        p = run(retrieval.get_person(PID))
    assert p["fields"]["L" * 50] == "v" * 100


def test_a_repeated_label_names_its_key(patched):
    twin = {"name": "housing", "display_name": "Housing Priority", "type": "text"}
    person = {**ANN, "data": {"name": "Ann Lee", "housing_priority": "High", "housing": "Shelter"}}
    sb = (FakeSupabase().on("categories", "select", data=CATEGORIES + [twin])
          .on("individuals", "select", data=[person]).on("interactions", "select", data=[]))
    with patched(sb):
        p = run(retrieval.get_person(PID))
    # export order sorts these by key ("housing" first), so the second one names its key
    assert {k: v for k, v in p["fields"].items() if k.startswith("Housing")} == {
        "Housing Priority": "Shelter", "Housing Priority (housing_priority)": "High"}


def test_recent_interactions_newest_first_and_clamped(patched):
    sb = _person_db()
    with patched(sb):
        visits = run(retrieval.recent_interactions(PID, limit=50))
    q = sb.calls_to("interactions", "select")[0]
    assert q.mod("limit") == ((20,), {}) and q.mod("order") == (("created_at",), {"desc": True})
    assert [v["date"] for v in visits] == [T2, T1]


def _urgent_row(**kw):
    return {**{k: ANN[k] for k in ("id", "name", "data", "urgency_score", "urgency_override", "last_location",
                                   "created_at", "updated_at")},
            "display_urgency": 80, "last_seen": T2, "distance_m": 312.6, **kw}


def test_most_urgent_near_an_area_passes_its_centre(patched):
    sb = _db(most_urgent_individuals=[_urgent_row()])
    with patched(sb):
        rows = run(retrieval.most_urgent(near="the Mission"))
    assert sb.rpc_params("most_urgent_individuals")[0] == {"p_lat": 37.7599, "p_lng": -122.4148,
                                                          "p_radius_m": 1200, "p_limit": 5}
    assert isinstance(rows[0]["distance_m"], int) and rows[0]["distance_m"] == 313
    assert set(rows[0]) == SUMMARY_KEYS | {"distance_m"}
    assert (rows[0]["urgency"], rows[0]["last_seen"]) == (80, T2)


def test_most_urgent_without_near_has_no_distance(patched):
    sb = _db(most_urgent_individuals=[_urgent_row(distance_m=None)])
    with patched(sb):
        rows = run(retrieval.most_urgent())
    assert sb.rpc_params("most_urgent_individuals")[0] == {"p_lat": None, "p_lng": None,
                                                          "p_radius_m": None, "p_limit": 5}
    assert rows[0]["distance_m"] is None


def test_most_urgent_unknown_area_raises_before_any_query(patched):
    sb = _db()
    with patched(sb), pytest.raises(retrieval.UnknownAreaError) as exc:
        run(retrieval.most_urgent(near="Atlantis"))
    assert str(exc.value) == "Unknown area" and sb.calls == []


def test_last_seen_falls_back_to_created_at_without_visits(patched):               # Review Focus 4
    lost = {**ANN, "last_location": {"latitude": "37.7", "longitude": None, "address": "Unknown Address"}}
    sb = _person_db(person=lost, visits=())
    with patched(sb):
        p = run(retrieval.get_person(PID))
    assert (p["last_seen"], p["last_seen_area"]) == (T0, None)


def test_an_address_outside_every_neighbourhood_is_abbreviated(patched):
    far = {**ANN, "last_location": {"latitude": 37.0, "longitude": -122.0, "address": "123 Main Street, Elsewhere"}}
    sb = _person_db(person=far, visits=())
    with patched(sb):
        p = run(retrieval.get_person(PID))
    assert p["last_seen_area"] == "Main Street"
