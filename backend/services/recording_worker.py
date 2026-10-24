"""
The recordings worker (H2-7.3): asyncio loops in the API process (started by the
FastAPI lifespan in main.py). Postgres is the queue: each loop claims one job with
claim_recording_job() (FOR UPDATE SKIP LOCKED) and runs the same stage functions as
POST /api/transcribe. One more loop purges recordings older than 7 days (H2-7.8).
No Redis, no Celery: one process, on purpose.

Logs carry recording ids and exception types only, never a transcript or a field.
"""
import asyncio
import logging
import os
import time
from typing import Optional

from pydantic import ValidationError

from db.client import get_supabase, run_db
from services.openai_service import get_openai_service, temp_audio_file
from services.request_log import emit_summary, log_context
from services.recording_pipeline import (RECORDINGS_BUCKET, build_transcribe_response, duplicate_stage,
                                         extract_stage, load_categories, transcribe_stage)

logger = logging.getLogger(__name__)

POLL_SECONDS = 2.0
PURGE_INTERVAL_SECONDS = 3600.0
PURGE_DAYS = 7
MAX_ATTEMPTS = 3
DEFAULT_CONCURRENCY = 2
GENERIC_FAILURE = "Processing failed. Please record again."


def worker_concurrency() -> int:
    """RECORDING_WORKER_CONCURRENCY (default 2); a bad or < 1 value uses the default."""
    try:
        value = int(os.getenv("RECORDING_WORKER_CONCURRENCY", ""))
    except ValueError:
        return DEFAULT_CONCURRENCY
    return value if value >= 1 else DEFAULT_CONCURRENCY


def worker_enabled() -> bool:
    """On unless RECORDING_WORKER_ENABLED=0 (tests set it to 0)."""
    return os.getenv("RECORDING_WORKER_ENABLED", "1") != "0"


class _Gone(Exception):
    """The row was deleted (the draft discarded) while the job ran."""


async def _write(supabase, job_id: str, fields: dict) -> None:
    response = await run_db(lambda: supabase.table("recordings").update(fields).eq("id", job_id).execute())
    if not response.data:
        raise _Gone()


async def _transcribe(job: dict, supabase, openai_service) -> str:
    bucket = supabase.storage.from_(RECORDINGS_BUCKET)
    audio = await run_db(lambda: bucket.download(job["storage_path"]))
    with temp_audio_file(audio) as path:
        transcription = await transcribe_stage(path, openai_service)
    # Saved first, so a retry never pays for Whisper again
    await _write(supabase, job["id"], {"transcription": transcription, "status": "extracting"})
    # No later stage needs the audio: less of it at rest (Deviation 4)
    try:
        await run_db(lambda: bucket.remove([job["storage_path"]]))
    except Exception as e:
        logger.warning("Recording job %s: could not remove its audio: %s", job["id"], type(e).__name__)
    await _write(supabase, job["id"], {"storage_path": None})
    return transcription


async def process_job(job: dict, supabase, openai_service) -> None:
    """Run one claimed job to "ready", "queued" (a transient failure, retried later) or
    "failed". Never raises, except CancelledError. Ends with one summary line: the job
    id, its status, the stage timings and the token usage (H2-8.1)."""
    started = time.monotonic()
    with log_context() as log:
        status = await _run_job(job, supabase, openai_service)
        emit_summary("recording_job", log, job_id=str(job["id"]), job_status=status,
                     duration_ms=int((time.monotonic() - started) * 1000))


