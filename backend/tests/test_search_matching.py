"""One value-only matcher for every text search (C-01, R-2), ranking tiers, and list sorting.

"veteran", "age", "none" or "al" must not match a person through a dict KEY or
Python's str(dict) repr: only the name and the string values / list items count.
"""
import asyncio
from unittest.mock import MagicMock, patch

import pytest

from services.search_matching import MATCH_TIER, iter_value_strings, match_individual
from services.individual_service import IndividualService, fetch_last_seen
from tests.test_list_individuals import _SB, _person, ID1, ID2


# Keys that used to make every person match: veteran_status, age, housing_priority, ...
KEYS_ONLY = {"veteran_status": "No", "age": 45, "housing_priority": None,
             "medical_conditions": ["Diabetes"], "gender": "Female"}


# --- the matcher -----------------------------------------------------------------------------

def test_iter_value_strings_yields_string_values_and_list_items_never_keys():
    data = {"veteran_status": "No", "age": 45, "notes": None,
            "medical_conditions": ["Diabetes", "Asthma"], "nested": {"inner_key": "Deep"}}
    assert sorted(iter_value_strings(data)) == ["Asthma", "Deep", "Diabetes", "No"]


def test_iter_value_strings_handles_non_dict_data():
    assert list(iter_value_strings(None)) == []
    assert list(iter_value_strings("loose text")) == ["loose text"]


@pytest.mark.parametrize("query", ["veteran", "age", "none", "medical", "housing", "status", "er", "{", "'"])
def test_keys_and_repr_never_match(query):
    assert match_individual(query, {"name": "Bob", "data": KEYS_ONLY}) is None


def test_value_match_is_case_insensitive_substring_including_list_items():
    person = {"name": "Bob", "data": {"notes": "Army VETERAN", "medical_conditions": ["Diabetes"]}}
    assert match_individual("veteran", person) == "value"
    assert match_individual("diab", person) == "value"


# Fix round 1 (R-2 as amended): values match at a word start, names as a substring
@pytest.mark.parametrize("query,value,expected", [
    ("male", "Female", None),
    ("male", "Male", "value"),
    ("diab", "Diabetes", "value"),
    ("market st", "123 Market St, SF", "value"),
    ("vet", "Veteran status: Yes", "value"),
    ("#12", "Unit #12", "value"),
    ("eteran", "Veteran", None),
])
def test_value_matches_start_at_a_word(query, value, expected):
    assert match_individual(query, {"name": "Bob", "data": {"field": value}}) == expected


def test_value_word_start_also_applies_to_list_items():
    person = {"name": "Bob", "data": {"gender_list": ["Female"], "conditions": ["Type 2 diabetes"]}}
    assert match_individual("male", person) is None
    assert match_individual("diab", person) == "value"


def test_name_match_is_still_a_plain_substring():
    assert match_individual("ann", {"name": "Joanne", "data": {}}) == "name"


def test_name_match_wins_over_value_match():
    person = {"name": "Veronica Ash", "data": {"notes": "veronica's dog"}}
    assert match_individual("VERON", person) == "name"


def test_blank_query_matches_nothing():
    assert match_individual("", {"name": "Bob", "data": {}}) is None
    assert match_individual("   ", {"name": "Bob", "data": {}}) is None


def test_missing_name_or_data_is_safe():
    assert match_individual("x", {"name": None, "data": None}) is None


def test_match_tier_order():
    assert MATCH_TIER == {"name": 0, "value": 1, "semantic": 2}


# --- GET /api/individuals (list search) --------------------------------------------------------

def test_list_search_does_not_match_keys():
    sb = _SB([_person(1, data=KEYS_ONLY), _person(2, data=KEYS_ONLY)], [])
    for q in ("veteran", "age", "none"):
        res = asyncio.run(IndividualService(sb).search_individuals(search=q))
        assert res.total == 0, q


def test_list_search_ranks_name_matches_before_value_matches():
    # Person 2 is seen more recently, but only matches through a value
    people = [_person(1, name="Vera Cruz"), _person(2, name="Bob", data={"notes": "vera's friend"}),
              _person(3, name="Zed")]
    sb = _SB(people, [{"individual_id": ID2, "created_at": "2026-09-01T00:00:00+00:00", "location": None}])
    res = asyncio.run(IndividualService(sb).search_individuals(search="vera"))
    assert [r.name for r in res.individuals] == ["Vera Cruz", "Bob"]
    assert res.total == 2


def test_list_search_treats_like_wildcards_literally():
    people = [_person(1, name="Person One"), _person(2, name="50%_off")]
    sb = _SB(people, [])
    res = asyncio.run(IndividualService(sb).search_individuals(search="50%_"))
    assert [r.name for r in res.individuals] == ["50%_off"]


# --- list sorting (carried from Task 3) --------------------------------------------------------

def test_sort_by_urgency_uses_the_display_score():
    people = [_person(1, name="Raw high", urgency_score=90, urgency_override=5),
              _person(2, name="Override high", urgency_score=10, urgency_override=80),
              _person(3, name="Plain", urgency_score=50)]
    sb = _SB(people, [])
    res = asyncio.run(IndividualService(sb).search_individuals(sort_by="urgency_score", sort_order="desc"))
    assert [r.name for r in res.individuals] == ["Override high", "Plain", "Raw high"]


