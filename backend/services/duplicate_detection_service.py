"""
Duplicate detection service for finding similar individuals
Uses smart search strategy and LLM-based comparison
"""
import json
import re
import uuid
from typing import Dict, List, Optional
from supabase import Client

from services.search_matching import match_individual

# Name tokens shorter than this are ignored when a longer one exists (C-22)
MIN_TOKEN_LEN = 3
# How many pre-ranked candidates the LLM compares (C-22: was 3, in retrieval order)
MAX_LLM_CANDIDATES = 8
# How many recent people the data-value (aka) scan looks at
VALUE_SCAN_LIMIT = 200
CANDIDATE_COLUMNS = "id, name, data"
# Highest confidence the name-only fallback can give (an identical name)
FALLBACK_MAX_CONFIDENCE = 80


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

        # Step 2: Candidates by name token or data value, best ranked first (C-22).
        # A database error propagates: the routes report it, not "no match" (C-08).
        candidates = await self._find_candidates(name, max_candidates)
        candidates = self._rank_candidates(categorized_data, candidates)

        # Step 3: If we have candidates, use LLM to compare attributes
        if candidates:
            matches = await self._compare_with_llm(categorized_data, candidates)
            return matches

        return []

    @staticmethod
    def _name_tokens(name: str) -> List[str]:
        """Lower-case letter/digit runs of the name, 3+ characters, de-duplicated.

        Only letters and digits survive, so a token can never carry a PostgREST
        filter character (`,` `.` `(` `)` `*`) or a LIKE wildcard. A name with no
        3-character token ("Al", "Bo Li") falls back to its 2-character tokens.
        """
        words = [w for w in re.split(r"[\W_]+", name.casefold()) if w]
        for min_len in (MIN_TOKEN_LEN, 2):
            tokens = list(dict.fromkeys(w for w in words if len(w) >= min_len))
            if tokens:
                return tokens
        return []

    async def _find_candidates(self, name: str, limit: int = 50) -> List[Dict]:
        """
        Candidate people for the LLM to compare (C-22), most recently updated first:
        1. Name: an OR of ILIKEs, one per name token, so "John Doe" also finds a
           first visit recorded as "John", and "Jon Smith" finds "John Smith".
        2. Data values (e.g. an "aka" field) through the shared value-only matcher
           (never dict keys, C-01), over the latest VALUE_SCAN_LIMIT people.

        A database error is raised, not swallowed: "no candidates" must mean no
        candidates, never "the search failed" (C-08).
        """
        name = (name or "").strip()
        tokens = self._name_tokens(name)
        if len(name) < 2 or not tokens:
            return []

        candidates: List[Dict] = []
        seen_ids = set()

        def add(rows):
            for ind in rows or []:
                if len(candidates) >= limit:
                    return
                if ind.get("id") not in seen_ids:
                    candidates.append(ind)
                    seen_ids.add(ind.get("id"))

        name_filter = ",".join(f"name.ilike.*{token}*" for token in tokens)
        by_name = self.supabase.table("individuals") \
            .select(CANDIDATE_COLUMNS) \
            .or_(name_filter) \
            .order("updated_at", desc=True) \
            .limit(limit) \
            .execute()
        add(by_name.data)

        if len(candidates) < limit:
            recent = self.supabase.table("individuals") \
                .select(CANDIDATE_COLUMNS) \
                .order("updated_at", desc=True) \
                .limit(VALUE_SCAN_LIMIT) \
                .execute()
            add([ind for ind in (recent.data or []) if match_individual(name, ind)])

        return candidates

    @staticmethod
    def _number(data: dict, key: str) -> Optional[float]:
        """A numeric field, looked up case-insensitively ("height" or "Height")."""
        for k, v in (data or {}).items():
            if isinstance(k, str) and k.casefold() == key and isinstance(v, (int, float)) and not isinstance(v, bool):
                return float(v)
        return None

    @classmethod
    def _rank_candidates(cls, new_data: dict, candidates: List[Dict]) -> List[Dict]:
        """Best candidates first: name tokens matched, plus height/weight closeness.

        Each matched token counts 1. Height (within 12 in) and weight (within 50 lb)
        add up to 0.5 each, so closeness only orders people who match the same
        number of tokens. Ties keep retrieval order (most recently updated first).
        """
        name = new_data.get("name") or new_data.get("Name") or ""
        tokens = cls._name_tokens(name) if isinstance(name, str) else []

        def closeness(field: str, scale: float, cand_data: dict) -> float:
            mine, theirs = cls._number(new_data, field), cls._number(cand_data, field)
            if mine is None or theirs is None:
                return 0.0
            return 0.5 * max(0.0, 1 - abs(mine - theirs) / scale)

        def score(candidate: Dict) -> float:
            matched = sum(1 for token in tokens if match_individual(token, candidate))
            data = candidate.get("data") if isinstance(candidate.get("data"), dict) else {}
            return matched + closeness("height", 12, data) + closeness("weight", 50, data)

        return sorted(candidates, key=score, reverse=True)

    @staticmethod
    def _score(value) -> Optional[int]:
        """A 0-100 integer score, or None for anything that is not a number."""
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return min(max(int(value), 0), 100)

    def _scores_by_candidate(self, response, candidates: List[Dict]) -> Dict[str, int]:
        """Map the LLM reply onto candidate ids.

        GPT should key by UUID, but sometimes uses placeholders ("candidate_1",
        "candidate_id_1", "Record 1", "1"). Returns {} when the reply is empty,
        None, not a dict, nested, or names none of the candidates.
        """
        if not isinstance(response, dict):
            return {}
        scores: Dict[str, int] = {}
        for i, candidate in enumerate(candidates, 1):
            for key in (candidate["id"], f"candidate_{i}", f"candidate_id_{i}", f"Record {i}", str(i)):
                score = self._score(response.get(key))
                if score is not None:
                    scores[candidate["id"]] = score
                    break
        return scores

    async def _compare_with_llm(
        self,
        new_data: dict,
        candidates: List[Dict]
    ) -> List[Dict]:
        """
        Ask GPT-4o to score the top MAX_LLM_CANDIDATES candidates (already ranked).

        Returns the single best match with confidence >= 60, or [] (PRD 4.8: top
        match only). If the LLM fails or its reply can't be read (empty, None,
        nested, or no candidate scored), falls back to name matching so an outage
        does not silently mean "no duplicate" (C-08).
        """
        if not candidates:
            return []

        top_candidates = candidates[:MAX_LLM_CANDIDATES]
        comparison_prompt = self._build_comparison_prompt(new_data, top_candidates)

        try:
            response = await self.openai_service.compare_individuals(comparison_prompt)
        except Exception as e:
            print(f"LLM duplicate comparison failed ({type(e).__name__}); using name matching")
            response = None

        scores = self._scores_by_candidate(response, top_candidates)
        if not scores:
            return self._fallback_simple_matching(new_data, top_candidates)

        matches = []
        for candidate in top_candidates:
            confidence = scores.get(candidate["id"], 0)
            if confidence >= 60 and self._is_valid_uuid(candidate["id"]):
                matches.append({
                    "id": candidate["id"],
                    "name": candidate.get("name", "Unknown"),
                    "confidence": confidence
                })

        matches.sort(key=lambda x: x["confidence"], reverse=True)
        return matches[:1]

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

        prompt += """
Analyze similarity based on:
- Name (consider phonetic similarity, nicknames, variations)
- Physical attributes (height, weight) if available
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
{
"""

        # Add explicit expected format with actual UUIDs
        for i, candidate_id in enumerate(uuid_list, 1):
            if i < len(uuid_list):
                prompt += f'    "{candidate_id}": confidence_score,\n'
            else:
                prompt += f'    "{candidate_id}": confidence_score\n'

        prompt += """}

Example with ACTUAL UUIDs (use the exact UUIDs from the records above):
{
"""

        # Show example with the actual UUIDs
        for i, candidate_id in enumerate(uuid_list, 1):
            example_confidence = 96 if i == 1 else (73 if i == 2 else 45)
            if i < len(uuid_list):
                prompt += f'    "{candidate_id}": {example_confidence},\n'
            else:
                prompt += f'    "{candidate_id}": {example_confidence}\n'

        prompt += "}"

        return prompt

    def _fallback_simple_matching(
        self,
        new_data: dict,
        candidates: List[Dict]
    ) -> List[Dict]:
        """
        Name-only matching, used when the LLM comparison fails or can't be read.

        Scores every candidate and returns the best one (or []):
        80 same name; 70 one name's words all appear in the other ("John" vs
        "John Doe"); 60 at least one word in common. Whole words only, so "Al"
        does not match "Hal". Capped at FALLBACK_MAX_CONFIDENCE: a name alone,
        with no LLM corroboration, never looks like a near-certain match.
        """
        new_name = new_data.get("name") or new_data.get("Name") or ""
        if not isinstance(new_name, str):
            return []
        new_name = " ".join(new_name.casefold().split())
        new_words = set(w for w in re.split(r"[\W_]+", new_name) if w)
        if not new_words:
            return []

        best = None
        for candidate in candidates:
            candidate_name = candidate.get("name")
            if not isinstance(candidate_name, str) or not self._is_valid_uuid(candidate.get("id")):
                continue
            candidate_name = " ".join(candidate_name.casefold().split())
            candidate_words = set(w for w in re.split(r"[\W_]+", candidate_name) if w)
            if not candidate_words:
                continue

            if candidate_name == new_name:
                confidence = FALLBACK_MAX_CONFIDENCE
            elif new_words <= candidate_words or candidate_words <= new_words:
                confidence = 70
            elif new_words & candidate_words:
                confidence = 60
            else:
                continue

            if best is None or confidence > best["confidence"]:
                best = {"id": candidate["id"], "name": candidate.get("name", "Unknown"), "confidence": confidence}

        return [best] if best else []
