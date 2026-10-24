"""rescore_batch, coarsen_old_locations and purge_old_recordings on real Postgres
(H2-2.9, H2-2.11, H2-7.8)."""
import pytest
from psycopg.types.json import Jsonb

from tests.db.conftest import add_interaction, add_person, add_recording

pytestmark = pytest.mark.db


def rescore(db, rows: list[dict]) -> int:
    return db.execute("SELECT rescore_batch(%s) AS n", [Jsonb(rows)]).fetchone()["n"]


def test_rescore_batch_skips_a_row_saved_since_the_read(db):
    pid = add_person(db, "Ada Test", urgency_score=10)
    assert rescore(db, [{"id": pid, "urgency_score": 40, "version": 0}]) == 0   # stale version
    assert rescore(db, [{"id": pid, "urgency_score": 40, "version": 1}]) == 1
    row = db.execute("SELECT urgency_score, version FROM individuals WHERE id = %s", [pid]).fetchone()
    assert row == {"urgency_score": 40, "version": 1}


def test_coarsen_old_locations_rounds_old_points_once(db):
    pid = add_person(db, "Ada Test")
    point = {"latitude": 37.759912, "longitude": -122.414812, "address": "2100 Mission St"}
    old = add_interaction(db, pid, location=point, age_days=40)
    newest = add_interaction(db, pid, location=point, age_days=35)   # the newest visit keeps its point
    assert db.execute("SELECT coarsen_old_locations(30) AS n").fetchone()["n"] == 1
    locations = {str(r["id"]): r["location"] for r in db.execute("SELECT id, location FROM interactions")}
    assert locations[old] == {"latitude": 37.760, "longitude": -122.415, "address": "Mission St",
                              "coarsened": True}
    assert locations[newest] == point
    assert db.execute("SELECT coarsen_old_locations(30) AS n").fetchone()["n"] == 0


def test_purge_old_recordings_returns_paths(db):
    old = add_recording(db, status="ready", age_minutes=8 * 24 * 60, storage_path="u1/old.m4a")
    fresh = add_recording(db, status="ready", storage_path="u1/fresh.m4a")
    paths = [r["p"] for r in db.execute("SELECT p FROM purge_old_recordings(7) AS p")]
    assert paths == ["u1/old.m4a"]
    remaining = [str(r["id"]) for r in db.execute("SELECT id FROM recordings")]
    assert remaining == [fresh] and old not in remaining
