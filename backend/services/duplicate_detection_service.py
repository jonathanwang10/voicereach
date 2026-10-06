"""
Duplicate detection service for finding similar individuals
Uses smart search strategy and LLM-based comparison
"""
import json
import uuid
from typing import List, Dict
from supabase import Client


class DuplicateDetectionService:
    """Service for detecting duplicate individuals using database search and LLM comparison"""

    def __init__(self, supabase_client: Client, openai_service):
        """
        Initialize the duplicate detection service

        Args:
            supabase_client: Supabase client for database operations
            openai_service: OpenAI service for LLM comparison
        """
        self.supabase = supabase_client
        self.openai_service = openai_service

    def _is_valid_uuid(self, value: str) -> bool:
        """
        Check if a string is a valid UUID

        Args:
            value: String to check

        Returns:
            True if valid UUID, False otherwise
        """
        try:
            uuid.UUID(str(value))
            return True
        except (ValueError, AttributeError, TypeError):
            return False

    async def find_duplicates(
        self,
        categorized_data: dict,
        max_candidates: int = 50
    ) -> List[Dict]:
        """
        Find potential duplicate individuals using smart search strategy

        Args:
            categorized_data: Data about the new individual
            max_candidates: Maximum number of candidates to consider (default 50)

        Returns:
            List of matches with id, name, confidence (0-100)
            Per PRD 4.8: Returns only top match for MVP
        """
        # Step 1: Extract searchable attributes (check both name and Name)
        name = categorized_data.get("name") or categorized_data.get("Name")

        # If no name or name too short, return empty matches
        if not isinstance(name, str) or len(name.strip()) < 2:
            return []

        # Step 2: Search for candidates using smart strategy
        candidates = await self._find_candidates(name, max_candidates)

        # Step 3: If we have candidates, use LLM to compare attributes
        if candidates:
            matches = await self._compare_with_llm(categorized_data, candidates)
            return matches

        return []

    @staticmethod
    def _escape_ilike(value: str) -> str:
        """Escape PostgREST/LIKE wildcards so user text matches literally."""
        return value.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_").replace("*", r"\*")

    async def _find_candidates(self, name: str, limit: int = 50) -> List[Dict]:
        """
        Smart search strategy for finding potential matches
        1. Exact name match first (uses index, fast)
        2. Fuzzy search if needed
        3. Search in JSONB data for name variations
        4. Limit to max candidates

        Args:
            name: Name to search for
            limit: Maximum number of candidates to return

        Returns:
            List of candidate individuals from database
        """
        if not name or len(name.strip()) < 2:
            return []

        candidates = []
        seen_ids = set()
        safe = self._escape_ilike(name.strip())

        try:
            # Step 1: Exact name match (case-insensitive)
            exact_response = self.supabase.table("individuals") \
                .select("*") \
                .ilike("name", safe) \
                .limit(10) \
                .execute()

            if exact_response.data:
                for ind in exact_response.data:
                    if ind["id"] not in seen_ids:
                        candidates.append(ind)
                        seen_ids.add(ind["id"])

            # Step 2: Fuzzy search if we have < 10 exact matches
            if len(candidates) < 10:
                # Search for partial matches
                fuzzy_response = self.supabase.table("individuals") \
                    .select("*") \
                    .ilike("name", f"%{safe}%") \
                    .order("updated_at", desc=True) \
                    .limit(limit - len(candidates)) \
                    .execute()

                if fuzzy_response.data:
                    for ind in fuzzy_response.data:
                        if ind["id"] not in seen_ids:
                            candidates.append(ind)
                            seen_ids.add(ind["id"])

            # Step 3: Also search in JSONB data for name variations
            # (if we still have room for more candidates)
            if len(candidates) < limit:
                # Get more individuals to search through their data field
                all_response = self.supabase.table("individuals") \
                    .select("*") \
                    .order("updated_at", desc=True) \
                    .limit(200) \
                    .execute()

                if all_response.data:
                    name_lower = name.lower()
                    for ind in all_response.data:
                        if len(candidates) >= limit:
                            break
                        if ind["id"] not in seen_ids:
                            # Search in the JSONB data field
                            data_str = str(ind.get("data", {})).lower()
                            if name_lower in data_str:
                                candidates.append(ind)
                                seen_ids.add(ind["id"])

        except Exception as e:
            print(f"Error searching for candidates: {str(e)}")
            # Return whatever candidates we found so far
            pass

        return candidates[:limit]

    async def _compare_with_llm(
        self,
        new_data: dict,
        candidates: List[Dict]
    ) -> List[Dict]:
        """
        Use GPT-4o to intelligently compare individuals

        Args:
            new_data: Data about the new individual
            candidates: List of candidate individuals from database

        Returns:
            List of matches with confidence scores, sorted by confidence
            Only returns matches with confidence >= 60%
            Per PRD 4.8: Returns only top match for MVP
        """
        if not candidates:
            return []

        try:
            # Limit to top 3 candidates for LLM comparison to save tokens
            top_candidates = candidates[:3]

            # Create mapping of candidate positions to their actual IDs
            # This helps handle cases where GPT returns placeholder keys
            id_mapping = {}
            for i, candidate in enumerate(top_candidates, 1):
                id_mapping[f"candidate_{i}"] = candidate["id"]
                id_mapping[f"candidate_id_{i}"] = candidate["id"]
                id_mapping[f"Record {i}"] = candidate["id"]
                id_mapping[str(i)] = candidate["id"]

            # Build comparison prompt with explicit instructions
            comparison_prompt = self._build_comparison_prompt(new_data, top_candidates)

            # Call OpenAI service for comparison
            response = await self.openai_service.compare_individuals(comparison_prompt)

            # Parse response and build matches list
            matches = []

            # Try to match responses to candidates
            for candidate in top_candidates:
                confidence = 0

                # First try to get confidence by actual UUID
                if candidate["id"] in response:
                    confidence = response[candidate["id"]]
                else:
                    # Check if GPT returned placeholder keys instead of actual UUIDs
                    for placeholder_key, actual_id in id_mapping.items():
                        if actual_id == candidate["id"] and placeholder_key in response:
                            confidence = response[placeholder_key]
                            break

                if confidence >= 60:  # Only return meaningful matches
                    # Validate that we have a valid UUID before adding to matches
                    if self._is_valid_uuid(candidate["id"]):
                        matches.append({
                            "id": candidate["id"],
                            "name": candidate.get("name", "Unknown"),
                            "confidence": confidence
                        })
                    else:
                        print(f"Warning: Invalid UUID detected: {candidate.get('id', 'None')}")

            # Sort by confidence descending
            matches.sort(key=lambda x: x["confidence"], reverse=True)

            # Return only top match for MVP (per PRD 4.8)
            return matches[:1] if matches else []

        except Exception as e:
            print(f"Error comparing individuals with LLM: {str(e)}")
            # Fallback to simple name matching if LLM fails
            return self._fallback_simple_matching(new_data, candidates)

    def _build_comparison_prompt(self, new_data: dict, candidates: List[Dict]) -> str:
        """
        Build prompt for LLM duplicate detection

        Args:
            new_data: Data about the new individual
            candidates: List of candidate individuals

        Returns:
            Formatted prompt string for GPT-4o
        """
        prompt = f"""
Compare this new person with existing records using ALL available attributes:

New person data:
{json.dumps(new_data, indent=2)}

Existing records:
"""

        # Build a clear mapping for the expected response
        uuid_list = []
        for i, candidate in enumerate(candidates, 1):
            prompt += f"\nRecord {i} (ID: {candidate['id']}):\n"
            prompt += f"  Name: {candidate.get('name', 'Unknown')}\n"
            if candidate.get('data'):
                prompt += f"  Data: {json.dumps(candidate['data'], indent=2)}\n"
            uuid_list.append(candidate['id'])

        prompt += f"""
Analyze similarity based on:
- Name (consider phonetic similarity, nicknames, variations)
- Physical attributes (height, weight, skin color) if available
- Age or birth year if available
- Medical conditions and history if available
- Substance abuse history if available
- Veteran status if available
- Location patterns if available
- Any other matching details

For each existing record, return a confidence score 0-100 where:
- 95-100: Almost certainly the same person (same/very similar name + multiple matching attributes)
- 80-94: Likely the same person (similar name + some matching attributes)
- 60-79: Possibly the same person (some similarities)
- Below 60: Different person

IMPORTANT: Use the EXACT UUID from each record as the JSON key, not placeholders.

Return JSON only with the actual UUIDs as keys:
{{
"""

        # Add explicit expected format with actual UUIDs
        for i, uuid in enumerate(uuid_list, 1):
            if i < len(uuid_list):
                prompt += f'    "{uuid}": confidence_score,\n'
            else:
                prompt += f'    "{uuid}": confidence_score\n'

        prompt += f"""}}

Example with ACTUAL UUIDs (use the exact UUIDs from the records above):
{{
"""

        # Show example with the actual UUIDs
        for i, uuid in enumerate(uuid_list, 1):
            example_confidence = 96 if i == 1 else (73 if i == 2 else 45)
            if i < len(uuid_list):
                prompt += f'    "{uuid}": {example_confidence},\n'
            else:
                prompt += f'    "{uuid}": {example_confidence}\n'

        prompt += "}"

        return prompt

    def _fallback_simple_matching(
        self,
        new_data: dict,
        candidates: List[Dict]
    ) -> List[Dict]:
        """
        Fallback to simple name matching if LLM comparison fails

        Args:
            new_data: Data about the new individual
            candidates: List of candidate individuals

        Returns:
            List with simple name-based matches
        """
        matches = []
        new_name = (new_data.get("name") or new_data.get("Name", "")).lower().strip()

        if not new_name:
            return []

        for candidate in candidates[:1]:  # Only top candidate for MVP
            candidate_name = (candidate.get("name", "")).lower().strip()

            if not candidate_name:
                continue

            # Calculate simple similarity
            confidence = 0
            if candidate_name == new_name:
                confidence = 95  # Exact match
            elif new_name in candidate_name or candidate_name in new_name:
                confidence = 80  # Partial match
            else:
                # Check word overlap
                new_words = set(new_name.split())
                candidate_words = set(candidate_name.split())
                if new_words & candidate_words:  # Any common words
                    confidence = 70

            if confidence >= 60:
                # Validate UUID in fallback as well
                if self._is_valid_uuid(candidate["id"]):
                    matches.append({
                        "id": candidate["id"],
                        "name": candidate.get("name", "Unknown"),
                        "confidence": confidence
                    })

        return matches