"""Schema contract (C-48): every table and column the backend reads or writes exists in
supabase/schema.sql. Mocks accept any column name, so without this a code/schema
mismatch (what sank the old migration chain) would only show up against a real database.

Two halves:
- static: every `.table("t")...execute()` chain in the backend source names a real table,
  and its eq/in_/order/ilike/select/on_conflict columns exist on that table;
- dynamic: the write paths run against a strict FakeSupabase, and every key they insert,
  update or upsert exists on the table it was written to.
"""
import asyncio
import re
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app
from tests.helpers import FakeSupabase, save_rpc

ROOT = Path(__file__).resolve().parents[2]
SQL = re.sub(r"--[^\n]*", "", (ROOT / "supabase" / "schema.sql").read_text())
BACKEND_SOURCES = [p for d in ("api", "services", "scripts") for p in (ROOT / "backend" / d).glob("*.py")] \
    + [ROOT / "backend" / "main.py"]
_NOT_COLUMNS = {"PRIMARY", "UNIQUE", "CONSTRAINT", "CHECK", "FOREIGN"}


def _schema() -> dict:
    tables = {}
    for name, body in re.findall(r"CREATE TABLE IF NOT EXISTS (\w+) \((.*?)\n\);", SQL, re.S):
        tables[name] = {m.group(1) for m in re.finditer(r"^\s*(\w+)\s+\w", body, re.M)} - _NOT_COLUMNS
    for name, column in re.findall(r"ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)", SQL):
        tables.setdefault(name, set()).add(column)
    return tables


SCHEMA = _schema()


def test_schema_parser_sees_every_table_and_column():
    assert set(SCHEMA) == {"categories", "individuals", "interactions", "individual_embeddings", "audit_log",
                           "duplicate_decisions"}
    assert SCHEMA["individuals"] == {"id", "name", "data", "urgency_score", "urgency_override", "last_location",
                                     "created_at", "updated_at", "version"}
    assert {"changes", "audio_url", "user_name", "user_id", "location", "client_request_id"} <= SCHEMA["interactions"]


# --- static: query chains in the source ----------------------------------------------------

def _chains():
    for path in BACKEND_SOURCES:
        src = path.read_text()
        # A chain ends at .execute(), or at the `.order("id"))` that closes a fetch_all
        # builder (H2-1.3), and never runs on into the next .table() call.
        for m in re.finditer(r'\.table\("(\w+)"\)((?:(?!\.table\(").)*?)(?:\.execute\(\)|\.order\("id"\)\))',
                             src, re.S):
            yield f"{path.name}:{src[:m.start()].count(chr(10)) + 1}", m.group(1), m.group(2)


CHAINS = list(_chains())


def test_the_source_scan_finds_the_queries():
    assert len(CHAINS) >= 30
    assert {t for _, t, _ in CHAINS} == set(SCHEMA)


@pytest.mark.parametrize("where,table,chain", CHAINS, ids=[w for w, _, _ in CHAINS])
def test_query_names_only_existing_columns(where, table, chain):
    assert table in SCHEMA, f"{where}: no table {table!r} in schema.sql"
    columns = [c for c in re.findall(r'\.(?:eq|neq|in_|order|ilike)\("(\w+)"', chain)]
    columns += re.findall(r'on_conflict="(\w+)"', chain)
    for select in re.findall(r'\.select\("([^"]*)"', chain):
        for part in (p.strip() for p in select.split(",")):
            relation = re.fullmatch(r"(\w+)\(\*\)", part)
            if relation:
                assert relation.group(1) in SCHEMA, f"{where}: no table {relation.group(1)!r}"
            elif part != "*":
                columns.append(part)
    missing = [c for c in columns if c not in SCHEMA[table]]
    assert not missing, f"{where}: {table} has no column(s) {missing}"


# --- dynamic: what the write paths actually send -------------------------------------------

ID = "550e8400-e29b-41d4-a716-446655440001"
CATEGORIES = [
    {"name": "name", "type": "text", "is_required": True, "urgency_weight": 0},
    {"name": "height", "type": "number", "is_required": True, "urgency_weight": 0},
    {"name": "weight", "type": "number", "is_required": True, "urgency_weight": 0},
]
ROW = {"id": ID, "name": "Ann", "urgency_score": 0, "urgency_override": None, "data": {"name": "Ann"},
       "last_location": None, "created_at": "2026-01-01T00:00:00+00:00", "updated_at": "2026-01-01T00:00:00+00:00"}
LOCATION = {"latitude": 37.7, "longitude": -122.4, "address": "Market St"}


def _recording_db():
    sb = FakeSupabase()
    sb.on("categories", "select", data=CATEGORIES)
    sb.on("individuals", "select", data=[ROW])
    sb.on("interactions", "select", data=[])
    for table in ("individuals", "interactions", "categories", "individual_embeddings", "audit_log"):
        for verb in ("insert", "update", "upsert"):
            sb.on(table, verb, data=lambda call: [{**ROW, "id": ID, "user_name": "Demo User", **call.payload}])
    sb.on("individuals", "delete", data=[ROW])
    sb.on_rpc("save_individual", data=save_rpc(ROW))
    return sb


