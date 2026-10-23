import os, threading, time
from pathlib import Path
import pytest
from db import client as db_client

BACKEND_DIR = Path(__file__).resolve().parents[1]

def test_get_supabase_builds_one_client_with_a_20s_postgrest_timeout(monkeypatch):
    built = []
    monkeypatch.setattr(db_client, "create_client",
                        lambda url, key, options=None: built.append((url, key, options)) or object())
    assert db_client.get_supabase() is db_client.get_supabase()
    assert len(built) == 1
    url, key, options = built[0]
    assert (url, key) == (os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    assert options.postgrest_client_timeout == 20

def test_concurrent_first_calls_build_one_client(monkeypatch):          # Review Focus 2
    built = []
    def slow_create(url, key, options=None):
        time.sleep(0.05); built.append(1); return object()
    monkeypatch.setattr(db_client, "create_client", slow_create)
    results = []
    threads = [threading.Thread(target=lambda: results.append(db_client.get_supabase())) for _ in range(8)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert len(built) == 1 and len({id(r) for r in results}) == 1

def test_missing_credentials_raise_runtime_error_and_are_not_cached(monkeypatch):  # Review Focus 2
    monkeypatch.setattr(db_client, "create_client", lambda url, key, options=None: object())
    monkeypatch.delenv("SUPABASE_SERVICE_KEY")
    with pytest.raises(RuntimeError, match="SUPABASE_SERVICE_KEY"):
        db_client.get_supabase()
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "k")
    assert db_client.get_supabase() is not None

def test_only_db_client_and_auth_create_supabase_clients():
    offenders = {str(p.relative_to(BACKEND_DIR)) for p in BACKEND_DIR.rglob("*.py")
                 if not {"tests", "scripts", ".venv"} & set(p.parts) and "create_client(" in p.read_text()}
    assert offenders == {"db/client.py", "api/auth.py"}

def test_no_module_builds_a_client_at_import():
    import main
    from api import voice_assistant
    assert not hasattr(main, "supabase") and not hasattr(voice_assistant, "supabase")
