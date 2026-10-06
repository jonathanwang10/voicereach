"""
Embedding API endpoints for semantic search and embedding management
"""
from fastapi import APIRouter, Depends, HTTPException
from typing import List, Dict, Any
import json
import os
from services.embedding_service import EmbeddingService
from api.auth import get_current_user
from supabase import create_client, Client
from pydantic import BaseModel

router = APIRouter(prefix="/api/embeddings", tags=["embeddings"])
embedding_service = EmbeddingService()


# Request models
class SearchRequest(BaseModel):
    query: str
    top_k: int = 10
    similarity_threshold: float = 0.15  # Lower threshold for better semantic matching


class GenerateEmbeddingRequest(BaseModel):
    individual_id: str


def get_supabase_client() -> Client:
    """Get Supabase client instance"""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_KEY")
    
    # Ensure real Supabase credentials are provided
    if not url or not key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be provided - no mock data allowed")
    
    return create_client(url, key)


@router.post("/generate")
async def generate_embedding_for_individual(
    request: GenerateEmbeddingRequest,
    user_id: str = Depends(get_current_user)
):
    """
    Generate embedding for a specific individual
    """
    try:
        # Get Supabase client
        supabase = get_supabase_client()
        
        # Get individual data from database
        result = supabase.table("individuals").select("*").eq("id", request.individual_id).execute()
        
        if not result.data:
            raise HTTPException(status_code=404, detail="Individual not found")
        
        individual = result.data[0]
        
        # Generate embedding
        embedding = await embedding_service.generate_individual_embedding(individual)
        
        # Create text representation for storage
        text_parts = []
        if individual.get('name'):
            text_parts.append(f"Name: {individual['name']}")
        if individual.get('data'):
            data = individual['data']
            if data.get('age'):
                text_parts.append(f"Age: {data['age']} years old")
            if data.get('height'):
                text_parts.append(f"Height: {data['height']} inches")
            if data.get('weight'):
                text_parts.append(f"Weight: {data['weight']} pounds")
            if data.get('gender'):
                text_parts.append(f"Gender: {data['gender']}")
            if data.get('substance_abuse_history'):
                text_parts.append(f"Substance abuse: {', '.join(data['substance_abuse_history'])}")
            if data.get('medical_conditions'):
                text_parts.append(f"Medical conditions: {', '.join(data['medical_conditions'])}")
            if data.get('veteran_status'):
                text_parts.append(f"Veteran status: {data['veteran_status']}")
            if data.get('housing_status'):
                text_parts.append(f"Housing status: {data['housing_status']}")
        
        embedding_text = " ".join(text_parts)
        
        # Store embedding in database
        supabase.table("individual_embeddings").upsert({
            "individual_id": request.individual_id,
            "embedding_data": embedding,
            "embedding_text": embedding_text
        }, on_conflict="individual_id").execute()
        
        return {
            "success": True,
            "message": f"Embedding generated and stored for individual {request.individual_id}",
            "embedding_dimensions": len(embedding)
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate embedding: {str(e)}")


@router.post("/search")
async def semantic_search_individuals(
    request: SearchRequest,
    user_id: str = Depends(get_current_user)
):
    """
    Perform hybrid search: normal search + semantic search with embeddings
    """
    try:
        # Get Supabase client
        supabase = get_supabase_client()
        
        # First, always do normal search for exact matches
        normal_results = []
        try:
            # Search individuals table directly for text matches
            search_query = request.query.strip()
            if search_query:
                # Search in name field first (simpler approach)
                search_term = f"%{search_query}%"
                result = supabase.table("individuals").select("*").ilike("name", search_term).execute()
                
                if result.data:
                    normal_results = result.data
                    print(f"🔍 Normal search found {len(normal_results)} results")
                
                # Also search in JSONB data
                all_response = supabase.table("individuals").select("*").execute()
                all_individuals = all_response.data
                
                # Filter by JSONB data containing search term
                jsonb_matches = []
                for ind in all_individuals:
                    if ind["id"] not in [i["id"] for i in normal_results]:  # Avoid duplicates
                        data_str = str(ind.get("data", {}))
                        if search_query.lower() in data_str.lower():
                            jsonb_matches.append(ind)
                
                # Combine results
                normal_results.extend(jsonb_matches)
                
                # Remove duplicates
                seen_ids = set()
                unique_individuals = []
                for ind in normal_results:
                    if ind["id"] not in seen_ids:
                        seen_ids.add(ind["id"])
                        unique_individuals.append(ind)
                normal_results = unique_individuals
        except Exception as e:
            print(f"⚠️ Normal search failed: {str(e)}")
            normal_results = []
        
        # Now try embedding search for semantic matches
        embedding_results = []
        try:
            # Check if embeddings table exists
            try:
                result = supabase.table("individual_embeddings").select("id", count="exact").execute()
                embeddings_exist = True
                print(f"✅ Embeddings table exists")
            except Exception as e:
                if "relation" in str(e).lower() and "does not exist" in str(e).lower():
                    embeddings_exist = False
                    print(f"❌ Embeddings table doesn't exist")
                else:
                    print(f"❌ Error checking embeddings table: {str(e)}")
                    raise e
            
            if embeddings_exist:
                # Get all individual embeddings from database
                print(f"🔍 Fetching embeddings from database...")
                result = supabase.table("individual_embeddings").select("*, individuals(*)").execute()
                print(f"📊 Raw embeddings result: {len(result.data) if result.data else 0} rows")
                
                if result.data and len(result.data) > 0:
                    # Prepare embeddings for search
                    individual_embeddings = []
                    for row in result.data:
                        if row.get('embedding_data') and row.get('individuals'):
                            individual_embeddings.append((row['individual_id'], row['embedding_data']))
                            print(f"  ✅ Added embedding for {row['individuals'].get('name', 'Unknown')}")
                        else:
                            print(f"  ⚠️ Skipping row - missing embedding_data or individuals: {row.keys()}")
                    
                    print(f"📝 Prepared {len(individual_embeddings)} embeddings for search")
                    
                    if individual_embeddings:
                        print(f"🧠 Starting semantic search with threshold {request.similarity_threshold}...")
                        # Perform semantic search
                        search_results = await embedding_service.semantic_search(
                            request.query, 
                            individual_embeddings, 
                            request.top_k,
                            request.similarity_threshold
                        )
                        print(f"🔍 Semantic search returned {len(search_results)} results")
                        
                        # Get full individual data for results
                        for search_result in search_results:
                            individual_id = search_result['individual_id']
                            similarity_score = search_result['similarity_score']
                            print(f"  📊 Result: ID {individual_id}, Score {similarity_score}")
                            
                            # Find the individual data
                            individual_data = next((row['individuals'] for row in result.data if row['individual_id'] == individual_id), None)
                            
                            if individual_data:
                                embedding_results.append({
                                    "id": individual_id,
                                    "name": individual_data.get('name'),
                                    "urgency_score": individual_data.get('urgency_score'),
                                    "urgency_override": individual_data.get('urgency_override'),
                                    "data": individual_data.get('data', {}),
                                    "similarity_score": similarity_score,
                                    "search_type": "semantic"
                                })
                                print(f"    ✅ Added to results: {individual_data.get('name')}")
                            else:
                                print(f"    ❌ Could not find individual data for ID {individual_id}")
                        
                        print(f"🧠 Embedding search found {len(embedding_results)} results")
                    else:
                        print("⚠️ No valid embeddings found in database")
                else:
                    print("⚠️ No embeddings table data found")
            else:
                print("⚠️ Embeddings table doesn't exist yet")
                
        except Exception as e:
            print(f"⚠️ Embedding search failed: {str(e)}")
            import traceback
            traceback.print_exc()
            embedding_results = []
        
        # Combine and deduplicate results
        all_results = []
        seen_ids = set()
        
        # Add normal search results first (exact matches)
        for result in normal_results:
            if result['id'] not in seen_ids:
                seen_ids.add(result['id'])
                all_results.append({
                    "id": result['id'],
                    "name": result.get('name'),
                    "urgency_score": result.get('urgency_score'),
                    "urgency_override": result.get('urgency_override'),
                    "data": result.get('data', {}),
                    "search_type": "exact",
                    "similarity_score": 1.0  # Exact matches get perfect score
                })
        
        # Add embedding search results (semantic matches)
        for result in embedding_results:
            if result['id'] not in seen_ids:
                seen_ids.add(result['id'])
                all_results.append(result)
        
        # Sort by relevance: exact matches first, then by similarity score
        all_results.sort(key=lambda x: (x['search_type'] != 'exact', -x.get('similarity_score', 0)))
        
        print(f"🎯 Combined search found {len(all_results)} total results")
        
        return {
            "results": all_results,
            "query": request.query,
            "total_results": len(all_results),
            "normal_results": len([r for r in all_results if r['search_type'] == 'exact']),
            "semantic_results": len([r for r in all_results if r['search_type'] == 'semantic']),
            "similarity_threshold": request.similarity_threshold
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")


@router.post("/generate-all")
async def generate_embeddings_for_all_individuals(
    user_id: str = Depends(get_current_user)
):
    """
    Generate embeddings for all individuals in the database
    """
    try:
        # Get Supabase client
        supabase = get_supabase_client()
        
        # Get all individuals
        result = supabase.table("individuals").select("*").execute()
        
        if not result.data:
            return {"message": "No individuals found in database"}
        
        individuals = result.data
        
        generated_count = 0
        errors = []
        
        for individual in individuals:
            try:
                # Generate embedding
                embedding = await embedding_service.generate_individual_embedding(individual)
                
                # Create text representation
                text_parts = []
                if individual.get('name'):
                    text_parts.append(f"Name: {individual['name']}")
                if individual.get('data'):
                    data = individual['data']
                    if data.get('age'):
                        text_parts.append(f"Age: {data['age']} years old")
                    if data.get('height'):
                        text_parts.append(f"Height: {data['height']} inches")
                    if data.get('weight'):
                        text_parts.append(f"Weight: {data['weight']} pounds")
                    if data.get('gender'):
                        text_parts.append(f"Gender: {data['gender']}")
                    if data.get('substance_abuse_history'):
                        text_parts.append(f"Substance abuse: {', '.join(data['substance_abuse_history'])}")
                    if data.get('medical_conditions'):
                        text_parts.append(f"Medical conditions: {', '.join(data['medical_conditions'])}")
                    if data.get('veteran_status'):
                        text_parts.append(f"Veteran status: {data['veteran_status']}")
                    if data.get('housing_status'):
                        text_parts.append(f"Housing status: {data['housing_status']}")
                
                embedding_text = " ".join(text_parts)
                
                # Store embedding
                supabase.table("individual_embeddings").upsert({
                    "individual_id": individual['id'],
                    "embedding_data": embedding,
                    "embedding_text": embedding_text
                }, on_conflict="individual_id").execute()
                
                generated_count += 1
                
            except Exception as e:
                errors.append(f"Failed to generate embedding for {individual.get('name', 'Unknown')}: {str(e)}")
                continue
        
        return {
            "success": True,
            "message": f"Generated embeddings for {generated_count} individuals",
            "generated_count": generated_count,
            "errors": errors
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate embeddings: {str(e)}")


@router.get("/status")
async def get_embedding_status(user_id: str = Depends(get_current_user)):
    """
    Get status of embeddings in the database
    """
    try:
        # Get Supabase client
        supabase = get_supabase_client()
        
        # Count total individuals
        total_result = supabase.table("individuals").select("id", count="exact").execute()
        total_individuals = total_result.count if hasattr(total_result, 'count') else len(total_result.data)
        
        # Count individuals with embeddings
        embedding_result = supabase.table("individual_embeddings").select("id", count="exact").execute()
        total_embeddings = embedding_result.count if hasattr(embedding_result, 'count') else len(embedding_result.data)
        
        return {
            "total_individuals": total_individuals,
            "total_embeddings": total_embeddings,
            "coverage_percentage": round((total_embeddings / total_individuals * 100) if total_individuals > 0 else 0, 2)
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get status: {str(e)}")
