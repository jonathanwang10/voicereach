"""
The one service-key Supabase client per process (H2-1.2).

api/auth.py keeps its own anon-key client for token checks; backend/scripts/ are
separate processes and build their own.
"""
import os
import threading

from supabase import Client, ClientOptions, create_client

# Below the 110 s transcribe deadline (api/transcription.py), so a hung PostgREST
# call fails as a database error instead of eating the whole request budget (H2-1.2).
POSTGREST_TIMEOUT_SECONDS = 20

_client: Client | None = None
_lock = threading.Lock()


def get_supabase() -> Client:
    """The shared service-key client, built on first use (lazily, so tests can patch it).

    RuntimeError, not ValueError, when the env is missing: /api/transcribe maps a
    ValueError to a 400. A failed build is not cached.
    """
    global _client
    if _client is None:
        with _lock:
            if _client is None:
                url = os.getenv("SUPABASE_URL")
                key = os.getenv("SUPABASE_SERVICE_KEY")
                if not url or not key:
                    raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
                _client = create_client(
                    url, key, options=ClientOptions(postgrest_client_timeout=POSTGREST_TIMEOUT_SECONDS))
    return _client
