"""
OpenAI API integration for Whisper transcription and GPT-4o categorization
"""
import os
import httpx
import tempfile
import json
import re
from typing import Optional, Dict
from openai import AsyncOpenAI
from urllib.parse import urlparse

from services.field_registry import category_key, parse_height_inches


class OpenAIService:
    def __init__(self):
        self.client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        self._api_key = os.getenv("OPENAI_API_KEY")

    def _recreate_client(self):
        """Recreate the OpenAI client to handle session expiration"""
        self.client = AsyncOpenAI(api_key=self._api_key)
        
    async def transcribe_audio(self, audio_url: str) -> str:
        """
        Transcribe audio from Supabase URL using OpenAI Whisper API
        
        Args:
            audio_url: Public URL to M4A audio file in Supabase Storage
            
        Returns:
            Plain text transcription
            
        Raises:
            ValueError: For invalid URL, wrong format, or duration issues
            Exception: For API or network errors
        """
        # Validate URL format
        parsed = urlparse(audio_url)
        if not parsed.scheme or not parsed.netloc:
            raise ValueError("Invalid URL format")
            
        # Check if it's a Supabase URL
        host = parsed.hostname or ""
        if not host.endswith(".supabase.co"):
            raise ValueError("URL must be from Supabase Storage")
            
        # Download audio file to temporary location
        async with httpx.AsyncClient() as client:
            try:
                response = await client.get(audio_url, timeout=30.0)
                response.raise_for_status()
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    raise ValueError("Audio file not found")
                raise Exception(f"Failed to download audio: {e}")
            except httpx.TimeoutException:
                raise Exception("Network timeout while downloading audio")
                
        # Save to temporary file
        with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as tmp_file:
            tmp_file.write(response.content)
            tmp_path = tmp_file.name
            
        try:
            # Validate file format (basic check for M4A header)
            with open(tmp_path, 'rb') as f:
                header = f.read(12)
                # M4A files typically have 'ftyp' at offset 4
                if b'ftyp' not in header:
                    raise ValueError("File is not in M4A format")
            
            # Send to Whisper API
            with open(tmp_path, 'rb') as audio_file:
                transcript = await self.client.audio.transcriptions.create(
                    model="whisper-1",
                    file=audio_file,
                    response_format="text"
                )
                
            # Note: Duration validation would happen on frontend
            # Backend accepts whatever audio Whisper can process
            # Frontend enforces 5-second minimum and 2-minute maximum
            
            return transcript.strip()
            
        except Exception as e:
            if "Audio file is too short" in str(e):
                raise ValueError("Audio must be at least 5 seconds long")
            elif "Audio file is too long" in str(e):
                raise ValueError("Audio must be less than 2 minutes")
            raise
            
        finally:
            # Clean up temporary file
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
    
    async def transcribe_audio_file(self, file_path: str) -> str:
        """
        Transcribe audio from local file using OpenAI Whisper API
        
        Args:
            file_path: Path to local M4A audio file
            
        Returns:
            Plain text transcription
            
        Raises:
            ValueError: For invalid file format or duration issues
            Exception: For API or network errors
        """
        try:
            # Validate file exists
            if not os.path.exists(file_path):
                raise ValueError("Audio file not found")
            
            # Validate file format (basic check for M4A header)
            with open(file_path, 'rb') as f:
                header = f.read(12)
                # M4A files typically have 'ftyp' at offset 4
                if b'ftyp' not in header:
                    raise ValueError("File is not in M4A format")
            
            # Send to Whisper API
            with open(file_path, 'rb') as audio_file:
                transcript = await self.client.audio.transcriptions.create(
                    model="whisper-1",
                    file=audio_file,
                    response_format="text"
                )
                
            return transcript.strip()
            
        except Exception as e:
            if "Audio file is too short" in str(e):
                raise ValueError("Audio must be at least 5 seconds long")
            elif "Audio file is too long" in str(e):
                raise ValueError("Audio must be less than 2 minutes")
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
                model="gpt-4o",
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
                model="gpt-4o",
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
            # Check for session expiration error
            if "session" in str(e).lower() and "expired" in str(e).lower():
                print("OpenAI session expired, recreating client...")
                self._recreate_client()
                # Try once more with new client
                try:
                    response = await self.client.chat.completions.create(
                        model="gpt-4o",
                        messages=[
                            {
                                "role": "system",
                                "content": "You are a data comparison assistant. Compare individuals and return JSON with confidence scores."
                            },
                            {"role": "user", "content": comparison_prompt}
                        ],
                        temperature=0.3,
                        response_format={"type": "json_object"}
                    )
                    result = response.choices[0].message.content
                    scores = json.loads(result) if isinstance(result, str) else result
                    validated_scores = {}
                    for key, value in scores.items():
                        if isinstance(value, (int, float)):
                            validated_scores[key] = int(value)
                    return validated_scores
                except Exception as retry_error:
                    print(f"Retry after session recreation failed: {str(retry_error)}")
                    return {}

            print(f"Error in compare_individuals: {str(e)}")
            # Return empty scores on error
            return {}