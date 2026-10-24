"""
Uploaded recordings (H2-7.2, H2-7.4). The app uploads each voice note once it has a
connection; the file goes to the private `recordings` bucket, a `recordings` row queues
the job, and the in-process worker (services/recording_worker.py) transcribes it. The
app polls GET /api/recordings/{id} until it is ready to review.

A repeated client_recording_id is the same recording: the upload is idempotent.
"""
import logging
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from postgrest.exceptions import APIError
from pydantic import ValidationError

from api.auth import get_current_user
from api.device import get_device_id
from api.errors import internal_error
from db.client import get_supabase, run_db
from db.models import (LocationData, RecordingAccepted, RecordingDetail, RecordingSummary,
                       RecordingsListResponse)
from services.rate_limit import rate_limit
from services.recording_pipeline import RECORDINGS_BUCKET, check_upload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/recordings", tags=["recordings"])

LIST_LIMIT = 50
MAX_DURATION_MS = 125_000       # 2:00 plus 5 s slack, the server's own rule (RECORDING_LIMITS)
UPLOAD_OPTIONS = {"content-type": "audio/mp4", "upsert": "true"}   # upsert: a retried upload is harmless
Status = Literal["queued", "transcribing", "extracting", "checking_duplicates", "ready", "failed"]
NOT_FOUND = "Recording not found"


def storage_path_for(client_recording_id: UUID) -> str:
    return f"{client_recording_id}.m4a"


def _location(raw: Optional[str]) -> Optional[dict]:
    """The location form field (a JSON string), checked like a save's location; 422 if bad."""
    if not raw:
        return None
    try:
        return LocationData.model_validate_json(raw).model_dump()
    except ValidationError as e:
        problem = e.errors()[0]
        field = ".".join(str(p) for p in problem.get("loc", ())) or "location"
        raise HTTPException(status_code=422, detail=f"location {field}: {problem.get('msg', 'invalid')}")


async def _by_client_id(supabase, client_recording_id: str) -> Optional[dict]:
    response = await run_db(lambda: supabase.table("recordings").select("id, user_id, status")
                            .eq("client_recording_id", client_recording_id).maybe_single().execute())
    return response.data if response else None


def _accepted(row: dict, user_id: str) -> RecordingAccepted:
    if row["user_id"] != user_id:
        raise HTTPException(status_code=409, detail="This recording id is already in use.")
    return RecordingAccepted(id=str(row["id"]), status=row["status"])


@router.post("", status_code=202, response_model=RecordingAccepted)
async def upload_recording(
    audio: UploadFile = File(...),
    client_recording_id: UUID = Form(...),
    duration_ms: int = Form(..., ge=0, le=MAX_DURATION_MS),
    location: Optional[str] = Form(None, max_length=2000),
    user_id: str = Depends(rate_limit("transcribe", "RATE_LIMIT_TRANSCRIBE_PER_MIN", 30)),
    device_id: Optional[str] = Depends(get_device_id),
):
    """Store the voice note and queue it: 202 with the job's id and status. The server
    measures the length itself (the client's duration_ms is only bounds-checked)."""
    data = await audio.read()   # main.BodySizeLimitMiddleware caps the body at 8 MB
    try:
        measured_ms = await run_db(lambda: check_upload(data))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    place = _location(location)
    crid = str(client_recording_id)
    supabase = get_supabase()
    try:
        existing = await _by_client_id(supabase, crid)
        if existing:
            return _accepted(existing, user_id)
        path = storage_path_for(client_recording_id)
        bucket = supabase.storage.from_(RECORDINGS_BUCKET)
        await run_db(lambda: bucket.upload(path, data, file_options=UPLOAD_OPTIONS))
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Recording upload", e)
    row = {"user_id": user_id, "device_id": device_id, "client_recording_id": crid, "status": "queued",
           "storage_path": path, "duration_ms": measured_ms, "location": place}
    try:
        inserted = await run_db(lambda: supabase.table("recordings").insert(row).execute())
    except APIError as e:
        if e.code == "23505":
            # The same upload raced this one and won: answer with its row
            winner = await _by_client_id(supabase, crid)
            if winner:
                return _accepted(winner, user_id)
        await _remove_quietly(bucket, path)
        raise internal_error("Recording upload", e)
    except Exception as e:
        await _remove_quietly(bucket, path)
        raise internal_error("Recording upload", e)
    created = inserted.data[0]
    logger.info("Recording %s queued", created["id"])
    return RecordingAccepted(id=str(created["id"]), status=created.get("status", "queued"))


async def _remove_quietly(bucket, path: str) -> None:
    try:
        await run_db(lambda: bucket.remove([path]))
    except Exception as e:
        logger.warning("Could not remove an orphaned recording file: %s", type(e).__name__)


async def _owned(supabase, recording_id: UUID, user_id: str) -> dict:
    response = await run_db(lambda: supabase.table("recordings").select("*")
                            .eq("id", str(recording_id)).eq("user_id", user_id).maybe_single().execute())
    if not response or not response.data:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return response.data


@router.get("/{recording_id}", response_model=RecordingDetail)
async def get_recording(recording_id: UUID, user_id: str = Depends(get_current_user)):
    """The job's status, and its stored result once it is ready."""
    try:
        row = await _owned(get_supabase(), recording_id, user_id)
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Get recording", e)
    return RecordingDetail(id=str(row["id"]), status=row["status"], error=row.get("error"),
                           result=row.get("result") if row["status"] == "ready" else None,
                           location=row.get("location"), duration_ms=row.get("duration_ms"),
                           created_at=str(row["created_at"]))


@router.get("", response_model=RecordingsListResponse)
async def list_recordings(
    status: Optional[Status] = Query(None),
    user_id: str = Depends(get_current_user),
    device_id: Optional[str] = Depends(get_device_id),
):
    """The caller's recordings, newest first (this phone's only, when it sends X-Device-Id)."""
    supabase = get_supabase()

    def query():
        q = supabase.table("recordings").select("id, status, error, result, duration_ms, created_at") \
            .eq("user_id", user_id)
        if device_id:
            q = q.eq("device_id", device_id)
        if status:
            q = q.eq("status", status)
        return q.order("created_at", desc=True).limit(LIST_LIMIT).execute()
    try:
        rows = (await run_db(query)).data or []
    except Exception as e:
        raise internal_error("List recordings", e)
    return RecordingsListResponse(recordings=[
        RecordingSummary(id=str(r["id"]), status=r["status"], error=r.get("error"),
                         name=((r.get("result") or {}).get("categorized_data") or {}).get("name"),
                         duration_ms=r.get("duration_ms"), created_at=str(r["created_at"]))
        for r in rows
    ])


@router.delete("/{recording_id}", status_code=204)
async def delete_recording(recording_id: UUID, user_id: str = Depends(get_current_user)):
    """Saved or discarded: the stored file goes first, then the row (a failed file
    removal keeps the row, so it can be retried)."""
    supabase = get_supabase()
    try:
        row = await _owned(supabase, recording_id, user_id)
        if row.get("storage_path"):
            bucket = supabase.storage.from_(RECORDINGS_BUCKET)
            await run_db(lambda: bucket.remove([row["storage_path"]]))
        await run_db(lambda: supabase.table("recordings").delete()
                     .eq("id", str(recording_id)).eq("user_id", user_id).execute())
    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Delete recording", e)
    return Response(status_code=204)