async def _run_job(job: dict, supabase, openai_service) -> str:
    """The job's final status (the row's, as written)."""
    job_id = job["id"]
    try:
        transcription = job.get("transcription")
        if transcription is None:
            transcription = await _transcribe(job, supabase, openai_service)
        categories = await load_categories(supabase)
        validation = await extract_stage(transcription, categories, openai_service)
        await _write(supabase, job_id, {"status": "checking_duplicates"})
        matches, check_failed = await duplicate_stage(validation.normalized_data, supabase, openai_service,
                                                      categories=categories, location=job.get("location"))
        response = build_transcribe_response(transcription, validation, matches, check_failed)
        await _write(supabase, job_id, {"status": "ready", "result": response.model_dump(), "error": None})
        return "ready"
    except asyncio.CancelledError:
        raise   # shutdown: the job stays in progress and the 5-minute rule reclaims it
    except _Gone:
        logger.info("Recording job %s was deleted while it ran", job_id)
        return "deleted"
    except Exception as e:
        logger.warning("Recording job %s failed: %s", job_id, type(e).__name__)
        return await _record_failure(supabase, job, e)


async def _record_failure(supabase, job: dict, error: Exception) -> str:
    if isinstance(error, ValueError) and not isinstance(error, ValidationError):
        # The client-safe audio messages ("Audio must be at least 5 seconds long")
        fields = {"status": "failed", "error": str(error)}
    elif (job.get("attempts") or 0) < MAX_ATTEMPTS:
        fields = {"status": "queued"}   # claimable again after attempts * 30 s
    else:
        fields = {"status": "failed", "error": GENERIC_FAILURE}
    try:
        await _write(supabase, job["id"], fields)
    except _Gone:
        return "deleted"
    except Exception as e:
        # The row goes stale and is reclaimed after 5 minutes
        logger.warning("Recording job %s: could not record its failure: %s", job["id"], type(e).__name__)
        return "unrecorded"
    return fields["status"]


async def run_once(supabase=None, openai_service=None) -> bool:
    """Claim and run one job; False when there is none."""
    supabase = supabase or get_supabase()
    rows = (await run_db(lambda: supabase.rpc("claim_recording_job", {}).execute())).data or []
    if not rows:
        return False
    await process_job(rows[0], supabase, openai_service or get_openai_service())
    return True


async def worker_loop(stop: asyncio.Event, *, run_once=run_once, sleep=asyncio.sleep,
                      poll_seconds: float = POLL_SECONDS) -> None:
    """Claim jobs until stopped; the next one at once after a job, else after a pause."""
    while not stop.is_set():
        try:
            did = await run_once()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning("Recording worker could not claim a job: %s", type(e).__name__)
            did = False
        if not did:
            await sleep(poll_seconds)


async def purge_once(supabase=None) -> int:
    """Delete recordings older than PURGE_DAYS and remove their stored files; the
    number of rows purged."""
    supabase = supabase or get_supabase()
    paths = (await run_db(lambda: supabase.rpc("purge_old_recordings", {"p_days": PURGE_DAYS}).execute())).data or []
    files = [p for p in paths if p]
    if files:
        bucket = supabase.storage.from_(RECORDINGS_BUCKET)
        await run_db(lambda: bucket.remove(files))
    if paths:
        logger.info("Purged %d old recording(s)", len(paths))
    return len(paths)


async def purge_loop(stop: asyncio.Event, *, purge_once=purge_once, sleep=asyncio.sleep,
                     interval: float = PURGE_INTERVAL_SECONDS) -> None:
    while not stop.is_set():
        try:
            await purge_once()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning("Recording purge failed: %s", type(e).__name__)
        await sleep(interval)


def start_workers(concurrency: Optional[int] = None) -> tuple[asyncio.Event, list[asyncio.Task]]:
    """`concurrency` worker loops (RECORDING_WORKER_CONCURRENCY) plus one purge loop."""
    stop = asyncio.Event()
    count = concurrency or worker_concurrency()
    tasks = [asyncio.create_task(worker_loop(stop)) for _ in range(count)]
    tasks.append(asyncio.create_task(purge_loop(stop)))
    logger.info("Recording worker started with %d loop(s)", count)
    return stop, tasks


async def stop_workers(stop: asyncio.Event, tasks: list[asyncio.Task]) -> None:
    """Stop and wait for every loop; their errors (CancelledError included) are swallowed."""
    stop.set()
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
