"""The db tests truncate tables, so they run only against a local database (review C-1):
their own variable, and a refusal for any other host."""
import subprocess
from pathlib import Path

import pytest

from tests.db.conftest import DB_URL_VAR, require_local_db_url

ROOT = Path(__file__).resolve().parents[2]


def test_db_tests_use_their_own_variable_not_the_owners():
    assert DB_URL_VAR == "VOICEREACH_TEST_DB_URL"


@pytest.mark.parametrize("url", [
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "postgresql://postgres@localhost/postgres",
    "postgresql://postgres@[::1]:5432/postgres",
    "host=127.0.0.1 port=54329 user=postgres dbname=postgres",
    "dbname=postgres",                                  # a local Unix socket
])
def test_local_urls_are_accepted(url):
    require_local_db_url(url)


@pytest.mark.parametrize("url", [
    "postgresql://postgres:pw@db.abcdefghijkl.supabase.co:5432/postgres",
    "postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres",
    "host=10.0.0.5 dbname=postgres",
    "postgresql://postgres@127.0.0.1,db.example.com/postgres",
])
def test_remote_urls_are_refused(url):
    with pytest.raises(pytest.UsageError, match="local"):
        require_local_db_url(url)


@pytest.mark.parametrize("url", [
    "postgresql://postgres:pw@db.abcdefghijkl.supabase.co:5432/postgres",
    "postgresql://postgres@10.0.0.5/postgres?sslmode=require",
])
def test_check_migrations_refuses_a_remote_database(url):
    result = subprocess.run(["bash", str(ROOT / "supabase/check_migrations.sh"), url, "/dev/null"],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode != 0
    assert "local" in result.stderr
