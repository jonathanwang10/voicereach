"""claim_recording_job on real Postgres (H2-7.3): SETOF, attempts, staleness, SKIP LOCKED."""
import psycopg
import pytest
from psycopg.rows import dict_row

from tests.db.conftest import DB_URL, add_recording

pytestmark = pytest.mark.db

CLAIM = "SELECT * FROM claim_recording_job()"


def test_claims_a_queued_job_and_counts_the_attempt(db):
    job = add_recording(db)
    row = db.execute(CLAIM).fetchone()
    assert str(row["id"]) == job and row["attempts"] == 1 and row["status"] == "transcribing"


def test_no_job_is_no_row(db):
    assert db.execute(CLAIM).fetchone() is None


def test_skips_jobs_that_used_their_attempts(db):
    add_recording(db, attempts=3, age_minutes=10)
    assert db.execute(CLAIM).fetchone() is None


def test_backoff_waits_attempts_times_30_seconds(db):
    add_recording(db, attempts=2)                  # retried just now: waits 60 s
    assert db.execute(CLAIM).fetchone() is None
    job = add_recording(db, attempts=2, age_minutes=2)
    assert str(db.execute(CLAIM).fetchone()["id"]) == job


def test_reclaims_stale_in_progress_but_not_fresh(db):
    add_recording(db, status="transcribing", attempts=1, age_minutes=1)
    stale = add_recording(db, status="transcribing", attempts=1, age_minutes=6)
    row = db.execute(CLAIM).fetchone()
    assert str(row["id"]) == stale and row["attempts"] == 2
    assert db.execute(CLAIM).fetchone() is None


def test_stuck_on_its_last_attempt_is_failed(db):
    job = add_recording(db, status="extracting", attempts=3, age_minutes=6)
    assert db.execute(CLAIM).fetchone() is None
    row = db.execute("SELECT status, error FROM recordings WHERE id = %s", [job]).fetchone()
    assert row == {"status": "failed", "error": "Processing failed. Please record again."}


def test_concurrent_claims_never_share_a_job(db):
    a, b = add_recording(db, age_minutes=2), add_recording(db, age_minutes=1)
    with psycopg.connect(DB_URL, row_factory=dict_row) as c1, psycopg.connect(DB_URL, row_factory=dict_row) as c2:
        first = c1.execute(CLAIM).fetchone()      # c1's transaction stays open, holding the row lock
        c2.execute("SET statement_timeout = '2s'")
        second = c2.execute(CLAIM).fetchone()
        assert {str(first["id"]), str(second["id"])} == {a, b}
