"""
Individual management service - handles business logic for individuals
"""
from typing import Dict, Any, Optional
from uuid import UUID
from datetime import datetime, timezone
import re
from postgrest.exceptions import APIError
from supabase import Client

from db.models import (
    IndividualResponse,
    InteractionSummary,
    IndividualSummary,
    SearchIndividualsResponse,
    IndividualDetailResponse,
    UrgencyOverrideResponse,
    InteractionsResponse,
    InteractionDetail,
    SaveIndividualResponse,
    LocationData
)
from services.urgency_calculator import calculate_urgency_score, get_display_urgency_score
from services.field_registry import normalize_individual_data
from services.search_matching import MATCH_TIER, match_individual
from services import context_service
from db.client import fetch_all, run_db


class IndividualNotFound(LookupError):
    """The person isn't there (never was, or deleted mid-request): routes answer 404 (H2-1.4)."""


# The merge diff's list of fields the merge dropped (H2-2.5); never a data key
REMOVED_KEY = "_removed"

VERSION_CONFLICT_DETAIL = "This person was changed by someone else. Reload and try again."


class VersionConflictError(Exception):
    """A merge based on a version someone else has since changed: routes answer 409 (H2-2.3)."""


def _individual_response(row: Dict[str, Any]) -> IndividualResponse:
    """An individuals row (from a select or save_individual) as the API's IndividualResponse."""
    return IndividualResponse(
        id=row["id"],
        name=row["name"],
        urgency_score=row["urgency_score"],
        urgency_override=row.get("urgency_override"),
        display_score=get_display_urgency_score(row),
        data=row["data"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        last_location=row.get("last_location"),
        version=row.get("version", 1),
    )


def _interaction_summary(row: Dict[str, Any]) -> InteractionSummary:
    return InteractionSummary(
        id=row["id"],
        created_at=row["created_at"],
        user_name=row.get("user_name"),
        location=row.get("location"),
        has_transcription=bool(row.get("transcription")),
    )


LAST_SEEN_CHUNK = 50  # ids per interactions query (URL length and the ~1000-row cap)


def fetch_last_seen(supabase: Client, individual_ids: list) -> Dict[str, Dict[str, Any]]:
    """
    Latest interaction per person, from one interactions query per chunk of
    LAST_SEEN_CHUNK ids (one query for a typical page).

    Returns {id: {"last_seen": iso_str, "location": dict | None}}. People with no
    interactions are absent; the caller falls back to their `created_at`.
    `last_seen` is never `updated_at` (an urgency override or edit is not a sighting).
    Chunking keeps the `in_` list short enough for the URL; each chunk is read with
    fetch_all, so a chunk with more than 1000 interactions is still read whole (H2-1.3).
    """
    ids = [str(i) for i in individual_ids]
    latest: Dict[str, Dict[str, Any]] = {}
    for start in range(0, len(ids), LAST_SEEN_CHUNK):
        chunk = ids[start:start + LAST_SEEN_CHUNK]
        rows = fetch_all(lambda: supabase.table("interactions")
                         .select("id, individual_id, created_at, location")
                         .in_("individual_id", chunk)
                         .order("created_at", desc=True)
                         .order("id"))
        for row in rows:  # newest first, so the first row per person wins
            latest.setdefault(str(row["individual_id"]), {
                "last_seen": row["created_at"],
                "location": row.get("location"),
            })
    return latest


def rescore_all_individuals(supabase: Client) -> int:
    """
    Recompute every individual's stored `urgency_score` with the current categories.

    OD-1 puts every weighted category in the denominator, so creating one changes
    everyone's score. Called by `create_category` for a weighted or auto-trigger
    category, and by scripts/rescore_urgency.py after an upgrade.
    - One paged read of individuals (fetch_all, every row) and one of categories,
      then one update per row whose score changed.
    - Scores the normalised data, as a save would; `data` itself is not rewritten.
    - Writes only `urgency_score`: `urgency_override` is never touched. The
      `updated_at` trigger bumps each re-scored row.
    - Clears the assistant's context cache if anything changed.
    Returns the number of rows updated.
    """
    individuals = fetch_all(lambda: supabase.table("individuals").select("id, urgency_score, data").order("id"))
    categories = supabase.table("categories").select("*").execute().data or []
    updated = 0
    for row in individuals:
        stored = row.get("data")
        data, _ = normalize_individual_data(stored if isinstance(stored, dict) else {}, categories)
        score = calculate_urgency_score(data, categories)
        if score != row.get("urgency_score"):
            supabase.table("individuals").update({"urgency_score": score}).eq("id", str(row["id"])).execute()
            updated += 1
    if updated:
        context_service.invalidate_context_cache()
    return updated


def _parse_timestamp(value: Any) -> datetime:
    """An ISO timestamp as an aware datetime, so sorting compares times, not strings.
    Naive values are taken as UTC; anything unparseable sorts as the oldest."""
    if isinstance(value, datetime):
        dt = value
    else:
        try:
            dt = datetime.fromisoformat(str(value))
        except (TypeError, ValueError):
            return datetime.min.replace(tzinfo=timezone.utc)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class IndividualService:
    """Service for managing individuals and interactions"""
    
    def __init__(self, supabase_client: Client):
        self.supabase = supabase_client
    
    def get_changed_fields(
        self,
        old_data: Dict[str, Any],
        new_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Compare old and new data, return only changed fields.
        
        Rules:
        - Include field if value changed
        - Include new fields not in old data
        - Don't include fields with same value
        - Never include empty new values (None, "", whitespace, [])
        - A field that had a value and is now absent or empty is recorded as
          None, and its name goes in the sorted `_removed` list (only when
          something was removed), so history shows the removal (H2-2.5)
        - A `_removed` key in either input is ignored
        Both sides should already be normalised (see save_individual).
        """
        def empty(value):
            return value is None or value == [] or (isinstance(value, str) and not value.strip())

        changes = {}

        # Check all fields in new data
        for key, new_value in new_data.items():
            if key == REMOVED_KEY or empty(new_value):
                continue
            if key not in old_data:
                # New field
                changes[key] = new_value
            elif old_data[key] != new_value:
                # Changed field
                changes[key] = new_value

        removed = sorted(key for key, old_value in old_data.items()
                         if key != REMOVED_KEY and not empty(old_value) and empty(new_data.get(key)))
        if removed:
            changes.update({key: None for key in removed})
            changes[REMOVED_KEY] = removed
        return changes
    
    def abbreviate_address(self, full_address: str) -> str:
        """
        Abbreviate address with multiple strategies.
        
        Strategies:
        1. If already has cross-street format (contains &)
        2. Extract main street name
        3. Use first part before comma
        4. Truncate if too long
        """
        if not full_address:
            return ""
        
        # Strategy 1: Already has cross-street format
        if " & " in full_address:
            # "Market Street & 5th Street, SF" -> "Market Street & 5th"
            parts = full_address.split(",")[0]
            # Remove "Street" from second part for brevity
            parts = parts.replace(" Street", "")
            return parts.strip()
        
        # Strategy 2: Extract main street
        street_match = re.search(
            r'(\d+\s+)?((?:\w+\s+)+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Way|Place|Pl))',
            full_address
        )
        if street_match:
            return street_match.group(2).strip()
        
        # Strategy 3: First significant part (before comma)
        parts = full_address.split(",")
        if parts[0] and len(parts[0]) <= 30:
            return parts[0].strip()
        
        # Strategy 4: Truncate
        return full_address[:30].strip() + "..."
    
    async def save_individual(
        self,
        user_id: str,
        user_name: str,
        data: Dict[str, Any],
        merge_with_id: Optional[UUID] = None,
        location: Optional[LocationData] = None,
        transcription: Optional[str] = None,
        audio_url: Optional[str] = None,
        expected_version: Optional[int] = None,
        client_request_id: Optional[UUID] = None,
    ) -> SaveIndividualResponse:
        """
        Save a new individual or merge into an existing one, through the
        `save_individual` SQL function: the person and the interaction row are one
        transaction (H2-2.2), so there is no half-saved state to clean up.

        1. Normalise `data` against the categories (raises ValueError on invalid values)
           and compute the urgency score from it.
        2. A merge reads the target's data and version (IndividualNotFound if it's gone)
           and records only the changed fields.
        3. The function guards a merge with `expected_version` (else the version just
           read): a stale one raises VersionConflictError (H2-2.3). It checks
           `client_request_id` (the Idempotency-Key) first, so a retry of a save that
           already committed replays its result (`replayed`) instead of 409-ing (H2-2.4).
           Versions are never compared here in Python.
        """
        categories_response = await run_db(lambda: self.supabase.table("categories").select("*").execute())
        categories = categories_response.data or []

        # Normalise before the diff and the urgency calculation, so None/"" never
        # reach `data` and "180" vs 180 is not recorded as a change.
        data, errors = normalize_individual_data(data, categories)
        if errors:
            raise ValueError(". ".join(f"{e['field']}: {e['message']}" for e in errors))
        urgency_score = calculate_urgency_score(data, categories)

        location_dict = None
        if location:
            location_dict = {
                "latitude": location.latitude,
                "longitude": location.longitude,
                "address": location.address
            }

        changes = data  # a first visit records every field
        if merge_with_id:
            existing_response = await run_db(lambda: self.supabase.table("individuals")
                                             .select("id, data, version")
                                             .eq("id", str(merge_with_id))
                                             .maybe_single()
                                             .execute())
            if existing_response is None or not existing_response.data:
                raise IndividualNotFound(f"Individual not found: {merge_with_id}")
            existing = existing_response.data
            # Older rows may hold un-normalised values ("180"), so normalise them too
            old_data = existing.get("data") or {}
            if isinstance(old_data, dict):
                old_data, _ = normalize_individual_data(old_data, categories)
            changes = self.get_changed_fields(old_data, data)
            if expected_version is None:
                expected_version = existing.get("version")

        params = {
            "p_individual_id": str(merge_with_id) if merge_with_id else None,
            "p_name": data.get("name", "Unknown"),
            "p_data": data,
            "p_urgency_score": urgency_score,
            "p_interaction": {
                "user_id": user_id,
                "user_name": user_name,
                "transcription": transcription,
                "audio_url": audio_url,
                "location": location_dict,
                "changes": changes,
            },
            "p_expected_version": expected_version if merge_with_id else None,
            "p_client_request_id": str(client_request_id) if client_request_id else None,
        }
        try:
            result = (await run_db(lambda: self.supabase.rpc("save_individual", params).execute())).data
        except APIError as e:
            if e.code == "P0409":
                raise VersionConflictError(VERSION_CONFLICT_DETAIL) from e
            if e.code == "P0002":
                raise IndividualNotFound(f"Individual not found: {merge_with_id}") from e
            raise

        return SaveIndividualResponse(
            individual=_individual_response(result["individual"]),
            interaction=_interaction_summary(result["interaction"]),
            replayed=bool(result.get("replayed")),
        )

    async def search_individuals(
        self,
        search: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
        sort_by: str = "last_seen",
        sort_order: str = "desc"
    ) -> SearchIndividualsResponse:
        """
        List / search individuals.

        - A search term goes through `match_individual` (services/search_matching.py):
          the name, or any string value / list item in `data`, never keys. One
          paged read of the whole table (fetch_all), matched in Python (demo scale).
        - `last_seen`: latest interaction, else `created_at` (fetch_last_seen).
        - Sort: name matches first, then value matches; within each tier by
          `sort_by` (`urgency_score` means the display score). Then paginate.
        """
        # Database errors propagate (the route turns them into a 500). Returning
        # an empty list here made an outage look like "no one recorded yet" (C-17).
        individuals = await run_db(lambda: fetch_all(
            lambda: self.supabase.table("individuals").select("*").order("id")))
        term = search.strip() if search else ""
        tier: Dict[str, int] = {}
        if term:
            matched = []
            for ind in individuals:
                kind = match_individual(term, ind)
                if kind:
                    tier[ind["id"]] = MATCH_TIER[kind]
                    matched.append(ind)
            individuals = matched

        total = len(individuals)
        reverse = sort_order == "desc"

        # last_seen for every person when sorting by it, else only for the page
        if sort_by == "last_seen":
            seen = await run_db(lambda: fetch_last_seen(self.supabase, [i["id"] for i in individuals]))
            individuals.sort(
                key=lambda x: _parse_timestamp(seen.get(x["id"], {}).get("last_seen", x["created_at"])),
                reverse=reverse
            )
        elif sort_by == "urgency_score":
            individuals.sort(key=get_display_urgency_score, reverse=reverse)
        else:  # sort by name
            individuals.sort(key=lambda x: x["name"], reverse=reverse)
        # Stable sort: the tier order wins, the sort above orders within a tier
        individuals.sort(key=lambda x: tier.get(x["id"], 0))

        page = individuals[offset:offset + limit]
        if sort_by != "last_seen":
            seen = await run_db(lambda: fetch_last_seen(self.supabase, [i["id"] for i in page]))

        results = []
        for ind in page:
            latest = seen.get(ind["id"])
            location = (latest or {}).get("location") or ind.get("last_location")
            last_location = None
            if location:
                last_location = dict(location)
                if last_location.get("address"):
                    last_location["address"] = self.abbreviate_address(last_location["address"])

            results.append(IndividualSummary(
                id=ind["id"],
                name=ind["name"],
                urgency_score=ind["urgency_score"],
                urgency_override=ind.get("urgency_override"),
                display_score=get_display_urgency_score(ind),
                last_seen=latest["last_seen"] if latest else ind["created_at"],
                last_location=last_location
            ))

        return SearchIndividualsResponse(
            individuals=results,
            total=total,
            offset=offset,
            limit=limit
        )

    async def delete_individual(self, individual_id: UUID) -> bool:
        """Delete a person. FK cascades remove their interactions and embeddings.
        Returns True if a row was deleted, False if there was no such person."""
        response = await run_db(lambda: self.supabase.table("individuals")
                                .delete()
                                .eq("id", str(individual_id))
                                .execute())
        return bool(response.data)

    async def get_individual_by_id(self, individual_id: UUID) -> Optional[IndividualDetailResponse]:
        """Get individual details with recent interactions"""
        # maybe_single() returns None for zero rows (the only "not found"); any other
        # database error propagates, so an outage is a 500 and not a 404 (C-17).
        individual_response = await run_db(lambda: self.supabase.table("individuals")
                                           .select("*")
                                           .eq("id", str(individual_id))
                                           .maybe_single()
                                           .execute())

        if individual_response is None or not individual_response.data:
            return None
        
        # Handle both single item and array responses
        if isinstance(individual_response.data, list):
            individual = individual_response.data[0] if individual_response.data else None
        else:
            individual = individual_response.data
        
        if not individual:
            return None
        
        # Get recent interactions (last 10)
        interactions_query = self.supabase.table("interactions") \
            .select("*") \
            .eq("individual_id", str(individual_id)) \
            .order("created_at", desc=True) \
            .limit(10)
        
        # Execute the query
        interactions_response = await run_db(interactions_query.execute)
        
        return IndividualDetailResponse(
            individual=_individual_response(individual),
            recent_interactions=[_interaction_summary(i) for i in interactions_response.data]
        )
    
    async def update_urgency_override(
        self,
        individual_id: UUID,
        urgency_override: Optional[int]
    ) -> UrgencyOverrideResponse:
        """Update manual urgency score override"""
        # Update individual
        update_query = self.supabase.table("individuals") \
            .update({"urgency_override": urgency_override}) \
            .eq("id", str(individual_id))
        
        # Execute the query
        update_response = await run_db(update_query.execute)
        
        if not update_response.data:
            raise IndividualNotFound(f"Individual not found: {individual_id}")
        
        # Handle both single item and array responses
        if isinstance(update_response.data, list):
            individual = update_response.data[0] if update_response.data else None
        else:
            individual = update_response.data
        
        if not individual:
            raise IndividualNotFound(f"Individual not found: {individual_id}")
        
        return UrgencyOverrideResponse(
            urgency_score=individual["urgency_score"],
            urgency_override=individual.get("urgency_override"),
            display_score=get_display_urgency_score(individual)
        )
    
    async def get_interactions(
        self,
        individual_id: UUID,
        limit: int = 50,
        offset: int = 0
    ) -> InteractionsResponse:
        """Get detailed interaction history"""
        # Get interactions
        interactions_response = await run_db(lambda: self.supabase.table("interactions")
                                             .select("*")
                                             .eq("individual_id", str(individual_id))
                                             .order("created_at", desc=True)
                                             .range(offset, offset + limit - 1)
                                             .execute())
        
        # Format response with full addresses
        interactions = [
            InteractionDetail(
                id=i["id"],
                created_at=i["created_at"],
                user_name=i["user_name"],
                transcription=i.get("transcription"),
                location=i.get("location"),  # Full location with complete address
                changes=i.get("changes", {})
            )
            for i in interactions_response.data
        ]
        
        return InteractionsResponse(interactions=interactions)