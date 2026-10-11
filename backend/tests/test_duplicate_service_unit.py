"""
Duplicate detection: candidate retrieval, LLM comparison and its fallback.

C-22: candidates come from an OR of ILIKEs per name token (3+ characters), are
      pre-ranked by tokens matched plus height/weight closeness, and the top 8
      go to the LLM.
C-08: an empty, None, nested or failed LLM reply falls back to name matching;
      a database failure raises (the routes report it) instead of "no match".
C-42: the prompt no longer asks the LLM to compare skin colour.
"""
import uuid
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest
from fastapi.testclient import TestClient

from tests.helpers import FakePeopleDB


def _id():
    return str(uuid.uuid4())


def _person(name, data=None, id_=None):
    return {"id": id_ or _id(), "name": name, "data": data or {}}


def _service(people, reply=None, fail=False):
    from services.duplicate_detection_service import DuplicateDetectionService
    openai = Mock()
    openai.compare_individuals = AsyncMock(return_value=reply if reply is not None else {})
    sb = FakePeopleDB(people, fail=fail)
    return DuplicateDetectionService(sb, openai), openai, sb


def _prompt(openai):
    return openai.compare_individuals.await_args.args[0]


# --- scoring the LLM reply -----------------------------------------------------------------------

async def test_exact_name_match_high_confidence():
    john = _person("John Doe", {"height": 72, "weight": 180})
    svc, _, _ = _service([john], reply={john["id"]: 96})
    matches = await svc.find_duplicates({"name": "John Doe", "height": 72, "weight": 180})
    assert matches == [{"id": john["id"], "name": "John Doe", "confidence": 96}]


async def test_spelling_variant_found_through_a_shared_token():
    smith = _person("John Smith")
    svc, _, _ = _service([smith], reply={smith["id"]: 82})
    matches = await svc.find_duplicates({"name": "Jon Smith", "height": 70})
    assert [m["id"] for m in matches] == [smith["id"]]
    assert 70 <= matches[0]["confidence"] < 95


async def test_no_candidates_returns_empty_without_calling_the_llm():
    svc, openai, _ = _service([_person("Sarah Lee")])
    assert await svc.find_duplicates({"name": "Unique Person"}) == []
    openai.compare_individuals.assert_not_awaited()


async def test_multiple_candidates_returns_highest_confidence():
    a, b, c = _person("John Doe"), _person("John Smith"), _person("Johnny Brown")
    svc, _, _ = _service([a, b, c], reply={a["id"]: 95, b["id"]: 75, c["id"]: 65})
    matches = await svc.find_duplicates({"name": "John", "height": 72})
    assert matches == [{"id": a["id"], "name": "John Doe", "confidence": 95}]


async def test_low_confidence_matches_filtered():
    a, b = _person("John Sarah"), _person("John Mike")
    svc, _, _ = _service([a, b], reply={a["id"]: 45, b["id"]: 30})
    assert await svc.find_duplicates({"name": "John", "height": 60}) == []


@pytest.mark.parametrize("new_data", [{}, {"name": ""}, {"name": "  "}, {"Name": "a"}, {"name": 123}])
async def test_missing_or_short_name_returns_empty(new_data):
    svc, openai, sb = _service([_person("Al")])
    assert await svc.find_duplicates(new_data) == []
    assert sb.queries == []


@pytest.mark.parametrize("variant", ["JOHN DOE", "john doe", "JoHn DoE"])
async def test_case_insensitive_name_matching(variant):
    john = _person("John Doe")
    svc, _, _ = _service([john], reply={john["id"]: 95})
    assert [m["id"] for m in await svc.find_duplicates({"name": variant})] == [john["id"]]


@pytest.mark.parametrize("key", ["name", "Name"])
async def test_handles_both_name_fields(key):
    john = _person("John Doe")
    svc, _, _ = _service([john], reply={john["id"]: 95})
    assert [m["id"] for m in await svc.find_duplicates({key: "John Doe"})] == [john["id"]]


# --- C-22: candidate retrieval and pre-ranking ---------------------------------------------------

async def test_full_name_finds_a_first_visit_recorded_under_one_name():
    # First visit: "John". Second visit: "John Doe". %John Doe% never matched "John".
    john = _person("John", {"height": 72})
    svc, openai, _ = _service([john], reply={john["id"]: 88})
    matches = await svc.find_duplicates({"name": "John Doe", "height": 72})
    assert [m["id"] for m in matches] == [john["id"]]


async def test_name_query_is_one_ilike_per_token_of_three_or_more_characters():
    svc, _, sb = _service([])
    await svc._find_candidates("Jo  O'Neil-Smith Doe")
    or_filters = [f[1] for _, filters in sb.queries for f in filters if f[0] == "or"]
    assert or_filters == ["name.ilike.*neil*,name.ilike.*smith*,name.ilike.*doe*"]


