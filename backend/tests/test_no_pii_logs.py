"""R-14 (C-30): the backend logs no names, transcripts, questions, field values or GPS.

Each test drives a real path with a sentinel person (name, transcript, GPS) and
checks everything the process wrote: log records (caplog, at DEBUG) and
stdout/stderr (capsys). Failures are made to carry the sentinel in their
messages too, so "log the exception text" is caught as well.
"""
import ast
import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from tests.helpers import FakeSecretClient, FakeUpstream

SENTINEL_NAME = "Zebulon Quixley"
SENTINEL_TOKEN = "quixley"           # checked case-insensitively: catches partial logging too
SENTINEL_LAT = 37.7123456
SENTINEL_EMAIL = "zeb.quixley@example.org"
NOW = datetime.now(timezone.utc).isoformat()

CATEGORIES = [
    {"name": "name", "type": "text", "is_required": True, "urgency_weight": 0, "options": None},
    {"name": "height", "type": "number", "is_required": True, "urgency_weight": 0, "options": None},
    {"name": "weight", "type": "number", "is_required": True, "urgency_weight": 0, "options": None},
    {"name": "medical_conditions", "type": "multi_select", "is_required": False, "urgency_weight": 0,
     "options": ["Diabetes", "None"]},
]
PERSON = {
    "id": str(uuid4()), "name": SENTINEL_NAME, "urgency_score": 40, "urgency_override": None,
    "data": {"name": SENTINEL_NAME, "height": 70, "weight": 160, "medical_conditions": ["Diabetes"]},
    "last_location": {"latitude": SENTINEL_LAT, "longitude": -122.4, "address": "1 Quixley Way"},
    "created_at": NOW, "updated_at": NOW,
}


def _assert_clean(caplog, capsys):
    from services.request_log import JsonFormatter
    out = capsys.readouterr()
    # The JSON form too: summary fields ride in `extra=`, which caplog.text leaves out (H2-8.1)
    formatted = [JsonFormatter().format(r) for r in caplog.records]
    everything = "\n".join([caplog.text, out.out, out.err, *formatted]).lower()
    assert SENTINEL_TOKEN not in everything
    assert str(SENTINEL_LAT) not in everything
    assert SENTINEL_EMAIL not in everything


@pytest.fixture
def capture(caplog):
    caplog.set_level(logging.DEBUG)
    return caplog


class FakeDB:
    """Chainable stand-in for the Supabase client: every filter returns the query,
    execute() returns the table's rows, insert/update echo the payload as a row.
    `fail` makes every execute() raise an error that carries the sentinel."""

    def __init__(self, rows=None, fail=False):
        self.rows = {"individuals": [PERSON], "categories": CATEGORIES, "interactions": [],
                     "individual_embeddings": [], **(rows or {})}
        self.fail = fail

    def table(self, name):
        return _FakeQuery(self, name)

    def rpc(self, name, params):
        """save_individual: echo the saved person and visit as rows."""
        return _FakeRpc(self, params)


class _FakeRpc:
    def __init__(self, db, params):
        self.db, self.params = db, params

    def execute(self):
        if self.db.fail:
            raise RuntimeError(f"database error for {SENTINEL_NAME} at {SENTINEL_LAT}")
        p, visit = self.params, self.params["p_interaction"]
        person = {"id": p["p_individual_id"] or str(uuid4()), "name": p["p_name"], "data": p["p_data"],
                  "urgency_score": p["p_urgency_score"], "urgency_override": None, "version": 1,
                  "last_location": visit.get("location"), "created_at": NOW, "updated_at": NOW}
        visit_row = {"id": str(uuid4()), "created_at": NOW, "user_name": visit.get("user_name"),
                     "location": visit.get("location"), "transcription": visit.get("transcription")}
        return MagicMock(data={"individual": person, "interaction": visit_row, "replayed": False})


class _FakeQuery:
    def __init__(self, db, table):
        self.db, self.table, self.payload = db, table, None

    def __getattr__(self, _name):           # eq, ilike, or_, in_, order, limit, maybe_single, ...
        return lambda *a, **k: self

    def select(self, *a, **k):
        return self

    def insert(self, payload):
        self.payload = payload
        return self

    update = insert

    def execute(self):
        if self.db.fail:
            raise RuntimeError(f"database error for {SENTINEL_NAME} at {SENTINEL_LAT}")
        if self.payload is not None:
            row = {"id": str(uuid4()), "created_at": NOW, "updated_at": NOW, "urgency_override": None,
                   "user_name": "Demo User", **self.payload}
            return MagicMock(data=[row], count=1)
        rows = list(self.db.rows.get(self.table, []))
        return MagicMock(data=rows, count=len(rows))


