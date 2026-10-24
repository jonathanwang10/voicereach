"""The in-process recordings worker (H2-7.3, H2-7.8): claim, run the shared stages, store
the result; retry transient failures; purge after 7 days. No test sleeps."""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from db.models import TranscribeResponse
from services import recording_worker
from services.recording_worker import (GENERIC_FAILURE, POLL_SECONDS, process_job, purge_once, run_once,
                                       start_workers, stop_workers, worker_concurrency, worker_enabled,
                                       worker_loop)
from tests.helpers import FakeSupabase

M4A = b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 64
CRID = "6f1c0d1e-0000-4000-8000-000000000001"
RID = "7a2d0e1f-0000-4000-8000-000000000002"
JOB = {"id": RID, "storage_path": f"{CRID}.m4a", "transcription": None, "attempts": 1, "status": "transcribing",
       "location": None}
MATCH = {"id": "550e8400-e29b-41d4-a716-446655440001", "name": "Ann Lee", "confidence": 90}
CATEGORIES = [
    {"id": "c1", "name": "name", "display_name": "Name", "type": "text", "is_required": True, "options": None},
    {"id": "c2", "name": "height", "display_name": "Height", "type": "number", "is_required": True, "options": None},
    {"id": "c3", "name": "weight", "display_name": "Weight", "type": "number", "is_required": True, "options": None},
]


@pytest.fixture
def sb():
    fake = FakeSupabase()
    fake.on("recordings", "update", data=lambda c: [{**JOB, **c.payload}])
    fake.on("categories", "select", data=CATEGORIES)
    fake.storage.files[("recordings", JOB["storage_path"])] = M4A
    return fake


@pytest.fixture
def openai():
    return MagicMock(transcribe_audio_file=AsyncMock(return_value="Met Ann"),
                     categorize_transcription=AsyncMock(return_value={"name": "Ann"}))


@pytest.fixture(autouse=True)
def duplicates():
    with patch("services.recording_pipeline.DuplicateDetectionService") as dup:
        dup.return_value.find_duplicates = AsyncMock(return_value=[MATCH])
        yield dup.return_value.find_duplicates


# --- run_once / process_job ------------------------------------------------------------

def test_run_once_is_false_when_no_job_is_claimed():
    fake = FakeSupabase()
    fake.on_rpc("claim_recording_job", data=[])
    assert asyncio.run(run_once(fake, MagicMock())) is False
    assert fake.rpc_params("claim_recording_job") == [{}]


def test_run_once_processes_the_claimed_job(sb, openai):
    sb.on_rpc("claim_recording_job", data=[dict(JOB)])
    assert asyncio.run(run_once(sb, openai)) is True
    assert sb.payloads("recordings", "update")[-1]["status"] == "ready"


def test_a_job_runs_every_stage_and_stores_the_transcribe_response(sb, openai, duplicates):
    asyncio.run(process_job(dict(JOB), sb, openai))
    expected = TranscribeResponse(transcription="Met Ann", categorized_data={"name": "Ann"},
                                  missing_required=["height", "weight"], potential_matches=[MATCH]).model_dump()
    assert sb.payloads("recordings", "update") == [
        {"transcription": "Met Ann", "status": "extracting"},
        {"storage_path": None},
        {"status": "checking_duplicates"},
        {"status": "ready", "result": expected, "error": None},
    ]
    assert [c[1] for c in sb.storage.calls] == ["download", "remove"]
    assert ("recordings", JOB["storage_path"]) not in sb.storage.files
    assert all(u.mod("eq") == (("id", RID), {}) for u in sb.calls_to("recordings", "update"))


def test_the_duplicate_check_gets_the_categories_and_the_recordings_location(sb, openai, duplicates):
    loc = {"latitude": 37.78, "longitude": -122.41, "address": "Market St"}
    asyncio.run(process_job({**JOB, "location": loc}, sb, openai))
    kwargs = duplicates.await_args.kwargs
    assert kwargs["location"] == loc and [c["name"] for c in kwargs["categories"]] == ["name", "height", "weight"]


def test_a_retry_after_transcription_skips_whisper_and_the_download(sb, openai):
    asyncio.run(process_job({**JOB, "transcription": "Met Ann", "storage_path": None}, sb, openai))
    openai.transcribe_audio_file.assert_not_called()
    assert sb.storage.calls == []
    assert sb.payloads("recordings", "update")[0] == {"status": "checking_duplicates"}


def test_a_client_error_fails_the_job_with_its_message(sb, openai):
    openai.transcribe_audio_file.side_effect = ValueError("Audio must be at least 5 seconds long")
    asyncio.run(process_job(dict(JOB), sb, openai))
    assert sb.payloads("recordings", "update") == [{"status": "failed", "error": "Audio must be at least 5 seconds long"}]


@pytest.mark.parametrize("attempts,expected", [(1, {"status": "queued"}), (2, {"status": "queued"}),
                                               (3, {"status": "failed", "error": GENERIC_FAILURE})])
def test_a_transient_error_requeues_until_the_third_attempt(sb, openai, attempts, expected):
    openai.categorize_transcription.side_effect = RuntimeError("upstream 503")
    asyncio.run(process_job({**JOB, "attempts": attempts}, sb, openai))
    assert sb.payloads("recordings", "update")[-1] == expected


def test_a_missing_stored_file_is_transient(openai):
    fake = FakeSupabase()
    fake.on("recordings", "update", data=lambda c: [{**JOB, **c.payload}])
    asyncio.run(process_job(dict(JOB), fake, openai))       # nothing in storage
    assert fake.payloads("recordings", "update") == [{"status": "queued"}]


