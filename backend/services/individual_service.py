"""
Individual management service - handles business logic for individuals
"""
from typing import Dict, Any, Optional
from uuid import UUID
from datetime import datetime, timezone
import re
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


LAST_SEEN_CHUNK = 50  # ids per interactions query (URL length and the ~1000-row cap)


def fetch_last_seen(supabase: Client, individual_ids: list) -> Dict[str, Dict[str, Any]]:
    """
    Latest interaction per person, from one interactions query per chunk of
    LAST_SEEN_CHUNK ids (one query for a typical page).

    Returns {id: {"last_seen": iso_str, "location": dict | None}}. People with no
    interactions are absent; the caller falls back to their `created_at`.
    `last_seen` is never `updated_at` (an urgency override or edit is not a sighting).
    Chunking keeps the `in_` list short enough for the URL, and keeps each response
    under PostgREST's ~1000-row cap unless the chunk averages more than ~20
    interactions per person (then the oldest of them fall back to `created_at`).
    """
    ids = [str(i) for i in individual_ids]
    latest: Dict[str, Dict[str, Any]] = {}
    for start in range(0, len(ids), LAST_SEEN_CHUNK):
        rows = supabase.table("interactions") \
            .select("individual_id, created_at, location") \
            .in_("individual_id", ids[start:start + LAST_SEEN_CHUNK]) \
            .order("created_at", desc=True) \
            .execute().data or []
        for row in rows:  # newest first, so the first row per person wins
            latest.setdefault(str(row["individual_id"]), {
                "last_seen": row["created_at"],
                "location": row.get("location"),
            })
    return latest


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
        Both sides should already be normalised (see save_individual).
        """
        changes = {}

        # Check all fields in new data
        for key, new_value in new_data.items():
            if new_value is None or new_value == [] or (isinstance(new_value, str) and not new_value.strip()):
                continue
            if key not in old_data:
                # New field
                changes[key] = new_value
            elif old_data[key] != new_value:
                # Changed field
                changes[key] = new_value
        
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
        audio_url: Optional[str] = None
    ) -> SaveIndividualResponse:
        """
        Save a new individual or update existing (merge).

        Not transactional (two PostgREST writes). Order: individual, then interaction.
        - New person: if the interaction insert fails, the new individual is deleted
          (compensating action) and the error is raised, so a retry cannot duplicate them.
        - Merge: update, then interaction. A failed interaction leaves the update in place.
        The merge read-modify-write has no concurrency guard.

        Logic:
        1. Normalise `data` against the categories (raises ValueError on invalid values)
        2. Calculate urgency score from the normalised data
        3. If merge_with_id: update existing individual
        4. Else: create new individual
        5. Create interaction record with changes only
        6. Return both records
        """
        # Fetch categories for normalisation and urgency weights
        categories_response = self.supabase.table("categories").select("*").execute()
        categories = categories_response.data or []

        # Normalise before the diff and the urgency calculation, so None/"" never
        # reach `data` and "180" vs 180 is not recorded as a change.
        data, errors = normalize_individual_data(data, categories)
        if errors:
            raise ValueError(". ".join(f"{e['field']}: {e['message']}" for e in errors))
        urgency_score = calculate_urgency_score(data, categories)
        
        # Prepare location dict if provided
        location_dict = None
        if location:
            location_dict = {
                "latitude": location.latitude,
                "longitude": location.longitude,
                "address": location.address
            }
        
        # Extract name for individual record
        name = data.get("name", "Unknown")
        
        if merge_with_id:
            # Verify individual exists
            existing_response = self.supabase.table("individuals") \
                .select("*") \
                .eq("id", str(merge_with_id)) \
                .maybe_single() \
                .execute()
            
            if existing_response is None or not existing_response.data:
                raise ValueError(f"Individual not found: {merge_with_id}")
            
            existing_individual = existing_response.data
            
            # Get changes only. Older rows may hold un-normalised values ("180"),
            # so normalise them too before comparing.
            old_data = existing_individual.get("data") or {}
            if isinstance(old_data, dict):
                old_data, _ = normalize_individual_data(old_data, categories)
            changes = self.get_changed_fields(old_data, data)
            
            # Update existing individual with location if provided
            update_data = {
                "name": name,
                "urgency_score": urgency_score,
                "data": data,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
            
            # Add last_location if location data is provided
            if location_dict:
                update_data["last_location"] = location_dict
            
            update_response = self.supabase.table("individuals") \
                .update(update_data) \
                .eq("id", str(merge_with_id)) \
                .execute()
            
            individual = update_response.data[0]
            
            # Create interaction with changes only
            interaction_response = self.supabase.table("interactions") \
                .insert({
                    "individual_id": str(merge_with_id),
                    "user_id": user_id,
                    "user_name": user_name,
                    "transcription": transcription,
                    "audio_url": audio_url,
                    "location": location_dict,
                    "changes": changes
                }) \
                .execute()
            
            interaction = interaction_response.data[0]
            
        else:
            # Create new individual with location if provided
            individual_data = {
                "name": name,
                "urgency_score": urgency_score,
                "data": data
            }
            
            # Add last_location if location data is provided
            if location_dict:
                individual_data["last_location"] = location_dict
            
            individual_response = self.supabase.table("individuals") \
                .insert(individual_data) \
                .execute()
            
            individual = individual_response.data[0]
            
            # Create interaction with all data (first interaction). If it fails,
            # remove the person we just created so a retry does not duplicate them.
            try:
                interaction_response = self.supabase.table("interactions") \
                    .insert({
                        "individual_id": individual["id"],
                        "user_id": user_id,
                        "user_name": user_name,
                        "transcription": transcription,
                        "audio_url": audio_url,
                        "location": location_dict,
                        "changes": data  # All data for first interaction
                    }) \
                    .execute()
            except Exception:
                try:
                    self.supabase.table("individuals").delete().eq("id", individual["id"]).execute()
                except Exception:
                    pass  # best effort; the original error is the one to surface
                raise
            
            interaction = interaction_response.data[0]
        
        # Format response
        individual_resp = IndividualResponse(
            id=individual["id"],
            name=individual["name"],
            urgency_score=individual["urgency_score"],
            urgency_override=individual.get("urgency_override"),
            display_score=get_display_urgency_score(individual),
            data=individual["data"],
            created_at=individual["created_at"],
            updated_at=individual["updated_at"],
            last_location=individual.get("last_location")
        )
        
        interaction_resp = InteractionSummary(
            id=interaction["id"],
            created_at=interaction["created_at"],
            user_name=interaction["user_name"],
            location=interaction.get("location"),
            has_transcription=bool(interaction.get("transcription"))
        )
        

        
        return SaveIndividualResponse(
            individual=individual_resp,
            interaction=interaction_resp
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
          table read, matched in Python (demo scale; one read returns at most Supabase's
          API row limit, 1000 by default).
        - `last_seen`: latest interaction, else `created_at` (fetch_last_seen).
        - Sort: name matches first, then value matches; within each tier by
          `sort_by` (`urgency_score` means the display score). Then paginate.
        """
        # Database errors propagate (the route turns them into a 500). Returning
        # an empty list here made an outage look like "no one recorded yet" (C-17).
        individuals = self.supabase.table("individuals").select("*").execute().data or []
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
            seen = fetch_last_seen(self.supabase, [i["id"] for i in individuals])
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
            seen = fetch_last_seen(self.supabase, [i["id"] for i in page])

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
        response = self.supabase.table("individuals") \
            .delete() \
            .eq("id", str(individual_id)) \
            .execute()
        return bool(response.data)

    async def get_individual_by_id(self, individual_id: UUID) -> Optional[IndividualDetailResponse]:
        """Get individual details with recent interactions"""
        # maybe_single() returns None for zero rows (the only "not found"); any other
        # database error propagates, so an outage is a 500 and not a 404 (C-17).
        individual_response = self.supabase.table("individuals") \
            .select("*") \
            .eq("id", str(individual_id)) \
            .maybe_single() \
            .execute()

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
        interactions_response = interactions_query.execute()
        
        # Format response
        individual_resp = IndividualResponse(
            id=individual["id"],
            name=individual["name"],
            urgency_score=individual["urgency_score"],
            urgency_override=individual.get("urgency_override"),
            display_score=get_display_urgency_score(individual),
            data=individual["data"],
            created_at=individual["created_at"],
            updated_at=individual["updated_at"],
            last_location=individual.get("last_location")
        )
        
        interaction_summaries = [
            InteractionSummary(
                id=i["id"],
                created_at=i["created_at"],
                user_name=i["user_name"],
                location=i.get("location"),
                has_transcription=bool(i.get("transcription"))
            )
            for i in interactions_response.data
        ]
        
        return IndividualDetailResponse(
            individual=individual_resp,
            recent_interactions=interaction_summaries
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
        update_response = update_query.execute()
        
        if not update_response.data:
            raise ValueError(f"Individual not found: {individual_id}")
        
        # Handle both single item and array responses
        if isinstance(update_response.data, list):
            individual = update_response.data[0] if update_response.data else None
        else:
            individual = update_response.data
        
        if not individual:
            raise ValueError(f"Individual not found: {individual_id}")
        
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
        interactions_response = self.supabase.table("interactions") \
            .select("*") \
            .eq("individual_id", str(individual_id)) \
            .order("created_at", desc=True) \
            .range(offset, offset + limit - 1) \
            .execute()
        
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