def _client():
    from main import app
    return TestClient(app)


# --- static guard -------------------------------------------------------------------

def test_backend_code_has_no_print_calls():
    """Server code logs through `logging`; a bare print bypasses levels and the review."""
    backend = Path(__file__).resolve().parents[1]
    offenders = []
    for path in backend.rglob("*.py"):
        rel = path.relative_to(backend)
        # scripts/ and evals/ are command-line tools (evals print metrics of synthetic data)
        if rel.parts[0] in ("tests", "scripts", "evals") or ".venv" in str(rel):
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "print":
                offenders.append(f"{rel}:{node.lineno}")
    assert offenders == []


# --- save ---------------------------------------------------------------------------

@pytest.mark.real_embedding_task
def test_save_path_logs_no_person_data(capture, capsys):
    class _FailingEmbeddings:
        async def store_individual_embedding(self, *a, **k):
            raise RuntimeError(f"embedding failed for {SENTINEL_NAME}")

    db = FakeDB()
    with patch("api.individuals.get_supabase", return_value=db), \
         patch("services.embedding_service.EmbeddingService", _FailingEmbeddings):
        r = _client().post("/api/individuals", json={
            "data": {"name": SENTINEL_NAME, "height": 70, "weight": 160},
            "transcription": f"Met {SENTINEL_NAME} by the library",
            "location": {"latitude": SENTINEL_LAT, "longitude": -122.4, "address": "1 Quixley Way"},
        })
    assert r.status_code == 200, r.text
    _assert_clean(capture, capsys)


def test_failed_save_logs_no_person_data(capture, capsys):
    with patch("api.individuals.get_supabase", return_value=FakeDB(fail=True)):
        r = _client().post("/api/individuals", json={"data": {"name": SENTINEL_NAME, "height": 70, "weight": 160}})
    assert r.status_code == 500
    _assert_clean(capture, capsys)


# --- transcribe ---------------------------------------------------------------------

def test_transcribe_path_logs_no_transcript(capture, capsys):
    openai_mock = MagicMock()
    openai_mock.transcribe_audio_file = AsyncMock(return_value=f"This is {SENTINEL_NAME}, about 5 foot 10")
    openai_mock.categorize_transcription = AsyncMock(return_value={"name": SENTINEL_NAME, "height": 70})
    dup = MagicMock()
    dup.return_value.find_duplicates = AsyncMock(side_effect=RuntimeError(f"no match for {SENTINEL_NAME}"))
    with patch("api.transcription.get_openai_service", return_value=openai_mock), \
         patch("api.transcription.get_supabase", return_value=FakeDB()), \
         patch("services.recording_pipeline.DuplicateDetectionService", dup):
        r = _client().post("/api/transcribe", json={"audio_data": "AAAA"})
    assert r.status_code == 200, r.text
    assert r.json()["duplicate_check_failed"] is True
    _assert_clean(capture, capsys)


def test_llm_comparison_failure_logs_only_the_error_type(capture, capsys):
    from services.openai_service import OpenAIService
    service = OpenAIService()
    service.client = MagicMock()
    service.client.chat.completions.create = AsyncMock(
        side_effect=RuntimeError(f"upstream echoed the prompt: {SENTINEL_NAME}"))
    assert asyncio.run(service.compare_individuals(f"Compare {SENTINEL_NAME}")) == {}
    assert "RuntimeError" in capture.text
    _assert_clean(capture, capsys)


def test_dropped_values_log_only_a_count(capture, capsys):                # H2-3.3
    from services.openai_service import OpenAIService
    service = OpenAIService()
    service.client = MagicMock()
    reply = json.dumps({"name": {"value": SENTINEL_NAME, "evidence": f"this is {SENTINEL_NAME}"}})
    completion = MagicMock()
    completion.choices = [MagicMock(message=MagicMock(content=reply, refusal=None))]
    service.client.chat.completions.create = AsyncMock(return_value=completion)
    assert asyncio.run(service.categorize_transcription("a note about someone else", CATEGORIES)) == {}
    assert "dropped 1" in capture.text
    _assert_clean(capture, capsys)


# --- search -------------------------------------------------------------------------

def test_list_search_logs_no_search_term(capture, capsys):
    with patch("api.individuals.get_supabase", return_value=FakeDB()):
        r = _client().get("/api/individuals", params={"search": SENTINEL_NAME})
    assert r.status_code == 200 and r.json()["total"] == 1
    _assert_clean(capture, capsys)


