"""find_duplicate_candidates on real Postgres (H2-3.5)."""
import pytest

from tests.db.conftest import add_person

pytestmark = pytest.mark.db


def candidates(db, name: str, limit: int = 50) -> list[str]:
    return [r["name"] for r in db.execute("SELECT name FROM find_duplicate_candidates(%s, %s)", [name, limit])]


def test_similar_name_is_found_and_unrelated_is_not(db):
    add_person(db, "Jonathan Smith")
    add_person(db, "Maria Lopez")
    names = candidates(db, "Jonathon Smith")
    assert "Jonathan Smith" in names and "Maria Lopez" not in names


def test_jon_finds_john_and_one_matching_token_is_enough(db):
    add_person(db, "John Smith")
    add_person(db, "Johnny Walker")
    add_person(db, "Maria Lopez")
    assert "John Smith" in candidates(db, "Jon Smith")
    names = candidates(db, "John Doe")
    assert "Johnny Walker" in names and "John Smith" in names and "Maria Lopez" not in names


def test_limit_is_respected(db):
    for i in range(5):
        add_person(db, f"Sam Test{i}")
    assert len(candidates(db, "Sam Test", 3)) == 3


def test_a_value_that_starts_a_word_matches_but_not_mid_word(db):
    # "Al" finds aka "Al Smith" but not aka "Hal Jones" (values, word starts only)
    add_person(db, "Robert Brown", {"name": "Robert Brown", "aka": "Al Smith"})
    add_person(db, "Peter Grey", {"name": "Peter Grey", "aka": "Hal Jones"})
    names = candidates(db, "Al")
    assert "Robert Brown" in names and "Peter Grey" not in names


def test_a_key_is_never_matched(db):
    add_person(db, "Robert Brown", {"name": "Robert Brown", "medical": ["Diabetes"]})
    assert candidates(db, "medical") == []


def test_like_wildcards_in_the_name_are_literal(db):
    add_person(db, "Robert Brown", {"name": "Robert Brown", "aka": "Bobby"})
    assert candidates(db, "%") == []
    assert candidates(db, "_") == []
    assert candidates(db, "B_bby") == []


def test_name_matches_come_before_value_matches(db):
    add_person(db, "Kim Lee", {"name": "Kim Lee", "aka": "Ray Park"})
    add_person(db, "Ray Park")
    assert candidates(db, "Ray Park") == ["Ray Park", "Kim Lee"]
