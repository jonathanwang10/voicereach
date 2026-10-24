"""Structured request logs (H2-8.1): a request id on every response, one JSON summary
line per request / recording job / realtime session, with stage timings and token
usage, and never any data the request carried."""
import asyncio
import json
import logging
import os
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import main
from services.request_log import (SUMMARY_LOGGER, JsonFormatter, RequestLogMiddleware, emit_summary, log_context,
                                  record_usage, stage_timer)
from tests.helpers import FakeSecretClient, FakeSupabase, FakeUpstream

BACKEND = Path(__file__).resolve().parents[1]


def summaries(caplog):
    return [json.loads(JsonFormatter().format(r)) for r in caplog.records if r.name == SUMMARY_LOGGER]


@pytest.fixture(autouse=True)
def _capture_debug(caplog):
    caplog.set_level(logging.DEBUG, logger=SUMMARY_LOGGER)


def _mini_app():
    app = FastAPI()
    app.add_middleware(RequestLogMiddleware)

    @app.get("/items/{item_id}")
    async def item(item_id: str):
        return {"ok": True}

    @app.get("/stages")
    async def stages():
        with stage_timer("whisper_ms"):
            await asyncio.sleep(0.02)
        record_usage("extract", SimpleNamespace(usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5,
                                                                      total_tokens=15)))
        record_usage("extract", {"prompt_tokens": 1, "total_tokens": 1})
        return {}

    @app.get("/sync")
    def sync_route():
        with stage_timer("dup_ms"):
            pass
        return {}

    @app.get("/boom")
    async def boom():
        raise RuntimeError("Zebulon Quixley")

    @app.get("/health")
    async def health():
        return {}

    return app


# --- the request id ------------------------------------------------------------------

def test_response_carries_generated_request_id():
    r = TestClient(main.app).get("/health")
    assert re.fullmatch(r"[0-9a-f]{32}", r.headers["X-Request-Id"])


@pytest.mark.parametrize("incoming,echoed", [("railway-1234abcd", True), ("x" * 65, False), ("bad id", False),
                                             ("short", False)])
def test_incoming_request_id_is_echoed_only_when_safe(incoming, echoed):
    r = TestClient(main.app).get("/health", headers={"X-Request-Id": incoming})
    assert (r.headers["X-Request-Id"] == incoming) is echoed
    assert re.fullmatch(r"[A-Za-z0-9._-]{8,64}", r.headers["X-Request-Id"])


def test_request_id_on_413():
    big = TestClient(main.app).post("/api/individuals/check-duplicates", content=b"x" * (21 * 1024),
                                    headers={"content-type": "application/json"})
    assert big.status_code == 413 and "X-Request-Id" in big.headers


@pytest.mark.real_auth
def test_request_id_on_401():
    r = TestClient(main.app).get("/api/categories")
    assert r.status_code == 401 and "X-Request-Id" in r.headers


# --- the summary line ----------------------------------------------------------------

def test_summary_line_has_route_template_status_and_duration(caplog):
    response = TestClient(_mini_app()).get("/items/Zebulon?search=Quixley")
    line = summaries(caplog)[-1]
    assert line["msg"] == "request" and line["route"] == "/items/{item_id}"
    assert line["method"] == "GET" and line["status"] == 200 and line["duration_ms"] >= 0
    assert line["request_id"] == response.headers["X-Request-Id"]
    assert "Zebulon" not in json.dumps(line) and "Quixley" not in json.dumps(line)


def test_unmatched_path_logs_route_unmatched(caplog):
    TestClient(_mini_app()).get("/nowhere/Zebulon")
    line = summaries(caplog)[-1]
    assert line["route"] == "unmatched" and line["status"] == 404


def test_stage_timings_and_usage_land_in_the_summary(caplog):
    TestClient(_mini_app()).get("/stages")
    line = summaries(caplog)[-1]
    assert line["whisper_ms"] >= 20
    assert line["usage"] == {"extract": {"prompt_tokens": 11, "completion_tokens": 5, "total_tokens": 16}}


def test_sync_route_in_threadpool_still_records(caplog):
    TestClient(_mini_app()).get("/sync")
    assert "dup_ms" in summaries(caplog)[-1]


def test_stage_timer_and_record_usage_outside_a_request_are_noops():
    with stage_timer("whisper_ms"):
        pass
    record_usage("extract", {"total_tokens": 3})
    record_usage("extract", None)


def test_record_usage_without_usage_is_a_noop():
    with log_context() as log:
        record_usage("transcribe", "a bare transcript string")
        record_usage("extract", SimpleNamespace(usage=None))
    assert log.usage == {}


def test_unhandled_error_still_logs_a_500_summary(caplog):
    r = TestClient(_mini_app(), raise_server_exceptions=False).get("/boom")
    assert r.status_code == 500
    line = summaries(caplog)[-1]
    assert line["status"] == 500 and line["route"] == "/boom"
    assert "Quixley" not in caplog.text


def test_health_summary_is_debug_only(caplog):
    TestClient(_mini_app()).get("/health")
    TestClient(_mini_app()).get("/items/1")
    levels = {r.getMessage(): r.levelno for r in caplog.records if r.name == SUMMARY_LOGGER}
    health = [r for r in caplog.records if r.name == SUMMARY_LOGGER and r.summary.get("route") == "/health"]
    item = [r for r in caplog.records if r.name == SUMMARY_LOGGER and r.summary.get("route") == "/items/{item_id}"]
    assert health[0].levelno == logging.DEBUG and item[0].levelno == logging.INFO and levels


