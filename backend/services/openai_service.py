"""
OpenAI API integration for Whisper transcription and GPT-4o categorization
"""
import logging
import os
import httpx
import tempfile
import json
import re
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator, Optional, Dict
import mutagen
import mutagen.mp4
import openai
from openai import AsyncOpenAI
from urllib.parse import urlparse

from services import model_config
from services.field_registry import category_key, parse_height_inches

logger = logging.getLogger(__name__)


# Fail fast instead of the SDK defaults (600 s read, 2 retries). GPT calls get 30 s
# and one retry (60 s worst case each); Whisper gets 60 s and NO retry, because a
# second 60 s attempt would outlast the app. /api/transcribe chains Whisper (60),
# categorisation (60) and the duplicate comparison (60): up to ~180 s of OpenAI time,
# so the route also has its own deadline (api/transcription.TRANSCRIBE_DEADLINE_SECONDS,
# 110 s) and answers 504 before the app's 120 s timeout gives up.
OPENAI_TIMEOUT_SECONDS = 30
WHISPER_TIMEOUT_SECONDS = 60
MAX_AUDIO_DOWNLOAD_BYTES = 5 * 1024 * 1024


class AudioTooLarge(ValueError):
    """The audio is over a size cap; routes answer 413."""


@dataclass(frozen=True)
class AudioLimits:
    """Allowed length of one upload, with the client message for each side (H2-1.10)."""
    min_seconds: float
    max_seconds: float
    too_short: str
    too_long: str


# A recording is 5 s to 2:00 in the app; 5 s of slack covers the encoder's padding.
RECORDING_LIMITS = AudioLimits(5, 125, "Audio must be at least 5 seconds long", "Audio must be less than 2 minutes")
# Assistant questions are short and have their own lower minimum.
QUESTION_LIMITS = AudioLimits(1, 60, "Question must be at least 1 second long", "Question must be under 1 minute")


def audio_duration_seconds(path: str) -> float:
    """The M4A's length from its header. A file mutagen can't parse (truncated, or an
    `ftyp` box that isn't audio) is "not in M4A format", a 400, never a 500."""
    try:
        return float(mutagen.mp4.MP4(path).info.length)
    except mutagen.MutagenError:
        raise ValueError("File is not in M4A format")


def check_audio_duration(path: str, limits: AudioLimits) -> float:
    """The server's own length check, so a client can't skip the app's limits (H2-1.10).
    Raises ValueError with the client message; returns the duration."""
    seconds = audio_duration_seconds(path)
    if seconds < limits.min_seconds:
        raise ValueError(limits.too_short)
    if seconds > limits.max_seconds:
        raise ValueError(limits.too_long)
    return seconds


@contextmanager
def temp_audio_file(data: bytes, suffix: str = ".m4a") -> Iterator[str]:
    """Write `data` to a temp file and yield its path; the file is removed on every path,
    including a failed write (C-65)."""
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        yield path
    finally:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


def whisper_client_message(exc: Exception, limits: AudioLimits) -> Optional[str]:
    """The client message for a Whisper duration rejection, by the API's error code
    (not its message text, which can change), or None for any other error (H2-1.9)."""
    if isinstance(exc, openai.BadRequestError):
        if exc.code == "audio_too_short":
            return limits.too_short
        if exc.code == "audio_too_long":
            return limits.too_long
    return None


def _supabase_host() -> str:
    return (urlparse(os.getenv("SUPABASE_URL") or "").hostname or "").lower()


