"""save_individual on real Postgres (H2-2.2, H2-2.3, H2-2.4, H2-2.6)."""
from uuid import uuid4

import psycopg
import pytest
from psycopg.types.json import Jsonb

from tests.db.conftest import count

pytestmark = pytest.mark.db

ADA = {"name": "Ada Test", "height": 64, "weight": 120}


def interaction(**overrides) -> dict:
    return {"user_id": "u1", "user_name": "Worker", "transcription": "Met Ada", "audio_url": None,
            "location": {"latitude": 37.76, "longitude": -122.41}, "changes": ADA, **overrides}


def save(db, pid, name, data, score, inter, expected_version, key):
    return db.execute(
        "SELECT save_individual(%s, %s, %s, %s, %s, %s, %s) AS out",
        [pid, name, Jsonb(data), score, Jsonb(inter), expected_version, key],
    ).fetchone()["out"]


def test_new_person_and_first_interaction_are_written_together(db):
    out = save(db, None, "Ada Test", ADA, 10, interaction(), None, uuid4())
    assert out["individual"]["version"] == 1 and out["replayed"] is False
    assert out["interaction"]["individual_id"] == out["individual"]["id"]
    assert count(db, "individuals") == 1 and count(db, "interactions") == 1


def test_merge_with_current_version_bumps_version(db):
    pid = save(db, None, "Ada Test", ADA, 10, interaction(), None, uuid4())["individual"]["id"]
    out = save(db, pid, "Ada Test", {**ADA, "age": 40}, 20, interaction(changes={"age": 40}), 1, uuid4())
    assert out["individual"]["version"] == 2 and out["individual"]["data"]["age"] == 40
    assert count(db, "interactions") == 2


def test_stale_version_raises_P0409_and_writes_nothing(db):
    pid = save(db, None, "Ada Test", ADA, 10, interaction(), None, uuid4())["individual"]["id"]
    with pytest.raises(psycopg.Error) as e:
        save(db, pid, "Ada Test", ADA, 10, interaction(), 0, uuid4())   # stale expected version
    assert e.value.sqlstate == "P0409"
    assert count(db, "interactions") == 1


def test_missing_merge_target_raises_P0002(db):
    with pytest.raises(psycopg.Error) as e:
        save(db, uuid4(), "Ada Test", ADA, 10, interaction(), 1, uuid4())
    assert e.value.sqlstate == "P0002"
    assert count(db, "individuals") == 0 and count(db, "interactions") == 0


def test_repeated_client_request_id_returns_the_first_result(db):
    key = uuid4()
    first = save(db, None, "Ada Test", ADA, 10, interaction(), None, key)
    second = save(db, None, "Ada Test", ADA, 10, interaction(), None, key)
    assert second["replayed"] is True
    assert second["individual"]["id"] == first["individual"]["id"]
    assert second["interaction"]["id"] == first["interaction"]["id"]
    assert count(db, "individuals") == 1 and count(db, "interactions") == 1


def test_interactions_refuse_update(db):
    save(db, None, "Ada Test", ADA, 10, interaction(), None, uuid4())
    with pytest.raises(psycopg.Error) as e:
        db.execute("UPDATE interactions SET user_name = 'x'")
    assert "interactions are append-only" in str(e.value)
