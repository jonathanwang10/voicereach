"""match_interactions and most_urgent_individuals on real Postgres (H2-4.3, H2-4.7)."""
import pytest

from tests.db.conftest import add_interaction, add_person, as_halfvec, vec

pytestmark = pytest.mark.db

MISSION = (37.7599, -122.4148)


def test_match_interactions_orders_by_cosine_and_filters_by_person(db):
    ada = add_person(db, "Ada Test")
    bo = add_person(db, "Bo Test")
    near = add_interaction(db, ada, transcription="near", embedding=vec(1))
    far = add_interaction(db, ada, transcription="far", embedding=vec(2))
    other = add_interaction(db, bo, transcription="other", embedding=[x + 0.01 for x in vec(1)])
    rows = db.execute("SELECT * FROM match_interactions(%s::halfvec(3072), NULL, 5)",
                      [as_halfvec(vec(1))]).fetchall()
    assert [str(r["interaction_id"]) for r in rows][:2] in ([near, other], [other, near])
    assert str(rows[-1]["interaction_id"]) == far
    assert rows[0]["similarity"] >= rows[-1]["similarity"]
    mine = db.execute("SELECT * FROM match_interactions(%s::halfvec(3072), %s, 5)",
                      [as_halfvec(vec(1)), ada]).fetchall()
    assert [str(r["interaction_id"]) for r in mine] == [near, far]
    assert mine[0]["transcription"] == "near"


def test_most_urgent_radius_and_override_of_zero(db):
    lat, lng = MISSION
    inside = add_person(db, "Inside", urgency_score=50,
                        last_location={"latitude": lat + 0.005, "longitude": lng})    # ~560 m
    add_person(db, "Outside", urgency_score=90, last_location={"latitude": lat + 0.05, "longitude": lng})
    add_person(db, "Bad Latitude", urgency_score=95, last_location={"latitude": "north", "longitude": lng})
    zero = add_person(db, "Override Zero", urgency_score=99, urgency_override=0,
                      last_location={"latitude": lat, "longitude": lng})
    rows = db.execute("SELECT * FROM most_urgent_individuals(%s, %s, %s, 5)", [lat, lng, 1200]).fetchall()
    assert [str(r["id"]) for r in rows] == [inside, zero]
    assert rows[1]["display_urgency"] == 0
    assert 400 < rows[0]["distance_m"] < 700


def test_most_urgent_without_a_point_ranks_everyone(db):
    add_person(db, "Low", urgency_score=10)
    add_person(db, "High", urgency_score=80)
    add_person(db, "Pinned", urgency_score=5, urgency_override=90)
    rows = db.execute("SELECT * FROM most_urgent_individuals()").fetchall()
    assert [r["name"] for r in rows] == ["Pinned", "High", "Low"]
    assert all(r["distance_m"] is None for r in rows)