class OpenAIService:
    def __init__(self):
        self.client = AsyncOpenAI(
            api_key=os.getenv("OPENAI_API_KEY"),
            timeout=OPENAI_TIMEOUT_SECONDS,
            max_retries=1,
        )
        self.whisper_client = self.client.with_options(
            timeout=WHISPER_TIMEOUT_SECONDS, max_retries=0
        )

    async def _whisper(self, file_path: str) -> str:
        with open(file_path, "rb") as audio_file:
            transcript = await self.whisper_client.audio.transcriptions.create(
                model=model_config.TRANSCRIBE_MODEL,
                file=audio_file,
                response_format="text",
                timeout=WHISPER_TIMEOUT_SECONDS,
            )
        return transcript.strip()

    async def _download_audio(self, audio_url: str) -> bytes:
        """Stream the file, stopping at MAX_AUDIO_DOWNLOAD_BYTES. No redirects."""
        chunks, size = [], 0
        async with httpx.AsyncClient() as client:
            try:
                async with client.stream("GET", audio_url, timeout=30.0, follow_redirects=False) as response:
                    response.raise_for_status()
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > MAX_AUDIO_DOWNLOAD_BYTES:
                            raise AudioTooLarge("Audio file is larger than 5 MB")
                        chunks.append(chunk)
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    raise ValueError("Audio file not found")
                raise Exception(f"Failed to download audio: HTTP {e.response.status_code}")
            except httpx.TimeoutException:
                raise Exception("Network timeout while downloading audio")
        return b"".join(chunks)

    async def transcribe_audio(self, audio_url: str, limits: AudioLimits = RECORDING_LIMITS) -> str:
        """
        Transcribe audio from a Supabase Storage URL using OpenAI Whisper API.

        The URL must be http(s) on the SAME host as SUPABASE_URL (not any
        *.supabase.co project), and the download stops at 5 MB (C-12).

        Raises:
            AudioTooLarge: the file is over 5 MB
            ValueError: invalid URL, wrong host, missing file or wrong format
            Exception: for API or network errors
        """
        parsed = urlparse(audio_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("Invalid URL format")
        host = (parsed.hostname or "").lower()
        if not host or host != _supabase_host():
            raise ValueError("URL must be from this project's Supabase Storage")

        content = await self._download_audio(audio_url)
        if b'ftyp' not in content[:12]:
            raise ValueError("File is not in M4A format")

        with temp_audio_file(content) as tmp_path:
            check_audio_duration(tmp_path, limits)
            try:
                return await self._whisper(tmp_path)
            except openai.BadRequestError as e:
                message = whisper_client_message(e, limits)
                if message:
                    raise ValueError(message) from e
                raise

    async def transcribe_audio_file(self, file_path: str, limits: AudioLimits = RECORDING_LIMITS) -> str:
        """
        Transcribe audio from local file using OpenAI Whisper API
        
        Args:
            file_path: Path to local M4A audio file
            limits: allowed length (RECORDING_LIMITS, or QUESTION_LIMITS for the assistant)
            
        Returns:
            Plain text transcription
            
        Raises:
            ValueError: For invalid file format or duration issues
            Exception: For API or network errors
        """
        # Validate file exists
        if not os.path.exists(file_path):
            raise ValueError("Audio file not found")

        # Validate file format (basic check for M4A header)
        with open(file_path, 'rb') as f:
            header = f.read(12)
            # M4A files typically have 'ftyp' at offset 4
            if b'ftyp' not in header:
                raise ValueError("File is not in M4A format")

        check_audio_duration(file_path, limits)

        # Send to Whisper API
        try:
            return await self._whisper(file_path)
        except openai.BadRequestError as e:
            message = whisper_client_message(e, limits)
            if message:
                raise ValueError(message) from e
            raise
                
    async def categorize_transcription(self, transcription: str, categories: list) -> dict:
        """
        Extract structured data from transcription using GPT-4o
        
        Args:
            transcription: Plain text transcription from Whisper
            categories: List of category definitions from database
            
        Returns:
            Dict with extracted data for each category
            
        Raises:
            Exception: For API errors or invalid responses
        """
        # Build dynamic prompt with all categories
        category_lines = []
        for cat in categories:
            line = f"- {cat['name']} ({cat['type']}"
            
            # Add options for select types
            if cat['type'] == 'single_select' and cat.get('options'):
                options_str = ", ".join([opt['label'] for opt in cat['options']])
                line += f": {options_str}"
            elif cat['type'] == 'multi_select' and cat.get('options'):
                options_str = ", ".join(cat['options'])
                line += f": {options_str}"
                
            # Add required flag
            if cat.get('is_required'):
                line += ", required"
                
            line += ")"
            category_lines.append(line)
            
        categories_text = "\n".join(category_lines)
        
        # Build the prompt following PRD format exactly
        prompt = f"""Extract information from this transcription into these categories:
{categories_text}

Rules:
- For multi-select, return array of matching options
- For single-select, return one option from the available choices
- For numbers, extract digits only
- Always attempt to extract required fields: Name, Height, Weight
- Return null for missing non-required information
- Be conservative - only extract explicitly stated info
- Please be attentive to medical conditions. Although the term medical conditions is not explicitly stated, it may be implied in the transcription and there may be multiple. Please be meticulous and extract all of them in a list.
- For height, convert to total inches (e.g., "6 feet" = 72, "5'4\"" = 64)

Transcription: {transcription}

Return JSON only."""

        try:
            # Call GPT-4o API
            response = await self.client.chat.completions.create(
                model=model_config.CHAT_MODEL,
                messages=[
                    {"role": "system", "content": "You are a data extraction assistant. Extract only explicitly stated information from transcriptions. Return valid JSON only."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.3,  # Lower temperature for more consistent extraction
                response_format={"type": "json_object"}  # Force JSON response
            )
            
            # Parse JSON response
            result = response.choices[0].message.content
            extracted_data = json.loads(result) if isinstance(result, str) else result
            if not isinstance(extracted_data, dict):
                extracted_data = {}

            # GPT may change a key's case or spacing ("Name", "Housing Status"),
            # so match keys on category_key, not exact spelling (C-67).
            extracted_by_key = {}
            for key, val in extracted_data.items():
                ckey = category_key(key)
                if ckey not in extracted_by_key or extracted_by_key[ckey] is None:
                    extracted_by_key[ckey] = val

            # Post-process the data. The caller still runs the shared normaliser
            # (validate_categorized_data) on this output.
            processed_data = {}
            for cat in categories:
                field_name = cat['name']
                value = extracted_by_key.get(category_key(field_name))

                # Handle different field types
                if value is not None:
                    if cat['type'] == 'number':
                        if category_key(field_name) == 'height':
                            # GPT sometimes answers in feet (6 or 5.5). Convert that here,
                            # where the value first enters; the shared parser treats an
                            # int/float as inches so later normalising passes stay idempotent.
                            if isinstance(value, (int, float)) and not isinstance(value, bool) and 1 <= value < 10:
                                value = value * 12
                            value = parse_height_inches(value)
                        # Ensure it's a number
                        try:
                            value = float(value) if value is not None else None
                        except (ValueError, TypeError):
                            value = None
                            
                    elif cat['type'] == 'single_select':
                        # Validate against available options
                        if cat.get('options'):
                            valid_labels = [opt['label'] for opt in cat['options']]
                            if value not in valid_labels:
                                # Try case-insensitive match
                                for label in valid_labels:
                                    if label.lower() == str(value).lower():
                                        value = label
                                        break
                                else:
                                    value = None
                                    
                    elif cat['type'] == 'multi_select':
                        # Ensure it's a list; "Diabetes, Cancer" is two items
                        if isinstance(value, str):
                            value = [v.strip() for v in value.split(',') if v.strip()]
                        elif not isinstance(value, list):
                            value = [value] if value else []
                        # Validate against available options
                        if cat.get('options'):
                            canonical = {str(o).lower(): o for o in cat['options']}
                            value = [canonical[str(v).lower()] for v in value if str(v).lower() in canonical]
                            
                processed_data[field_name] = value
                
            return processed_data
            
        except Exception as e:
            raise Exception(f"Failed to categorize transcription: {str(e)}")
            
    def _parse_height(self, height_str: str) -> Optional[float]:
        """Parse a height to inches (delegates to the shared field_registry parser)."""
        return parse_height_inches(height_str)
    
    async def compare_individuals(self, comparison_prompt: str) -> Dict[str, int]:
        """
        Compare individuals using a custom prompt and return confidence scores

        Args:
            comparison_prompt: Formatted prompt for GPT-4o comparison

        Returns:
            Dictionary mapping individual IDs to confidence scores (0-100)
            Example: {"id1": 95, "id2": 73, "id3": 45}
        """
        try:
            # Call GPT-4o with the comparison prompt
            response = await self.client.chat.completions.create(
                model=model_config.CHAT_MODEL,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a data comparison assistant. Compare individuals and return JSON with confidence scores."
                    },
                    {"role": "user", "content": comparison_prompt}
                ],
                temperature=0.3,  # Lower temperature for consistent scoring
                response_format={"type": "json_object"}  # Force JSON response
            )

            # Parse JSON response
            result = response.choices[0].message.content

            # Try to parse as JSON
            try:
                confidence_scores = json.loads(result)
                if not isinstance(confidence_scores, dict):
                    return {}
                # GPT sometimes wraps the scores: {"scores": {"<uuid>": 90}} (C-08)
                if len(confidence_scores) == 1:
                    (only,) = confidence_scores.values()
                    if isinstance(only, dict):
                        confidence_scores = only

                # Ensure all values are integers between 0-100
                cleaned_scores = {}
                for id_key, score in confidence_scores.items():
                    try:
                        # Convert to int and clamp to 0-100 range
                        score_int = int(score)
                        score_int = min(max(score_int, 0), 100)
                        cleaned_scores[id_key] = score_int
                    except (ValueError, TypeError):
                        # Skip invalid scores
                        continue

                return cleaned_scores

            except json.JSONDecodeError:
                # If JSON parsing fails, try to extract scores manually
                # This is a fallback for when GPT doesn't return proper JSON
                scores = {}

                # Look for patterns like "id1": 85 or "uuid": 90
                pattern = r'"([^"]+)":\s*(\d+)'
                matches = re.findall(pattern, result)

                for id_str, score_str in matches:
                    try:
                        score = int(score_str)
                        score = min(max(score, 0), 100)
                        scores[id_str] = score
                    except ValueError:
                        continue

                return scores

        except Exception as e:
            # Type only: an upstream error can echo the prompt (people's records)
            logger.warning("compare_individuals failed: %s", type(e).__name__)
            # Return empty scores on error
            return {}

_service: Optional[OpenAIService] = None


def get_openai_service() -> OpenAIService:
    """The process's one OpenAIService, built on first use: one AsyncOpenAI client and
    its connection pool shared by every request, instead of one per call (H2-1.2)."""
    global _service
    if _service is None:
        _service = OpenAIService()
    return _service