def test_emit_summary_rejects_unknown_fields():
    with log_context() as log, pytest.raises(ValueError):
        emit_summary("request", log, name="x")


def test_log_context_reuses_a_given_request_id():
    with log_context("job-12345678") as log:
        assert log.request_id == "job-12345678"


# --- the formatter -------------------------------------------------------------------

def test_json_formatter_never_includes_exception_text():
    try:
        raise RuntimeError("Zebulon Quixley")
    except RuntimeError:
        record = logging.LogRecord("x", logging.ERROR, __file__, 1, "failed", None, sys.exc_info())
    out = json.loads(JsonFormatter().format(record))
    assert out["exc_type"] == "RuntimeError" and "Quixley" not in json.dumps(out)
    assert out["level"] == "ERROR" and out["logger"] == "x" and out["msg"] == "failed" and out["ts"].endswith("Z")


def test_json_formatter_carries_the_current_request_id():
    with log_context("abcdefgh1234") as log:
        record = logging.LogRecord("x", logging.INFO, __file__, 1, "hello %s", ("there",), None)
        out = json.loads(JsonFormatter().format(record))
    assert out["request_id"] == log.request_id and out["msg"] == "hello there"


@pytest.mark.parametrize("log_format,is_json", [(None, True), ("text", False)])
def test_logging_is_json_by_default_and_text_on_request(log_format, is_json):
    env = {**os.environ}
    env.pop("LOG_FORMAT", None)
    if log_format:
        env["LOG_FORMAT"] = log_format
    out = subprocess.run([sys.executable, "-c", "import logging, main; logging.getLogger('x').warning('hi')"],
                         cwd=BACKEND, env=env, capture_output=True, text=True, timeout=60)
    last = out.stderr.strip().splitlines()[-1]
    if is_json:
        line = json.loads(last)
        assert line["level"] == "WARNING" and line["msg"] == "hi"
    else:
        assert "WARNING x: hi" in last
        with pytest.raises(json.JSONDecodeError):
            json.loads(last)


# --- the real routes, worker and proxy ------------------------------------------------

CATEGORIES = [
    {"id": "c1", "name": "name", "display_name": "Name", "type": "text", "is_required": True, "options": None},
]


def test_transcribe_route_reports_stage_timings(caplog):
    openai = MagicMock()
    openai.transcribe_audio = AsyncMock(return_value="Met Ann")
    openai.categorize_transcription = AsyncMock(return_value={"name": "Ann"})
    dup = MagicMock()
    dup.return_value.find_duplicates = AsyncMock(return_value=[])
    sb = FakeSupabase().on("categories", "select", data=CATEGORIES)
    with patch("api.transcription.get_openai_service", return_value=openai), \
         patch("api.transcription.get_supabase", return_value=sb), \
         patch("services.recording_pipeline.DuplicateDetectionService", dup):
        r = TestClient(main.app).post("/api/transcribe",
                                      json={"audio_url": "https://proj.supabase.co/storage/v1/object/audio/a.m4a"})
    assert r.status_code == 200, r.text
    line = [s for s in summaries(caplog) if s.get("route") == "/api/transcribe"][-1]
    assert {"whisper_ms", "extract_ms", "dup_ms"} <= line.keys()


def test_recording_job_summary_has_job_id_status_and_timings(caplog):
    from services.recording_worker import process_job
    job = {"id": "7a2d0e1f-0000-4000-8000-000000000002", "storage_path": "c.m4a", "transcription": None,
           "attempts": 1, "status": "transcribing", "location": None}
    sb = FakeSupabase()
    sb.on("recordings", "update", data=lambda c: [{**job, **c.payload}])
    sb.on("categories", "select", data=CATEGORIES)
    sb.storage.files[("recordings", "c.m4a")] = b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 64
    openai = MagicMock(transcribe_audio_file=AsyncMock(return_value="Met Ann"),
                       categorize_transcription=AsyncMock(return_value={"name": "Ann"}))
    dup = MagicMock()
    dup.return_value.find_duplicates = AsyncMock(return_value=[])
    with patch("services.recording_pipeline.DuplicateDetectionService", dup):
        asyncio.run(process_job(job, sb, openai))
    line = [s for s in summaries(caplog) if s["msg"] == "recording_job"][-1]
    assert line["job_id"] == job["id"] and line["job_status"] == "ready" and "whisper_ms" in line
    assert "duration_ms" in line


def test_realtime_session_summary_carries_usage(caplog, monkeypatch):
    upstream = FakeUpstream([{"type": "response.done", "response": {
        "id": "r1", "status": "completed", "output": [],
        "usage": {"input_tokens": 12, "output_tokens": 30, "total_tokens": 42}}}], close_after_frames=True)
    monkeypatch.setattr(main, "verify_token", lambda token: "user-ws")
    monkeypatch.setattr(main.httpx, "AsyncClient", FakeSecretClient)
    monkeypatch.setattr(main.websockets, "connect", lambda *a, **k: upstream)
    with TestClient(main.app).websocket_connect("/api/voice-assistant/realtime/ws",
                                                headers={"Authorization": "Bearer t"}) as ws:
        ws.receive_text()
        try:
            ws.receive_text()
        except Exception:
            pass
    for _ in range(100):
        lines = [s for s in summaries(caplog) if s["msg"] == "realtime_session"]
        if lines:
            break
        import time
        time.sleep(0.01)
    line = lines[-1]
    assert line["usage"]["realtime"]["total_tokens"] == 42 and "close_code" in line