def test_request_summaries_carry_no_person_data(capture, capsys):   # H2-8.1
    import json as _json
    from services.request_log import SUMMARY_LOGGER, JsonFormatter
    openai_mock = MagicMock()
    openai_mock.transcribe_audio_file = AsyncMock(return_value=f"This is {SENTINEL_NAME}")
    openai_mock.categorize_transcription = AsyncMock(return_value={"name": SENTINEL_NAME, "height": 70})
    dup = MagicMock()
    dup.return_value.find_duplicates = AsyncMock(return_value=[])
    with patch("api.individuals.get_supabase", return_value=FakeDB()), \
         patch("api.transcription.get_openai_service", return_value=openai_mock), \
         patch("api.transcription.get_supabase", return_value=FakeDB()), \
         patch("services.recording_pipeline.DuplicateDetectionService", dup):
        assert _client().get("/api/individuals", params={"search": SENTINEL_NAME}).status_code == 200
        assert _client().post("/api/individuals", json={
            "data": {"name": SENTINEL_NAME, "height": 70, "weight": 160}}).status_code == 200
        assert _client().post("/api/transcribe", json={"audio_data": "AAAA"}).status_code == 200
    lines = [_json.loads(JsonFormatter().format(r)) for r in capture.records if r.name == SUMMARY_LOGGER]
    assert len(lines) >= 3
    for line in lines:
        assert "?" not in line.get("route", "") and SENTINEL_TOKEN not in line.get("route", "").lower()
    _assert_clean(capture, capsys)


def test_semantic_search_logs_no_query_or_names(capture, capsys):
    from services.embedding_service import EmbeddingService
    from tests.helpers import FakeSupabase
    row = {**PERSON, "version": 1, "score": 0.03, "match_source": "exact", "similarity": None}
    sb = FakeSupabase().on_rpc("search_individuals_hybrid", data=[row]).on("interactions", "select", data=[])
    with patch("api.embeddings.get_supabase", return_value=sb), \
         patch.object(EmbeddingService, "embed_query", AsyncMock(side_effect=RuntimeError(f"bad query {SENTINEL_NAME}"))):
        r = _client().post("/api/embeddings/search", json={"query": SENTINEL_NAME})
    assert r.status_code == 200 and r.json()["results"]
    _assert_clean(capture, capsys)


# --- recordings worker (H2-7.3) ----------------------------------------------------

@pytest.mark.parametrize("extraction_fails", [False, True])
def test_recording_worker_logs_no_transcript_or_fields(capture, capsys, extraction_fails):
    from services.recording_worker import process_job
    from tests.helpers import FakeSupabase
    job = {"id": str(uuid4()), "storage_path": "c.m4a", "transcription": None, "attempts": 1,
           "status": "transcribing", "location": PERSON["last_location"]}
    sb = FakeSupabase()
    sb.on("recordings", "update", data=lambda c: [{**job, **c.payload}])
    sb.on("categories", "select", data=[
        {"name": "name", "type": "text", "is_required": True, "options": None}])
    sb.storage.files[("recordings", "c.m4a")] = b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 64
    openai = MagicMock(transcribe_audio_file=AsyncMock(return_value=f"Met {SENTINEL_NAME} at {SENTINEL_LAT}"))
    if extraction_fails:
        openai.categorize_transcription = AsyncMock(side_effect=RuntimeError(f"bad output for {SENTINEL_NAME}"))
    else:
        openai.categorize_transcription = AsyncMock(return_value={"name": SENTINEL_NAME})
    dup = MagicMock()
    dup.return_value.find_duplicates = AsyncMock(return_value=[PERSON])
    with patch("services.recording_pipeline.DuplicateDetectionService", dup):
        asyncio.run(process_job(job, sb, openai))
    assert sb.payloads("recordings", "update")[-1]["status"] == ("queued" if extraction_fails else "ready")
    _assert_clean(capture, capsys)


# --- auth ---------------------------------------------------------------------------

@pytest.mark.real_auth
def test_rejected_token_logs_no_error_text(capture, capsys, monkeypatch):
    import api.auth as auth
    from fastapi import HTTPException
    from supabase_auth.errors import AuthApiError

    client = MagicMock()
    client.auth.get_user.side_effect = AuthApiError(f"user {SENTINEL_EMAIL} not found", 403, "user_not_found")
    monkeypatch.setattr(auth, "_get_auth_client", lambda: client)
    auth._cache.clear()
    with pytest.raises(HTTPException) as exc:
        auth.verify_token("some-token")
    assert exc.value.status_code == 401
    assert "AuthApiError" in capture.text
    _assert_clean(capture, capsys)


