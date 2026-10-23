"""IndividualService pieces the route tests (test_individuals_routes.py) don't reach:
change detection, address abbreviation, the merge race, and search paging."""
import pytest

from services.individual_service import IndividualNotFound, IndividualService
from tests.helpers import FakeListDB, FakeSupabase, person


@pytest.fixture
def service():
    return IndividualService(FakeSupabase())  # nothing scripted: any query fails the test


def test_get_changed_fields_keeps_changed_and_new_fields_only(service):
    old = {"name": "John Doe", "height": 72, "weight": 180, "gender": "Male"}
    new = {"name": "John Doe", "height": 73, "weight": 180, "gender": "Female", "veteran_status": "Yes"}
    assert service.get_changed_fields(old, new) == {"height": 73, "gender": "Female", "veteran_status": "Yes"}


def test_get_changed_fields_never_records_empty_new_values(service):
    old = {"name": "Ann", "notes": "x", "conditions": ["Diabetes"]}
    new = {"name": "Ann", "notes": "  ", "conditions": [], "age": None, "gender": ""}
    assert service.get_changed_fields(old, new) == {}


@pytest.mark.parametrize("address,expected", [
    ("Market Street & 5th Street, San Francisco, CA", "Market & 5th"),
    ("123 Golden Gate Avenue, San Francisco, CA 94102", "Golden Gate Avenue"),
    ("Golden Gate Park, San Francisco", "Golden Gate Park"),
    ("", ""),
    (None, ""),
])
def test_abbreviate_address(service, address, expected):
    assert service.abbreviate_address(address) == expected


def test_abbreviate_address_truncates_long_text(service):
    result = service.abbreviate_address("This is a very long address that exceeds the thirty character limit")
    assert result == "This is a very long address th..."


async def test_merge_target_deleted_after_the_route_check_raises_not_found_and_writes_nothing():
    """The route checks the target exists, then the service reads it again. If it was
    deleted in between, maybe_single() gives None: IndividualNotFound (404), not a PostgREST 500."""
    sb = FakeSupabase().on("categories", "select", data=[]).on("individuals", "select", data=[])
    with pytest.raises(IndividualNotFound, match="Individual not found"):
        await IndividualService(sb).save_individual(
            user_id="u", user_name="Demo User", data={"name": "Ann", "height": 70, "weight": 150},
            merge_with_id="550e8400-e29b-41d4-a716-446655440001")
    assert [c.verb for c in sb.calls] == ["select", "select"]


async def test_new_person_whose_values_fail_normalisation_raises_before_any_write():
    sb = FakeSupabase().on("categories", "select", data=[
        {"name": "height", "type": "number", "is_required": True, "urgency_weight": 0}])
    with pytest.raises(ValueError, match="height"):
        await IndividualService(sb).save_individual(
            user_id="u", user_name="Demo User", data={"name": "Ann", "height": 400, "weight": 150})
    assert [c.table for c in sb.calls] == ["categories"]


async def test_search_matches_names_and_values_not_keys():
    sb = FakeListDB([person(1, name="John Smith"), person(2, name="Ann Lee", data={"john_key": "x"}),
                     person(3, name="Bo", data={"notes": "friend of john"})], [])
    results = await IndividualService(sb).search_individuals(search="John", limit=10)
    assert [r.name for r in results.individuals] == ["John Smith", "Bo"]  # name tier first
    assert results.total == 2


async def test_search_pages_after_sorting_and_counts_every_match():
    sb = FakeListDB([person(i, urgency_score=i * 10) for i in range(1, 8)], [])
    results = await IndividualService(sb).search_individuals(
        limit=3, offset=3, sort_by="urgency_score", sort_order="desc")
    assert (results.total, results.limit, results.offset) == (7, 3, 3)
    assert [r.urgency_score for r in results.individuals] == [40, 30, 20]


async def test_search_offset_past_the_end_is_an_empty_page_with_the_real_total():
    sb = FakeListDB([person(1), person(2)], [])
    results = await IndividualService(sb).search_individuals(offset=20)
    assert results.individuals == [] and results.total == 2