async def test_name_tokens_cannot_inject_postgrest_filters():
    svc, _, sb = _service([])
    await svc._find_candidates("ann%,id.eq.1)*_x")
    or_filters = [f[1] for _, filters in sb.queries for f in filters if f[0] == "or"]
    assert or_filters == ["name.ilike.*ann*"]


async def test_short_names_fall_back_to_two_character_tokens():
    al = _person("Al Green")
    svc, _, sb = _service([al])
    found = await svc._find_candidates("Al")
    assert [c["id"] for c in found] == [al["id"]]


async def test_real_match_beyond_the_third_candidate_still_reaches_the_llm():
    # Five more recently updated "John"s come back first; the real John (same
    # height and weight) is sixth. Only the first 3 used to reach the LLM.
    others = [_person(f"John Other{i}", {"height": 60 + i}) for i in range(5)]
    doe = _person("John Doe", {"height": 72, "weight": 180})
    svc, openai, _ = _service(others + [doe], reply={doe["id"]: 97})
    matches = await svc.find_duplicates({"name": "John", "height": 72, "weight": 180})
    assert [m["id"] for m in matches] == [doe["id"]]
    assert doe["id"] in _prompt(openai)


async def test_pre_ranking_decides_which_candidates_reach_the_llm():
    # Nine more recently updated "John"s; the real John (same height/weight) is
    # tenth, beyond the 8 the LLM sees unless candidates are ranked first.
    others = [_person(f"John Other{i}", {"height": 50 + i, "weight": 100}) for i in range(9)]
    doe = _person("John Doe", {"height": 72, "weight": 180})
    svc, openai, _ = _service(others + [doe], reply={doe["id"]: 93})
    matches = await svc.find_duplicates({"name": "John", "height": 72, "weight": 180})
    assert [m["id"] for m in matches] == [doe["id"]]


async def test_at_most_eight_candidates_go_to_the_llm_best_ranked_first():
    people = [_person(f"John X{i}") for i in range(12)]
    svc, openai, _ = _service(people, reply={})
    await svc.find_duplicates({"name": "John"})
    prompt = _prompt(openai)
    sent = [p["id"] for p in people if p["id"] in prompt]
    assert len(sent) == 8


def test_pre_rank_tokens_matched_first_then_height_weight_closeness():
    from services.duplicate_detection_service import DuplicateDetectionService
    one_token_far = _person("John Far", {"height": 60, "weight": 120})
    one_token_close = _person("John Close", {"height": 71, "weight": 182})
    two_tokens = _person("John Doe", {"height": 50})
    ranked = DuplicateDetectionService._rank_candidates(
        {"name": "John Doe", "height": 72, "weight": 180},
        [one_token_far, one_token_close, two_tokens],
    )
    assert [c["name"] for c in ranked] == ["John Doe", "John Close", "John Far"]


# --- C-08: the LLM failing must not mean "no match" ----------------------------------------------

@pytest.mark.parametrize("reply", [{}, None, "not json"])
async def test_empty_or_none_llm_reply_falls_back_to_name_matching(reply):
    john = _person("John Doe")
    svc, openai, _ = _service([john])
    openai.compare_individuals = AsyncMock(return_value=reply)
    matches = await svc.find_duplicates({"name": "John Doe"})
    assert matches == [{"id": john["id"], "name": "John Doe", "confidence": 80}]


async def test_nested_llm_reply_falls_back_to_name_matching():
    john = _person("John Doe")
    svc, _, _ = _service([john], reply={"scores": {"whatever": 99}})
    matches = await svc.find_duplicates({"name": "John Doe"})
    assert [(m["id"], m["confidence"]) for m in matches] == [(john["id"], 80)]


async def test_llm_exception_falls_back_to_name_matching():
    john = _person("John Doe")
    svc, openai, _ = _service([john])
    openai.compare_individuals = AsyncMock(side_effect=RuntimeError("rate limited"))
    assert [m["id"] for m in await svc.find_duplicates({"name": "John Doe"})] == [john["id"]]


async def test_a_real_all_low_reply_is_respected_not_replaced_by_the_fallback():
    john = _person("John Doe")
    svc, _, _ = _service([john], reply={john["id"]: 10})
    assert await svc.find_duplicates({"name": "John Doe"}) == []


def test_fallback_considers_every_candidate_and_returns_the_best():
    from services.duplicate_detection_service import DuplicateDetectionService
    partial, exact = _person("John Smith"), _person("John Doe")
    svc = DuplicateDetectionService(MagicMock(), MagicMock())
    matches = svc._fallback_simple_matching({"name": "john doe"}, [partial, exact])
    assert matches == [{"id": exact["id"], "name": "John Doe", "confidence": 80}]


