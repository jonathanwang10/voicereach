"""
The one service-key Supabase client per process (H2-1.2), and the thread hop every
async path uses to call it (H2-1.1).

api/auth.py keeps its own anon-key client for token checks; backend/scripts/ are
separate processes and build their own.
"""
import os
import threading
from typing import Any, Callable, TypeVar

from starlette.concurrency import run_in_threadpool
from supabase import Client, ClientOptions, create_client

T = TypeVar("T")

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


async def run_db(fn: Callable[[], T]) -> T:
    """Run a sync supabase-py call (`lambda: ....execute()`) in the threadpool.

    supabase-py is synchronous; calling it inside `async def` blocks the event loop,
    which stalls every request and the realtime proxy (H2-1.1). Returns fn()'s value
    and propagates its exception.
    """
    return await run_in_threadpool(fn)


def fetch_all(build: Callable[[], Any], page_size: int = 1000) -> list[dict]:
    """Every row of a query, one `.range()` page at a time (H2-1.3).

    PostgREST stops at its "Max rows" setting (1000 by default) without saying so,
    so a single read silently drops everyone past it. `build` returns a fresh query
    builder (no `.range()`), ordered by a unique key so pages can't overlap. A row
    whose `id` was already returned is skipped, so a person inserted mid-read (which
    shifts a row onto the next page) never appears twice. Sync: call it inside run_db
    from async code.
    """
    rows: list[dict] = []
    seen: set = set()
    start = 0
    while True:
        page = build().range(start, start + page_size - 1).execute().data or []
        for row in page:
            key = row.get("id") if isinstance(row, dict) else None
            if key is not None:
                if key in seen:
                    continue
                seen.add(key)
            rows.append(row)
        if len(page) < page_size:
            return rows
        start += page_size
