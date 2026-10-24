"""
The transcription pipeline as stage functions (H2-7.3). POST /api/transcribe and the
recordings worker run the same code: categories, transcribe, extract and validate,
duplicate check, response.
"""
import logging

from db.client import run_db
from db.models import TranscribeResponse
from services.duplicate_detection_service import DuplicateDetectionService
from services.openai_service import RECORDING_LIMITS, check_audio_duration, temp_audio_file
from services.validation_helper import ValidationResult, validate_categorized_data

logger = logging.getLogger(__name__)

NO_CATEGORIES = "No categories found in database. Please ensure categories are properly configured."


class NoCategories(RuntimeError):
    """The categories table is empty: nothing to extract into."""

    def __init__(self):
        super().__init__(NO_CATEGORIES)


async def load_categories(supabase) -> list[dict]:
    """The categories as the extractor takes them, oldest first."""
    response = await run_db(lambda: supabase.table("categories").select("*").order("created_at").execute())
    if not response.data:
        raise NoCategories()
    return [
        {
            "name": cat["name"],
            "display_name": cat.get("display_name"),   # the schema's field descriptions
            "type": cat["type"],
            "is_required": cat["is_required"],
            "is_sensitive": cat.get("is_sensitive", False),   # kept out of the compare prompt (H2-3.8)
            "options": cat.get("options", None),
        }
        for cat in response.data
    ]


def check_upload(data: bytes) -> int:
    """An uploaded recording's length in ms; ValueError with the client message when it
    isn't an M4A or is under 5 s / over 125 s. File I/O: call it inside run_db."""
    if b"ftyp" not in data[:12]:
        raise ValueError("File is not in M4A format")
    with temp_audio_file(data) as path:
        seconds = check_audio_duration(path, RECORDING_LIMITS)
    return int(round(seconds * 1000))


async def transcribe_stage(audio_path: str, openai_service) -> str:
    """The transcript; transcribe_audio_file checks the format and length first (P1)."""
    return await openai_service.transcribe_audio_file(audio_path)


async def extract_stage(transcription: str, categories: list[dict], openai_service) -> ValidationResult:
    """Fields from the transcript, normalised and validated. From here on only the
    normalised dict is used (no None / "" values, canonical labels)."""
    categorized = await openai_service.categorize_transcription(transcription, categories)
    return validate_categorized_data(categorized, categories)


async def duplicate_stage(categorized_data: dict, supabase, openai_service, *,
                          categories: list[dict] | None = None,
                          location: dict | None = None) -> tuple[list[dict], bool]:
    """(matches, duplicate_check_failed). A failure doesn't fail the transcription, but it
    is reported, never shown as "no match" (C-08)."""
    try:
        matches = await DuplicateDetectionService(supabase, openai_service).find_duplicates(
            categorized_data, categories=categories, location=location)
        return matches, False
    except Exception as e:
        logger.warning("Duplicate detection failed: %s", type(e).__name__)
        return [], True


def build_transcribe_response(transcription: str, validation: ValidationResult, matches: list[dict],
                              duplicate_check_failed: bool) -> TranscribeResponse:
    return TranscribeResponse(
        transcription=transcription,
        categorized_data=validation.normalized_data,
        missing_required=validation.missing_required,
        potential_matches=matches,
        validation_errors=validation.validation_errors,
        duplicate_check_failed=duplicate_check_failed,
    )