def _written_keys(sb):
    return [(c.table, key) for c in sb.calls if c.verb in ("insert", "update", "upsert") for key in c.payload]


def _assert_known(sb):
    written = _written_keys(sb)
    assert written, "the flow wrote nothing; the contract check would be vacuous"
    unknown = sorted({(t, k) for t, k in written if k not in SCHEMA[t]})
    assert not unknown, f"written columns missing from schema.sql: {unknown}"


def test_individual_writes_use_existing_columns():
    sb = _recording_db()
    client = TestClient(app)
    with patch("api.individuals.get_supabase", return_value=sb):
        body = {"data": {"name": "Ann", "height": 70, "weight": 150}, "location": LOCATION,
                "transcription": "t", "audio_url": "a.m4a"}
        assert client.post("/api/individuals", json=body).status_code == 200
        assert client.post("/api/individuals", json={**body, "merge_with_id": ID}).status_code == 200
        assert client.put(f"/api/individuals/{ID}/urgency-override", json={"urgency_override": 5}).status_code == 200
    # A save is one save_individual call; the only direct table write is the override
    assert {(c.table, c.verb) for c in sb.calls if c.verb != "select"} == {
        ("individuals", "update"), ("save_individual", "rpc"), ("audit_log", "insert")}
    _assert_known(sb)
    for call in sb.calls_to("save_individual", "rpc"):
        assert set(call.payload["p_interaction"]) <= SCHEMA["interactions"]


def _function_params(name: str) -> set:
    m = re.search(rf"CREATE OR REPLACE FUNCTION {name}\((.*?)\)\s*RETURNS", SQL, re.S)
    assert m, f"no function {name} in schema.sql"
    return {part.split()[0] for part in m.group(1).split(",") if part.strip()}


def test_rpc_params_match_the_function_signature():
    sb = _recording_db()
    client = TestClient(app)
    with patch("api.individuals.get_supabase", return_value=sb):
        body = {"data": {"name": "Ann", "height": 70, "weight": 150}, "location": LOCATION}
        assert client.post("/api/individuals", json=body).status_code == 200
        assert client.post("/api/individuals", json={**body, "merge_with_id": ID}).status_code == 200
    calls = [c for c in sb.calls if c.verb == "rpc"]
    assert calls
    for call in calls:
        assert set(call.payload) == _function_params(call.table), call.table


def test_every_rpc_names_a_function_in_schema_sql():
    names = {n for path in BACKEND_SOURCES for n in re.findall(r'\.rpc\("(\w+)"', path.read_text())}
    assert names, "no .rpc() call found; the check would be vacuous"
    for name in names:
        assert f"CREATE OR REPLACE FUNCTION {name}(" in SQL, name


def test_category_insert_uses_existing_columns():
    sb = FakeSupabase().on("categories", "select", data=[])
    sb.on("categories", "insert", data=lambda call: [call.payload])
    with patch("api.categories.get_supabase", return_value=sb):
        r = TestClient(app).post("/api/categories", json={"name": "Shoe size", "type": "number", "urgency_weight": 5,
                                                          "is_sensitive": False})
    assert r.status_code == 201, r.text
    _assert_known(sb)


def test_embedding_upsert_uses_existing_columns():
    from services.embedding_service import EmbeddingService
    svc = EmbeddingService.__new__(EmbeddingService)
    svc.dimensions = 3
    svc.generate_embedding = AsyncMock(return_value=[0.1, 0.2, 0.3])
    sb = FakeSupabase().on("individual_embeddings", "select", data=[]).on("individual_embeddings", "upsert", data=[])
    asyncio.run(svc.store_individual_embedding(sb, ROW, CATEGORIES))
    _assert_known(sb)


def test_no_backend_code_updates_interactions():        # H2-2.6: the table is append-only
    chains = [c for c in CHAINS if c[1] == "interactions"]
    assert chains
    for where, _, chain in chains:
        assert ".update(" not in chain and ".upsert(" not in chain, where


def test_categories_have_number_scale_max():               # H2-2.8
    assert "number_scale_max" in SCHEMA["categories"]


def test_categories_have_is_sensitive():                  # H2-3.8
    assert "is_sensitive" in SCHEMA["categories"]


def test_duplicate_decision_upsert_uses_existing_columns():      # H2-3.6
    from services.duplicate_decisions import record_duplicate_decision
    sb = FakeSupabase().on("duplicate_decisions", "upsert", data=lambda c: [c.payload])
    record_duplicate_decision(sb, candidate_id=ID, matched_id=ID, confidence=80, decision="merged",
                              model="m", client_request_id=None)
    _assert_known(sb)
