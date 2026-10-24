"""tests/db/ calls the real SQL functions on a local Postgres with the schema applied
(H2-8.4). Everything here is skipped unless SUPABASE_DB_URL is set; README Testing
has the commands (a local Supabase in Docker, schema.sql, then the migrations twice).
Never point it at the hosted database: the `db` fixture truncates the tables."""
import os
import random
from pathlib import Path
from typing import Optional
from uuid import uuid4

import pytest

HERE = Path(__file__).resolve().parent
DB_URL = os.getenv("SUPABASE_DB_URL", "")


def pytest_collection_modifyitems(config, items):
    if DB_URL:
        return
    skip = pytest.mark.skip(reason="db tests: set SUPABASE_DB_URL (see README Testing)")
    for item in items:
        # this hook runs for the whole session, so only touch our own directory
        if HERE in Path(str(item.fspath)).resolve().parents:
            item.add_marker(skip)


@pytest.fixture
def db():
    import psycopg
    from psycopg.rows import dict_row
    with psycopg.connect(DB_URL, autocommit=True, row_factory=dict_row) as conn:
        conn.execute("TRUNCATE individuals, recordings RESTART IDENTITY CASCADE")
        yield conn


def vec(seed: int) -> list[float]:
    """3072 deterministic floats: two different seeds are close to orthogonal."""
    rng = random.Random(seed)
    return [rng.uniform(-1, 1) for _ in range(3072)]


def as_halfvec(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.4f}" for x in v) + "]"


def add_person(db, name: str, data: Optional[dict] = None, embedding: Optional[list[float]] = None, *,
               last_location: Optional[dict] = None, urgency_score: int = 0,
               urgency_override: Optional[int] = None) -> str:
    from psycopg.types.json import Jsonb
    row = db.execute(
        "INSERT INTO individuals (name, data, last_location, urgency_score, urgency_override)"
        " VALUES (%s, %s, %s, %s, %s) RETURNING id",
        [name, Jsonb(data if data is not None else {"name": name}),
         Jsonb(last_location) if last_location is not None else None, urgency_score, urgency_override],
    ).fetchone()
    if embedding is not None:
        db.execute(
            "INSERT INTO individual_embeddings (individual_id, embedding, embedding_text, model, text_hash,"
            " source_updated_at) VALUES (%s, %s::halfvec(3072), %s, 'test-model', 'hash', now())",
            [row["id"], as_halfvec(embedding), name],
        )
    return str(row["id"])


def add_interaction(db, individual_id: str, *, location: Optional[dict] = None, age_days: float = 0,
                    transcription: str = "visit", embedding: Optional[list[float]] = None) -> str:
    """Inserted with a backdated created_at: the append-only trigger guards UPDATE only."""
    from psycopg.types.json import Jsonb
    row = db.execute(
        "INSERT INTO interactions (individual_id, user_id, transcription, location, created_at)"
        " VALUES (%s, 'u1', %s, %s, now() - make_interval(secs => %s)) RETURNING id",
        [individual_id, transcription, Jsonb(location) if location is not None else None, age_days * 86400],
    ).fetchone()
    if embedding is not None:
        db.execute(
            "INSERT INTO interaction_embeddings (interaction_id, individual_id, embedding, model, text_hash)"
            " VALUES (%s, %s, %s::halfvec(3072), 'test-model', 'hash')",
            [row["id"], individual_id, as_halfvec(embedding)],
        )
    return str(row["id"])


def add_recording(db, status: str = "queued", attempts: int = 0, age_minutes: int = 0,
                  storage_path: Optional[str] = None) -> str:
    """created_at and updated_at both `age_minutes` old. set_updated_at fires on UPDATE
    only, so the backdated values set at INSERT stay (Deviation 8)."""
    row = db.execute(
        "INSERT INTO recordings (user_id, client_recording_id, status, attempts, storage_path,"
        " created_at, updated_at) VALUES ('u1', %s, %s, %s, %s,"
        " now() - make_interval(mins => %s), now() - make_interval(mins => %s)) RETURNING id",
        [uuid4(), status, attempts, storage_path, age_minutes, age_minutes],
    ).fetchone()
    return str(row["id"])


def count(db, table: str) -> int:
    return db.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"]
