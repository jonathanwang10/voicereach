"""find_similar_individuals on real Postgres (H2-9.1): the duplicate check's meaning leg."""
import pytest

from tests.db.conftest import add_person, as_halfvec, vec

pytestmark = pytest.mark.db


def similar(db, embedding, limit: int = 5, floor: float = 0.6) -> list[dict]:
    return db.execute("SELECT name, similarity FROM find_similar_individuals(%s::halfvec(3072), %s, %s)",
                      [as_halfvec(embedding) if embedding is not None else None, limit, floor]).fetchall()


def _blend(a: list[float], b: list[float], weight: float) -> list[float]:
    return [weight * x + (1 - weight) * y for x, y in zip(a, b)]


def test_the_nearest_people_come_back_closest_first(db):
    base = vec(1)
    add_person(db, "Big Red", embedding=_blend(base, vec(2), 0.9))
    add_person(db, "Mike", embedding=base)
    rows = similar(db, base)
    assert [r["name"] for r in rows] == ["Mike", "Big Red"]
    assert rows[0]["similarity"] > rows[1]["similarity"] >= 0.6


def test_people_below_the_floor_are_left_out(db):
    add_person(db, "Unrelated", embedding=vec(3))
    add_person(db, "No vector")
    assert similar(db, vec(1)) == []


def test_a_null_embedding_finds_nobody(db):
    add_person(db, "Mike", embedding=vec(1))
    assert similar(db, None) == []


def test_the_limit_is_clamped(db):
    base = vec(1)
    for i in range(25):
        add_person(db, f"Person {i}", embedding=_blend(base, vec(100 + i), 0.95))
    assert len(similar(db, base, limit=3)) == 3
    assert len(similar(db, base, limit=500)) == 20
    assert len(similar(db, base, limit=0)) == 1
