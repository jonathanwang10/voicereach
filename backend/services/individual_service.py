"""
Individual management service - handles business logic for individuals
"""
from typing import Dict, Any, Optional, List
from uuid import UUID
from datetime import datetime, timezone
import re
from supabase import Client

from db.models import (
    SaveIndividualRequest,
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
from services.urgency_calculator import calculate_urgency_score


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
        """
        changes = {}
        
        # Check all fields in new data
        for key, new_value in new_data.items():
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

        Logic:
        1. Calculate urgency score
        2. If merge_with_id: update existing individual
        3. Else: create new individual
        4. Create interaction record with changes only
        5. Return both records
        """
        # Calculate urgency score
        # First fetch categories to get urgency weights
        categories_response = self.supabase.table("categories").select("*").execute()
        categories = categories_response.data
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
                .single() \
                .execute()
            
            if not existing_response.data:
                raise ValueError(f"Individual not found: {merge_with_id}")
            
            existing_individual = existing_response.data
            
            # Get changes only
            changes = self.get_changed_fields(existing_individual.get("data", {}), data)
            
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
            
            # Create interaction with all data (first interaction)
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
            
            interaction = interaction_response.data[0]
        
        # Format response
        individual_resp = IndividualResponse(
            id=individual["id"],
            name=individual["name"],
            urgency_score=individual["urgency_score"],
            urgency_override=individual.get("urgency_override"),
            display_score=individual["urgency_override"] if individual.get("urgency_override") is not None else individual["urgency_score"],
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
        Search individuals across all fields.
        
        Search strategy:
        1. If search term: query name AND JSONB data fields
        2. Join with interactions for last_seen
        3. Apply sorting and pagination
        """
        try:
            # Build base query
            query = self.supabase.table("individuals").select("*")
            
            # Apply search if provided
            if search:
                # Search in name field first (simpler approach)
                search_term = f"%{search}%"
                query = query.ilike("name", search_term)
            
            # Execute query
            response = query.execute()
            individuals = response.data
            
            # If search provided, also search in JSONB data
            if search:
                # Get all individuals and filter by JSONB data
                all_response = self.supabase.table("individuals").select("*").execute()
                all_individuals = all_response.data
                
                # Filter by JSONB data containing search term
                jsonb_matches = []
                for ind in all_individuals:
                    if ind["id"] not in [i["id"] for i in individuals]:  # Avoid duplicates
                        data_str = str(ind.get("data", {}))
                        if search.lower() in data_str.lower():
                            jsonb_matches.append(ind)
                
                # Combine results
                individuals.extend(jsonb_matches)
                
                # Remove duplicates
                seen_ids = set()
                unique_individuals = []
                for ind in individuals:
                    if ind["id"] not in seen_ids:
                        seen_ids.add(ind["id"])
                        unique_individuals.append(ind)
                individuals = unique_individuals
            
            # Get total count
            total = len(individuals)
            
            # Apply sorting
            if sort_by == "last_seen":
                # Get last interaction for each individual
                for ind in individuals:
                    last_interaction = self.supabase.table("interactions") \
                        .select("created_at, location") \
                        .eq("individual_id", ind["id"]) \
                        .order("created_at", desc=True) \
                        .limit(1) \
                        .execute()
                    
                    if last_interaction.data:
                        ind["_last_seen"] = last_interaction.data[0]["created_at"]
                        ind["_last_location"] = last_interaction.data[0].get("location")
                    else:
                        ind["_last_seen"] = ind["created_at"]
                        ind["_last_location"] = None
                
                # Sort by last_seen
                individuals.sort(
                    key=lambda x: x["_last_seen"],
                    reverse=(sort_order == "desc")
                )
            elif sort_by == "urgency_score":
                individuals.sort(
                    key=lambda x: x["urgency_score"],
                    reverse=(sort_order == "desc")
                )
            else:  # sort by name
                individuals.sort(
                    key=lambda x: x["name"],
                    reverse=(sort_order == "desc")
                )
            
            # Apply pagination
            paginated = individuals[offset:offset + limit]
            
            # Format results
            results = []
            for ind in paginated:
                # Calculate display score
                display_score = ind["urgency_override"] if ind.get("urgency_override") is not None else ind["urgency_score"]
                
                # Get last location with abbreviated address
                last_location = ind.get("_last_location")
                if last_location and last_location.get("address"):
                    last_location["address"] = self.abbreviate_address(last_location["address"])
                
                results.append(IndividualSummary(
                    id=ind["id"],
                    name=ind["name"],
                    urgency_score=ind["urgency_score"],
                    urgency_override=ind.get("urgency_override"),
                    display_score=display_score,
                    last_seen=ind.get("_last_seen", ind["created_at"]),
                    last_location=last_location
                ))
            
            return SearchIndividualsResponse(
                individuals=results,
                total=total,
                offset=offset,
                limit=limit
            )
            
        except Exception as e:
            print(f"Error in search_individuals: {str(e)}")
            # Return empty results on error
            return SearchIndividualsResponse(
                individuals=[],
                total=0,
                offset=offset,
                limit=limit
            )
    
    async def get_individual_by_id(self, individual_id: UUID) -> Optional[IndividualDetailResponse]:
        """Get individual details with recent interactions"""
        try:
            # Get individual - use .maybe_single() to handle 0 rows gracefully
            individual_query = self.supabase.table("individuals") \
                .select("*") \
                .eq("id", str(individual_id)) \
                .maybe_single()
            
            # Execute the query
            individual_response = individual_query.execute()
            
            if not individual_response.data:
                return None
        except Exception as e:
            # Handle any database errors gracefully
            print(f"Database error getting individual {individual_id}: {str(e)}")
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
            display_score=individual["urgency_override"] if individual.get("urgency_override") is not None else individual["urgency_score"],
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
            .update({
                "urgency_override": urgency_override,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }) \
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
            display_score=individual["urgency_override"] if individual.get("urgency_override") is not None else individual["urgency_score"]
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