def test_sort_by_last_seen_compares_datetimes_not_strings():
    # As strings "...T10:00:00Z" > "...T10:00:00.500000+00:00" > "...T09:30:00-02:00",
    # but in time the -02:00 one is the latest (11:30 UTC) and Z is the earliest.
    people = [_person(1, name="Zulu"), _person(2, name="Micro"), _person(3, name="Offset")]
    sb = _SB(people, [
        {"individual_id": ID1, "created_at": "2026-08-01T10:00:00Z", "location": None},
        {"individual_id": ID2, "created_at": "2026-08-01T10:00:00.500000+00:00", "location": None},
        {"individual_id": "00000000-0000-0000-0000-000000000003", "created_at": "2026-08-01T09:30:00-02:00",
         "location": None},
    ])
    res = asyncio.run(IndividualService(sb).search_individuals())
    assert [r.name for r in res.individuals] == ["Offset", "Micro", "Zulu"]


def test_fetch_last_seen_chunks_ids():
    from services import individual_service as svc
    ids = [f"id-{i}" for i in range(svc.LAST_SEEN_CHUNK * 2 + 5)]
    sb = _SB([], [{"individual_id": i, "created_at": "2026-08-01T00:00:00+00:00", "location": None} for i in ids])
    out = fetch_last_seen(sb, ids)
    in_sizes = [len(f[2]) for t, fs in sb.queries if t == "interactions" for f in fs if f[0] == "in"]
    assert in_sizes == [svc.LAST_SEEN_CHUNK, svc.LAST_SEEN_CHUNK, 5]
    assert set(out) == set(ids)


# --- POST /api/embeddings/search (hybrid) ------------------------------------------------------

def _post_search(sb, query, semantic=()):
    from fastapi.testclient import TestClient
    from main import app

    async def fake_semantic(*a, **k):
        return list(semantic)

    with patch("api.embeddings.get_supabase_client", return_value=sb), \
         patch("api.embeddings.embedding_service") as emb:
        emb.semantic_search = MagicMock(side_effect=fake_semantic)
        r = TestClient(app, raise_server_exceptions=False).post("/api/embeddings/search", json={"query": query})
    assert r.status_code == 200, r.text
    return r.json()["results"]


def test_embeddings_search_does_not_return_everyone_for_a_key_word():
    sb = _SB([_person(1, data=KEYS_ONLY), _person(2, data=KEYS_ONLY)], [])
    for q in ("veteran", "age", "none"):
        assert _post_search(sb, q) == [], q


def test_embeddings_search_tiers_name_then_value_then_semantic():
    id3 = "00000000-0000-0000-0000-000000000003"
    people = [_person(1, name="Bob", data={"notes": "army veteran"}),
              _person(2, name="Veteran Joe"),
              _person(3, name="Carl")]
    # Carl is a strong semantic hit (0.97 > 0.9), yet must rank below the value match
    embeddings_rows = [{"individual_id": id3, "embedding_data": [0.1], "individuals": people[2]}]

    class _SBWithEmbeddings(_SB):
        def table(self, name):
            if name == "individual_embeddings":
                q = MagicMock()
                q.select.return_value.execute.return_value = MagicMock(data=embeddings_rows)
                return q
            return super().table(name)

    sb = _SBWithEmbeddings(people, [])
    results = _post_search(sb, "veteran", semantic=[{"individual_id": id3, "similarity_score": 0.97}])
    assert [(r["name"], r["search_type"], r["similarity_score"]) for r in results] == [
        ("Veteran Joe", "exact", 1.0),
        ("Bob", "value", 0.9),
        ("Carl", "semantic", 0.97),
    ]


# --- duplicate detection step 3 ----------------------------------------------------------------

def test_dedup_step3_does_not_take_candidates_through_keys():
    from services.duplicate_detection_service import DuplicateDetectionService
    people = [_person(1, name="Bob", data={"alcohol_use": "No", "medical": "None"}),
              _person(2, name="Zed", data={"aka": "Al Smith"})]
    sb = _SB(people, [])
    found = asyncio.run(DuplicateDetectionService(sb, MagicMock())._find_candidates("Al"))
    assert [c["name"] for c in found] == ["Zed"]


def test_dedup_step3_still_finds_a_name_variation_in_a_value():
    from services.duplicate_detection_service import DuplicateDetectionService
    people = [_person(1, name="Zed", data={"aka": "Al Smith"}),
              _person(2, name="Yan", data={"aka": "Hal Jones"})]  # "Al" inside "Hal" is not a word start
    sb = _SB(people, [])
    found = asyncio.run(DuplicateDetectionService(sb, MagicMock())._find_candidates("Al"))
    assert [c["name"] for c in found] == ["Zed"]


def test_person_found_by_text_and_semantic_appears_once_as_text():
    id1 = ID1
    people = [_person(1, name="Bob", data={"notes": "army veteran"}), _person(2, name="Carl")]
    embeddings_rows = [{"individual_id": id1, "embedding_data": [0.1], "individuals": people[0]}]

    class _SBWithEmbeddings(_SB):
        def table(self, name):
            if name == "individual_embeddings":
                q = MagicMock()
                q.select.return_value.execute.return_value = MagicMock(data=embeddings_rows)
                return q
            return super().table(name)

    sb = _SBWithEmbeddings(people, [])
    results = _post_search(sb, "veteran", semantic=[{"individual_id": id1, "similarity_score": 0.99}])
    assert [(r["id"], r["search_type"], r["similarity_score"]) for r in results] == [(id1, "value", 0.9)]