# --- realtime WebSocket -------------------------------------------------------------

def _upstream():
    """A transcript naming the sentinel, then a search_people call for the sentinel."""
    args = json.dumps({"query": SENTINEL_NAME})
    call = {"type": "function_call", "call_id": "c1", "name": "search_people", "arguments": args}
    return FakeUpstream([
        {"type": "response.output_audio_transcript.delta", "delta": SENTINEL_NAME},
        {"type": "response.function_call_arguments.done", "response_id": "r1", "call_id": "c1",
         "name": "search_people", "arguments": args},
        {"type": "response.done", "response": {"id": "r1", "status": "completed", "output": [call]}},
    ])


@pytest.mark.parametrize("lookup_fails", [False, True])
def test_ws_proxy_logs_no_question_tool_arguments_or_results(capture, capsys, monkeypatch, lookup_fails):
    import main
    if lookup_fails:
        search = AsyncMock(side_effect=RuntimeError(f"lookup failed: {SENTINEL_NAME}"))
    else:
        search = AsyncMock(return_value=[PERSON])
    upstream = _upstream()
    monkeypatch.setattr("services.retrieval.search_people", search)
    monkeypatch.setattr(main, "verify_token", lambda token: "user-ws")
    monkeypatch.setattr(main.httpx, "AsyncClient", FakeSecretClient)
    monkeypatch.setattr(main.websockets, "connect", lambda *a, **k: upstream)

    with _client().websocket_connect("/api/voice-assistant/realtime/ws",
                                     headers={"Authorization": "Bearer t"}) as ws:
        assert SENTINEL_NAME in ws.receive_text()
        ws.receive_text()                                     # the call's arguments
        ws.receive_text()                                     # response.done
        ws.send_text(json.dumps({"type": "input_audio_buffer.append", "audio": "UXVpeGxleQ=="}))
        ws.send_text(json.dumps({"type": "conversation.item.create", "item": {
            "type": "message", "role": "user",
            "content": [{"type": "input_text", "text": f"Is {SENTINEL_NAME} at {SENTINEL_LAT} safe?"}]}}))
        ws.send_text(json.dumps({"type": "session.update", "session": {"instructions": SENTINEL_NAME}}))
        ws.receive_text()                                     # the error event for session.update
        for _ in range(200):
            if len(upstream.sent) >= 5:
                break
            time.sleep(0.01)
    search.assert_awaited_once()                              # the tool really ran
    assert any("function_call_output" in f for f in upstream.sent)
    assert any(f"Is {SENTINEL_NAME}" in f for f in upstream.sent)   # the question really went through
    _assert_clean(capture, capsys)


# --- logging configuration -----------------------------------------------------------

def test_access_log_drops_query_strings():
    """GET /api/individuals?search=<name>: uvicorn's access line must not carry the term."""
    import main
    record = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 0, '%s - "%s %s HTTP/%s" %d',
        ("10.0.0.1:5000", "GET", f"/api/individuals?search={SENTINEL_NAME}&limit=20", "1.1", 200), None)
    assert main.DropQueryString().filter(record) is True
    message = record.getMessage()
    assert "/api/individuals" in message and SENTINEL_NAME not in message and "?" not in message
    assert any(isinstance(f, main.DropQueryString) for f in logging.getLogger("uvicorn.access").filters)


def test_library_loggers_stay_quiet_even_at_debug():
    """httpx/openai log request URLs and bodies (PostgREST name filters, transcripts)."""
    import main
    main.configure_logging("DEBUG")
    try:
        for name in main.QUIET_LIBRARY_LOGGERS:
            assert logging.getLogger(name).getEffectiveLevel() >= logging.WARNING, name
        assert {"httpx", "httpx2", "httpcore", "openai"} <= set(main.QUIET_LIBRARY_LOGGERS)
    finally:
        main.configure_logging("INFO")


def test_openai_log_env_cannot_unpin_the_sdk_logger():
    """OPENAI_LOG=debug makes the SDK set its own logger to DEBUG when it is first imported,
    which happens after main.configure_logging (via the routers). main re-pins afterwards."""
    import os
    import subprocess
    import sys
    backend = Path(__file__).resolve().parents[1]
    code = ("import logging, main; "
            "print(min(logging.getLogger(n).getEffectiveLevel() for n in main.QUIET_LIBRARY_LOGGERS))")
    env = {**os.environ, "OPENAI_LOG": "debug", "LOG_LEVEL": "DEBUG"}
    out = subprocess.run([sys.executable, "-c", code], cwd=backend, env=env,
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert int(out.stdout.strip().splitlines()[-1]) >= logging.WARNING
