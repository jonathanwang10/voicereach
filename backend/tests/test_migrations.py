"""Rules every file in supabase/migrations/ follows (H2-2.1).

- named 2026110P0000SS_<snake_name>.sql (P = phase, SS = sequence), unique prefixes;
- idempotent: safe to apply twice (IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS first);
- no demo data (that is supabase/seed.sql);
- folded into supabase/schema.sql: every object a migration creates is in schema.sql,
  and every function body is identical there, so a fresh install and an upgraded
  database end up the same.
"""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "supabase" / "migrations"
FILES = sorted(MIGRATIONS.glob("*.sql"))
SCHEMA_FLAT = re.sub(r"\s+", " ", re.sub(r"--[^\n]*", "", (ROOT / "supabase" / "schema.sql").read_text())).strip()
NAME = re.compile(r"^2026110[1-8]0000\d\d_[a-z0-9_]+\.sql$")


def _sql(path: Path) -> str:
    return re.sub(r"--[^\n]*", "", path.read_text())


def _flat(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def _functions(flat: str) -> dict[str, str]:
    """name -> normalised block from "CREATE OR REPLACE FUNCTION name(" to its closing "$$;"."""
    out = {}
    for m in re.finditer(r"CREATE OR REPLACE FUNCTION (\w+)\(", flat):
        body_open = flat.index("$$", m.start())
        end = flat.index("$$;", body_open + 2) + 3
        out[m.group(1)] = flat[m.start():end]
    return out


def test_migration_names_follow_the_convention():
    assert len(FILES) >= 1
    for f in FILES:
        assert NAME.match(f.name), f.name
    prefixes = [f.name.split("_", 1)[0] for f in FILES]
    assert len(prefixes) == len(set(prefixes))


@pytest.mark.parametrize("path", FILES, ids=[f.name for f in FILES])
def test_migrations_are_idempotent(path):
    sql = _sql(path)
    flat = _flat(sql)
    assert len(re.findall(r"CREATE TABLE", sql)) == len(re.findall(r"CREATE TABLE IF NOT EXISTS", sql))
    assert len(re.findall(r"CREATE (?:UNIQUE )?INDEX", sql)) == \
        len(re.findall(r"CREATE (?:UNIQUE )?INDEX IF NOT EXISTS", sql))
    assert len(re.findall(r"CREATE (?:OR REPLACE )?FUNCTION", sql)) == len(re.findall(r"CREATE OR REPLACE FUNCTION", sql))
    assert len(re.findall(r"CREATE EXTENSION", sql)) == len(re.findall(r"CREATE EXTENSION IF NOT EXISTS", sql))
    assert len(re.findall(r"ADD COLUMN", sql)) == len(re.findall(r"ADD COLUMN IF NOT EXISTS", sql))
    for m in re.finditer(r"CREATE TRIGGER (\w+) .*? ON (\w+)", flat):
        drop = f"DROP TRIGGER IF EXISTS {m.group(1)} ON {m.group(2)};"
        assert drop in flat and flat.index(drop) < m.start(), m.group(1)
    for m in re.finditer(r"ADD CONSTRAINT (\w+)", flat):
        drop = f"DROP CONSTRAINT IF EXISTS {m.group(1)}"
        assert drop in flat and flat.index(drop) < m.start(), m.group(1)


def test_migrations_insert_no_demo_data():
    for f in FILES:
        sql = _sql(f)
        assert "INSERT INTO individuals" not in sql and "INSERT INTO interactions" not in sql, f.name


@pytest.mark.parametrize("path", FILES, ids=[f.name for f in FILES])
def test_every_migration_object_is_in_schema_sql(path):
    flat = _flat(_sql(path))
    names = re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)", flat)
    names += re.findall(r"ADD COLUMN IF NOT EXISTS (\w+)", flat)
    names += re.findall(r"CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)", flat)
    names += re.findall(r"CREATE TRIGGER (\w+)", flat)
    names += re.findall(r"ADD CONSTRAINT (\w+)", flat)
    for name in names:
        assert re.search(rf"\b{name}\b", SCHEMA_FLAT), f"{path.name}: {name} is not in schema.sql"
    schema_functions = _functions(SCHEMA_FLAT)
    for name, block in _functions(flat).items():
        assert schema_functions.get(name) == block, f"{path.name}: function {name} differs from schema.sql"
    for line in re.findall(r"(?:REVOKE|GRANT) EXECUTE ON FUNCTION [^;]+;", flat):
        assert line in SCHEMA_FLAT, f"{path.name}: {line} is not in schema.sql"


PGVECTOR_LOAD = re.compile(r"'\[[^\]]*\]'::extensions\.(halfvec|vector)")


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.name)
def test_a_function_that_sets_an_hnsw_option_loads_pgvector_first(path):
    """`SET hnsw.ef_search` on a function needs the pgvector library loaded in that session:
    before it, the option is an unknown placeholder, and Supabase's postgres role (not a
    superuser) gets "permission denied to set parameter" (found by CI's db job). A cast to
    halfvec loads it; schema.sql does so by building the HNSW indexes first."""
    flat = _flat(_sql(path))
    for name, block in _functions(flat).items():
        if "SET hnsw." in block:
            load = PGVECTOR_LOAD.search(flat)
            assert load and load.start() < flat.index(block), f"{path.name}: {name} sets hnsw.* before pgvector is loaded"