def test_a_job_deleted_mid_run_stops_quietly(openai):
    fake = FakeSupabase()
    fake.on("recordings", "update", data=[])          # the row is gone
    fake.storage.files[("recordings", JOB["storage_path"])] = M4A
    asyncio.run(process_job(dict(JOB), fake, openai))
    openai.categorize_transcription.assert_not_called()
    assert len(fake.calls_to("recordings", "update")) == 1                 # no failure write either


def test_a_failed_duplicate_check_still_reaches_ready_with_the_flag(sb, openai, duplicates):
    duplicates.side_effect = RuntimeError("db down")
    asyncio.run(process_job(dict(JOB), sb, openai))
    last = sb.payloads("recordings", "update")[-1]
    assert last["status"] == "ready" and last["result"]["duplicate_check_failed"] is True


def test_a_failed_failure_write_does_not_raise(openai):
    fake = FakeSupabase()
    fake.on("recordings", "update", error=RuntimeError("db down"))
    fake.storage.files[("recordings", JOB["storage_path"])] = M4A
    asyncio.run(process_job(dict(JOB), fake, openai))       # never raises


# --- loops ---------------------------------------------------------------------------

def test_worker_loop_sleeps_2s_only_when_idle():
    results, sleeps, stop = iter([True, False, False]), [], asyncio.Event()

    async def fake_run_once():
        return next(results)

    async def fake_sleep(s):
        sleeps.append(s)
        if len(sleeps) == 2:
            stop.set()
    asyncio.run(worker_loop(stop, run_once=fake_run_once, sleep=fake_sleep))
    assert sleeps == [2.0, 2.0] and POLL_SECONDS == 2.0


def test_worker_loop_survives_a_claim_error():
    calls, stop = [], asyncio.Event()

    async def boom():
        calls.append(1)
        raise RuntimeError("db down")

    async def fake_sleep(s):
        stop.set()
    asyncio.run(worker_loop(stop, run_once=boom, sleep=fake_sleep))
    assert calls == [1]


def test_start_workers_runs_the_configured_number_of_loops_plus_the_purge(monkeypatch):
    monkeypatch.setenv("RECORDING_WORKER_CONCURRENCY", "3")
    started = []

    async def fake_loop(stop, **_kw):
        started.append("loop")
        await stop.wait()
    monkeypatch.setattr(recording_worker, "worker_loop", fake_loop)
    monkeypatch.setattr(recording_worker, "purge_loop", fake_loop)

    async def run():
        stop, tasks = start_workers()
        await asyncio.sleep(0)
        assert len(tasks) == 4
        await stop_workers(stop, tasks)
        return tasks
    tasks = asyncio.run(run())
    assert started == ["loop"] * 4 and all(t.done() for t in tasks)


def test_stop_workers_swallows_a_task_error():
    async def run():
        async def bad():
            raise RuntimeError("boom")
        task = asyncio.create_task(bad())
        await asyncio.sleep(0)
        await stop_workers(asyncio.Event(), [task])
    asyncio.run(run())


@pytest.mark.parametrize("value", ["", "0", "abc", "-2"])
def test_worker_concurrency_defaults_to_2(monkeypatch, value):
    monkeypatch.setenv("RECORDING_WORKER_CONCURRENCY", value)
    assert worker_concurrency() == 2


def test_worker_enabled_unless_0(monkeypatch):
    monkeypatch.delenv("RECORDING_WORKER_ENABLED", raising=False)
    assert worker_enabled() is True
    monkeypatch.setenv("RECORDING_WORKER_ENABLED", "0")
    assert worker_enabled() is False


def test_purge_once_removes_the_stored_files_of_purged_rows():
    fake = FakeSupabase()
    fake.on_rpc("purge_old_recordings", data=["a.m4a", None, "b.m4a"])
    assert asyncio.run(purge_once(fake)) == 3
    assert fake.storage.calls == [("recordings", "remove", ["a.m4a", "b.m4a"], None)]
    assert fake.rpc_params("purge_old_recordings") == [{"p_days": 7}]


def test_purge_once_with_nothing_old_touches_no_storage():
    fake = FakeSupabase()
    fake.on_rpc("purge_old_recordings", data=[])
    assert asyncio.run(purge_once(fake)) == 0
    assert fake.storage.calls == []


def test_purge_loop_runs_hourly_and_survives_an_error():
    calls, sleeps, stop = [], [], asyncio.Event()

    async def flaky():
        calls.append(1)
        raise RuntimeError("db down")

    async def fake_sleep(s):
        sleeps.append(s)
        if len(sleeps) == 2:
            stop.set()
    asyncio.run(recording_worker.purge_loop(stop, purge_once=flaky, sleep=fake_sleep))
    assert calls == [1, 1] and sleeps == [3600.0, 3600.0]


# --- lifespan ------------------------------------------------------------------------

def test_lifespan_starts_and_stops_the_worker(monkeypatch):
    import main
    monkeypatch.setenv("RECORDING_WORKER_ENABLED", "1")
    started, stopped = [], []
    monkeypatch.setattr(main, "start_workers", lambda: started.append(1) or ("stop", ["t"]))

    async def fake_stop(stop, tasks):
        stopped.append((stop, tasks))
    monkeypatch.setattr(main, "stop_workers", fake_stop)
    with TestClient(main.app):
        assert started == [1]
    assert stopped == [("stop", ["t"])]


def test_lifespan_leaves_the_worker_off_when_disabled(monkeypatch):
    import main
    monkeypatch.setenv("RECORDING_WORKER_ENABLED", "0")
    started = []
    monkeypatch.setattr(main, "start_workers", lambda: started.append(1) or ("stop", []))
    with TestClient(main.app):
        pass
    assert started == []