def test_fallback_scores_are_capped_at_80_without_llm_corroboration():
    # Name-only evidence never looks like a near-certain (95+) match (fix round 1)
    from services.duplicate_detection_service import DuplicateDetectionService
    svc = DuplicateDetectionService(MagicMock(), MagicMock())
    score = lambda new, cand: (svc._fallback_simple_matching({"name": new}, [_person(cand)]) or [{"confidence": None}])[0]["confidence"]
    assert score("John Doe", "john doe") == 80   # same name
    assert score("John", "John Doe") == 70       # one name's words all in the other
    assert score("John Smith", "John Doe") == 60 # one word in common
    assert score("Ann", "Bob") is None


def test_fallback_does_not_match_a_name_inside_another_word():
    from services.duplicate_detection_service import DuplicateDetectionService
    svc = DuplicateDetectionService(MagicMock(), MagicMock())
    assert svc._fallback_simple_matching({"name": "Al"}, [_person("Hal Jones")]) == []


async def test_database_failure_raises_instead_of_reporting_no_match():
    svc, _, _ = _service([], fail=True)
    with pytest.raises(Exception):
        await svc.find_duplicates({"name": "John Doe"})


# --- C-42: no skin colour in the prompt ----------------------------------------------------------

def test_prompt_does_not_ask_to_compare_skin_colour():
    from services.duplicate_detection_service import DuplicateDetectionService
    svc = DuplicateDetectionService(MagicMock(), MagicMock())
    prompt = svc._build_comparison_prompt({"name": "Ann"}, [_person("Ann B")])
    assert "skin" not in prompt.lower()
    assert "(height, weight)" in prompt


# --- OpenAIService.compare_individuals ------------------------------------------------------------

def _openai_returning(content):
    from services.openai_service import OpenAIService
    svc = OpenAIService.__new__(OpenAIService)
    svc.client = MagicMock()
    completion = MagicMock()
    completion.choices = [MagicMock(message=MagicMock(content=content))]
    svc.client.chat.completions.create = AsyncMock(return_value=completion)
    return svc


async def test_compare_individuals_unwraps_one_nested_dict():
    svc = _openai_returning('{"scores": {"id-1": 91, "id-2": "40"}}')
    assert await svc.compare_individuals("prompt") == {"id-1": 91, "id-2": 40}


async def test_compare_individuals_non_object_json_is_empty():
    svc = _openai_returning("[95, 40]")
    assert await svc.compare_individuals("prompt") == {}


# --- routes: a failed check is reported, never "no match" ----------------------------------------

def _transcribe_with(find_duplicates):
    from main import app
    openai_mock = MagicMock()
    openai_mock.transcribe_audio_file = AsyncMock(return_value="transcript")
    openai_mock.categorize_transcription = AsyncMock(return_value={"name": "Ann", "height": 70, "weight": 150})
    supabase = MagicMock()
    supabase.table.return_value.select.return_value.order.return_value.execute.return_value.data = [
        {"name": "name", "type": "text", "is_required": True, "options": None},
        {"name": "height", "type": "number", "is_required": True, "options": None},
        {"name": "weight", "type": "number", "is_required": True, "options": None},
    ]
    dup = MagicMock()
    dup.return_value.find_duplicates = find_duplicates
    with patch("api.transcription.OpenAIService", return_value=openai_mock), \
         patch("api.transcription.create_client", return_value=supabase), \
         patch("services.duplicate_detection_service.DuplicateDetectionService", dup):
        return TestClient(app).post("/api/transcribe", json={"audio_data": "AAAA"})


def test_transcribe_flags_a_failed_duplicate_check():
    response = _transcribe_with(AsyncMock(side_effect=RuntimeError("db down")))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["potential_matches"] == []
    assert body["duplicate_check_failed"] is True


def test_transcribe_duplicate_check_failed_is_false_when_the_check_ran():
    response = _transcribe_with(AsyncMock(return_value=[]))
    assert response.status_code == 200, response.text
    assert response.json()["duplicate_check_failed"] is False


def test_check_duplicates_database_failure_is_a_500_not_an_empty_list():
    from main import app
    with patch("api.individuals.get_supabase_client", return_value=FakePeopleDB([], fail=True)), \
         patch("services.openai_service.OpenAIService"):
        response = TestClient(app).post("/api/individuals/check-duplicates", json={"name": "Ann Lee"})
    assert response.status_code == 500
    assert response.json() == {"detail": "Duplicate check failed"}


# --- input guards ---------------------------------------------------------------------------

async def test_find_duplicates_non_string_name_returns_empty_without_a_query():
    svc, openai, sb = _service([_person("123")])
    assert await svc.find_duplicates({"name": 123}) == []
    assert sb.queries == []
    openai.compare_individuals.assert_not_called()


def test_name_tokens_carry_no_wildcards_or_filter_syntax():
    from services.duplicate_detection_service import DuplicateDetectionService
    # Candidate search builds its PostgREST filter from letter/digit runs only (C-22)
    assert DuplicateDetectionService._name_tokens("a_b%c*,name.eq.x)") == ["name"]
    assert DuplicateDetectionService._name_tokens("Ann%") == ["ann"]
