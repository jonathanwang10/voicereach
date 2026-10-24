"""search_individuals_hybrid on real Postgres (H2-4.2)."""
import pytest

from tests.db.conftest import add_person, as_halfvec, vec

pytestmark = pytest.mark.db

TEXT_ONLY = "SELECT * FROM search_individuals_hybrid(%s, NULL::halfvec(3072), %s)"


def text_search(db, q: str, limit: int = 20) -> list[dict]:
    return db.execute(TEXT_ONLY, [q, limit]).fetchall()


def test_exact_name_match_is_first_even_against_a_closer_vector(db):
    add_person(db, "Maria Lopez", embedding=vec(1))
    add_person(db, "Maria Lopes", embedding=vec(2))
    rows = db.execute("SELECT * FROM search_individuals_hybrid(%s, %s::halfvec(3072), 20)",
                      ["maria lopez", as_halfvec(vec(2))]).fetchall()
    assert rows[0]["name"] == "Maria Lopez" and rows[0]["match_source"] == "exact"
    assert {"score", "match_source", "similarity"} <= rows[0].keys()
    lopes = next(r for r in rows if r["name"] == "Maria Lopes")
    assert lopes["similarity"] == pytest.approx(1.0, abs=0.01)


def test_null_embedding_searches_text_only(db):
    add_person(db, "Maria Lopez", embedding=vec(1))
    add_person(db, "Ana Lopez")
    rows = text_search(db, "Lopez")
    assert {r["name"] for r in rows} == {"Maria Lopez", "Ana Lopez"}
    assert all(r["similarity"] is None for r in rows)


def test_limit_is_respected(db):
    for i in range(5):
        add_person(db, f"Sam Test{i}")
    assert len(text_search(db, "Sam", 3)) == 3


def test_a_key_is_never_matched(db):
    add_person(db, "Robert Brown", {"name": "Robert Brown", "veteran_status": "Yes"})
    assert text_search(db, "veteran") == []


def test_word_prefixes_match_but_not_mid_word(db):
    add_person(db, "Robert Brown", {"name": "Robert Brown", "medical_conditions": ["Diabetes"]})
    add_person(db, "Peter Grey", {"name": "Peter Grey", "gender": "Female"})
    assert [r["name"] for r in text_search(db, "diab")] == ["Robert Brown"]
    assert text_search(db, "male") == []


@pytest.mark.parametrize("q", ["50%_", "a & !b", '"quoted', "O'Brien", "diab:*", "🙂 ann"])
def test_syntax_in_the_query_runs_without_error(db, q):
    add_person(db, "Robert Brown")
    assert text_search(db, q) == []


def test_like_wildcards_match_literally(db):
    add_person(db, "Robert Brown")
    add_person(db, "Deal 50%_ Off")
    assert [r["name"] for r in text_search(db, "50%_")] == ["Deal 50%_ Off"]


def test_apostrophe_name_is_found(db):
    add_person(db, "Sean O'Brien")
    assert [r["name"] for r in text_search(db, "O'Brien")] == ["Sean O'Brien"]


def test_blank_query_returns_no_rows(db):
    add_person(db, "Robert Brown", embedding=vec(1))
    assert text_search(db, "   ") == []
    assert db.execute("SELECT * FROM search_individuals_hybrid('', %s::halfvec(3072))",
                      [as_halfvec(vec(1))]).fetchall() == []
