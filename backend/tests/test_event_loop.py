import asyncio, threading, time
from unittest.mock import AsyncMock, patch
import httpx, pytest
from fastapi.testclient import TestClient
from main import app
from db.client import run_db
from tests.helpers import FakeSupabase

ID = "550e8400-e29b-41d4-a716-446655440001"

async def test_run_db_runs_the_call_in_a_worker_thread():
    assert await run_db(threading.get_ident) != threading.get_ident()

async def test_run_db_propagates_the_error():
    def boom(): raise RuntimeError("boom")
    with pytest.raises(RuntimeError, match="boom"):
        await run_db(boom)

def test_fake_supabase_refuses_a_query_on_the_event_loop():
    sb = FakeSupabase().on("categories", "select", data=[])
    async def on_loop(): return sb.table("categories").select("*").execute()
    with pytest.raises(AssertionError, match="event loop"):
        asyncio.run(on_loop())

async def test_a_slow_database_call_does_not_stall_other_requests():
    sb = FakeSupabase().on("individuals", "select", data=lambda call: time.sleep(0.5) or [])
    with patch("api.individuals.get_supabase", return_value=sb):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            slow = asyncio.create_task(c.get("/api/individuals"))
            await asyncio.sleep(0.1)
            started = time.monotonic()
            assert (await c.get("/health")).status_code == 200
            assert time.monotonic() - started < 0.3
            assert (await slow).status_code == 200

# (method, path, body, patch target, [(table, verb, data)], expected status).
# An on-loop execute() would be an AssertionError, which the route turns into a 500 "... failed".
OFF_LOOP_ROUTES = [
    ("post", "/api/embeddings/search", {"query": "x"}, "api.embeddings.get_supabase",
     [("individuals", "select", []), ("individual_embeddings", "select", [])], 200),
    ("post", "/api/embeddings/generate", {"individual_id": ID}, "api.embeddings.get_supabase",
     [("individuals", "select", [])], 404),
    ("post", "/api/embeddings/generate-all", None, "api.embeddings.get_supabase", [("individuals", "select", [])], 200),
    ("get", "/api/embeddings/status", None, "api.embeddings.get_supabase",
     [("individuals", "select", []), ("individual_embeddings", "select", [])], 200),
    ("get", "/api/categories", None, "api.categories.get_supabase", [("categories", "select", [])], 200),
    ("get", "/api/export", None, "api.categories.get_supabase",
     [("categories", "select", []), ("individuals", "select", [])], 200),
    ("get", f"/api/individuals/{ID}", None, "api.individuals.get_supabase", [("individuals", "select", [])], 404),
    ("get", f"/api/individuals/{ID}/interactions", None, "api.individuals.get_supabase",
     [("interactions", "select", [])], 200),
    ("put", f"/api/individuals/{ID}/urgency-override", {"urgency_override": 5}, "api.individuals.get_supabase",
     [("individuals", "update", [])], 404),
    ("delete", f"/api/individuals/{ID}", None, "api.individuals.get_supabase", [("individuals", "delete", [])], 404),
    ("post", "/api/individuals/check-duplicates", {"name": "Ann Lee"}, "api.individuals.get_supabase",
     [("find_duplicate_candidates", "rpc", [])], 200),
]

@pytest.mark.parametrize("method,path,body,target,script,status", OFF_LOOP_ROUTES)
def test_route_queries_run_off_the_event_loop(method, path, body, target, script, status):
    sb = FakeSupabase()
    for table, verb, data in script:
        if verb == "rpc":
            sb.on_rpc(table, data=data)
        else:
            sb.on(table, verb, data=data)
    with patch(target, return_value=sb):
        r = TestClient(app, raise_server_exceptions=False).request(
            method, path, **({"json": body} if body is not None else {}))
    assert r.status_code == status, r.text

def test_transcribe_categories_read_runs_off_the_loop():
    sb = FakeSupabase().on("categories", "select", data=[])
    with patch("api.transcription.get_supabase", return_value=sb):
        r = TestClient(app, raise_server_exceptions=False).post("/api/transcribe", json={"audio_data": "AAAA"})
    assert r.json()["detail"].startswith("No categories found")

@pytest.mark.real_embedding_task                                          # Review Focus 1
async def test_background_embedding_reads_and_upserts_off_the_loop():
    from api.individuals import generate_embedding_background
    sb = FakeSupabase().on("categories", "select", data=[]).on("individual_embeddings", "upsert", data=[])
    with patch("api.individuals.get_supabase", return_value=sb), \
         patch("services.embedding_service.EmbeddingService.generate_embedding",
               new=AsyncMock(return_value=[0.0] * 3072)):
        await generate_embedding_background(ID, {"id": ID, "name": "Ann", "data": {}})
    assert [c.verb for c in sb.calls] == ["select", "upsert"]
