"""Static checks on supabase/schema.sql and supabase/seed.sql (C-20, C-29, C-54, C-55, C-56, H2-2.1).

There is no database in the test run, so these read the SQL text. The seed
check uses a small parser written for the exact INSERT shapes:

- preset categories (schema.sql): one VALUES tuple per category, columns in the order
  (name, display_name, type, is_required, is_preset, priority, urgency_weight,
   auto_trigger, options), options being NULL or a '...'::jsonb literal;
- demo individuals (seed.sql): ('Full Name', '{...}'::jsonb, <urgency_score>) tuples.

If either shape changes, the count assertions below fail loudly rather than the
checks silently passing on zero rows.
"""
import json
import re
from pathlib import Path

import pytest

from services.field_registry import normalize_individual_data
from services.urgency_calculator import calculate_urgency_score

SCHEMA = Path(__file__).resolve().parents[2] / "supabase" / "schema.sql"
RAW_SQL = SCHEMA.read_text()
# Line comments removed, so a statement mentioned in a comment never counts.
SQL = re.sub(r"--[^\n]*", "", RAW_SQL)
SEED_RAW = (SCHEMA.parent / "seed.sql").read_text()
SEED_SQL = re.sub(r"--[^\n]*", "", SEED_RAW)

TABLES = ("categories", "individuals", "interactions", "individual_embeddings")
SEED_NAMES = {"Sarah Smith", "Michael Chen", "John Doe", "Maria Garcia", "Robert Johnson", "James Brown"}

# Every policy name any earlier version of the schema (or the old migration chain) created.
OLD_POLICIES = [
    ("Allow all operations on categories", "categories"),
    ("Allow all operations on individuals", "individuals"),
    ("Allow all operations on interactions", "interactions"),
    ("demo all categories", "categories"),
    ("demo all individuals", "individuals"),
    ("demo all inter", "interactions"),
    ("demo all embeddings", "individual_embeddings"),
    ("signed-in users: categories", "categories"),
    ("signed-in users: individuals", "individuals"),
    ("signed-in users: interactions", "interactions"),
    ("signed-in users: embeddings", "individual_embeddings"),
]


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


FLAT = _norm(SQL)
SEED_FLAT = _norm(SEED_SQL)


# --- seed parsing ----------------------------------------------------------

_CATEGORY_ROW = re.compile(
    r"\(\s*'(\w+)',\s*'([^']*)',\s*'(\w+)',\s*(TRUE|FALSE),\s*(TRUE|FALSE),\s*'(\w+)',"
    r"\s*(\d+),\s*(TRUE|FALSE),\s*(NULL|'([^']*)'::jsonb)\s*\)",
    re.S,
)
_INDIVIDUAL_ROW = re.compile(r"\(\s*'([^']+)',\s*'(\{[^']*\})'::jsonb,\s*(\d+)", re.S)


def _seed_categories() -> list[dict]:
    block = SQL[SQL.index("INSERT INTO categories"):]
    block = block[:block.index(";")]
    assert "(name, display_name, type, is_required, is_preset, priority, urgency_weight, auto_trigger, options)" \
        in _norm(block), "category column order changed; update the parser"
    rows = []
    for m in _CATEGORY_ROW.finditer(block):
        rows.append({
            "name": m.group(1),
            "display_name": m.group(2),
            "type": m.group(3),
            "is_required": m.group(4) == "TRUE",
            "is_preset": m.group(5) == "TRUE",
            "priority": m.group(6),
            "urgency_weight": int(m.group(7)),
            "auto_trigger": m.group(8) == "TRUE",
            "options": json.loads(m.group(10)) if m.group(10) else None,
        })
    return rows


def _seed_individuals() -> list[tuple[str, dict, int]]:
    return [(m.group(1), json.loads(m.group(2)), int(m.group(3))) for m in _INDIVIDUAL_ROW.finditer(SEED_SQL)]


def test_seed_parser_finds_every_row():
    assert len(_seed_categories()) == 11
    assert {name for name, _, _ in _seed_individuals()} == SEED_NAMES
    assert len(_seed_individuals()) == len(SEED_NAMES)


@pytest.mark.parametrize("name,data,score", _seed_individuals(), ids=[n for n, _, _ in _seed_individuals()])
def test_seed_urgency_score_matches_calculator(name, data, score):
    """C-20: the stored score must be what the backend would compute for that row (OD-1 maths)."""
    assert score == calculate_urgency_score(data, _seed_categories())


@pytest.mark.parametrize("name,data,score", _seed_individuals(), ids=[n for n, _, _ in _seed_individuals()])
def test_seed_data_is_already_normalised(name, data, score):
    """A first save through the backend must not report the seed values as 'changed'."""
    clean, errors = normalize_individual_data({"name": name, **data}, _seed_categories())
    assert errors == []
    assert clean == {"name": name, **data}


# --- RLS: enabled, and no policies at all (R-1) ----------------------------

@pytest.mark.parametrize("table", TABLES)
def test_rls_enabled(table):
    assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY" in FLAT


def test_no_policies_are_created():
    assert "CREATE POLICY" not in SQL.upper()


@pytest.mark.parametrize("policy,table", OLD_POLICIES)
def test_old_policies_are_dropped(policy, table):
    assert f'DROP POLICY IF EXISTS "{policy}" ON {table};' in FLAT


# --- safe to re-run (R-12 / C-54) ------------------------------------------

def test_tables_and_indexes_are_guarded():
    assert len(re.findall(r"CREATE TABLE", SQL)) == len(re.findall(r"CREATE TABLE IF NOT EXISTS", SQL)) == 4
    assert len(re.findall(r"CREATE (?:UNIQUE )?INDEX", SQL)) == len(re.findall(r"CREATE (?:UNIQUE )?INDEX IF NOT EXISTS", SQL))


def test_functions_and_triggers_are_replaceable():
    assert re.findall(r"CREATE (?:OR REPLACE )?FUNCTION", SQL) == ["CREATE OR REPLACE FUNCTION"]
    for trigger, table in re.findall(r"CREATE TRIGGER (\w+) BEFORE UPDATE ON (\w+)", FLAT):
        drop = f"DROP TRIGGER IF EXISTS {trigger} ON {table};"
        assert drop in FLAT and FLAT.index(drop) < FLAT.index(f"CREATE TRIGGER {trigger} BEFORE UPDATE ON {table}")


def test_seed_individuals_are_guarded_by_name():
    insert = SEED_FLAT[SEED_FLAT.index("INSERT INTO individuals"):]
    insert = insert[:insert.index(";")]
    assert "WHERE NOT EXISTS (SELECT 1 FROM individuals" in insert
    assert "ON CONFLICT DO NOTHING" not in insert  # it had nothing unique to conflict on


def test_seed_interactions_only_for_seeded_people_without_history():
    insert = SEED_FLAT[SEED_FLAT.index("INSERT INTO interactions"):]
    insert = insert[:insert.index(";")]
    assert "NOT EXISTS (SELECT 1 FROM interactions" in insert
    for name in SEED_NAMES:
        assert f"'{name}'" in insert


# --- updated_at trigger and indexes (C-56) ---------------------------------

@pytest.mark.parametrize("table", ["individuals", "categories", "individual_embeddings"])
def test_updated_at_trigger(table):
    assert re.search(
        rf"CREATE TRIGGER \w+ BEFORE UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION set_updated_at\(\)", FLAT
    )


def test_set_updated_at_function_sets_now():
    fn = FLAT[FLAT.index("CREATE OR REPLACE FUNCTION set_updated_at()"):]
    assert "NEW.updated_at = NOW()" in fn[:fn.index("$$;")]


def test_latest_interaction_index():
    assert re.search(r"CREATE INDEX IF NOT EXISTS \w+ ON interactions ?\(individual_id, created_at DESC\)", FLAT)


@pytest.mark.parametrize("index", [
    "idx_individuals_data",        # GIN on data: nothing queries JSONB with an operator it serves
    "idx_individuals_urgency",     # sorting by urgency happens in Python on the display score
    "idx_embeddings_individual",   # duplicate of the UNIQUE (individual_id) index
    "idx_interactions_individual", # leading column of the composite index
    "idx_interactions_created",    # every interactions query filters by individual_id first
    "idx_individuals_name",        # names are sorted and matched in Python; a b-tree can't serve ILIKE
])
def test_unused_indexes_dropped(index):
    assert f"DROP INDEX IF EXISTS {index};" in FLAT
    assert not re.search(rf"CREATE INDEX IF NOT EXISTS {index}\b", FLAT)


# --- NOT NULL and CHECK (C-55, C-10) ---------------------------------------

def _column_def(table: str, column: str) -> str:
    body = SQL[SQL.index(f"CREATE TABLE IF NOT EXISTS {table} ("):]
    body = body[:body.index(");")]
    m = re.search(rf"^\s*{column}\s+([^\n]*)$", body, re.M)
    assert m, f"{table}.{column} not defined"
    return m.group(1)


@pytest.mark.parametrize("table,column", [
    ("individuals", "urgency_score"),
    ("individuals", "created_at"),
    ("individuals", "updated_at"),
    ("interactions", "individual_id"),
    ("interactions", "user_name"),
    ("interactions", "created_at"),
    ("categories", "created_at"),
    ("categories", "updated_at"),
    ("categories", "urgency_weight"),
    ("categories", "auto_trigger"),
    ("categories", "is_required"),
    ("categories", "is_preset"),
    ("categories", "priority"),
    ("categories", "is_active"),
    ("individual_embeddings", "created_at"),
    ("individual_embeddings", "updated_at"),
])
def test_not_null_columns(table, column):
    """Fresh databases get NOT NULL from CREATE TABLE; older ones from the ALTER section."""
    assert "NOT NULL" in _column_def(table, column)
    alters = re.findall(rf"ALTER TABLE {table} [^;]*;", FLAT)
    assert any(f"ALTER COLUMN {column} SET NOT NULL" in a for a in alters), \
        f"older databases also need {table}.{column} SET NOT NULL"


def test_urgency_override_range_check():
    check = "CHECK (urgency_override IS NULL OR urgency_override BETWEEN 0 AND 100)"
    assert check in FLAT
    # older databases: added idempotently by name
    assert "DROP CONSTRAINT IF EXISTS individuals_urgency_override_range" in FLAT
    assert f"ADD CONSTRAINT individuals_urgency_override_range {check}" in FLAT


def test_header_tells_owner_to_disable_signups_and_anonymous_signins():
    header = RAW_SQL[:RAW_SQL.index("CREATE")].lower()
    assert "disable sign-ups" in header and "anonymous sign-ins" in header


# --- demo data lives in seed.sql only (H2-2.1) ------------------------------

def test_schema_sql_inserts_no_demo_people():
    assert "INSERT INTO individuals" not in SQL and "INSERT INTO interactions" not in SQL
    for name in SEED_NAMES:
        assert f"'{name}'" not in SQL

def test_seed_backfills_last_location_only_where_missing():
    assert "UPDATE individuals i SET last_location = sub.location" in SEED_FLAT
    assert "AND i.last_location IS NULL" in SEED_FLAT

def test_seed_header_says_run_schema_first():
    assert "schema.sql" in SEED_RAW[:SEED_RAW.index("WITH seed")]
