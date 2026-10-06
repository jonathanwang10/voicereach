#!/usr/bin/env python3
"""
Setup script to generate embeddings for all existing individuals in the database
Run this after setting up the embeddings table to populate it with initial data
"""
import asyncio
import os
import sys
from dotenv import load_dotenv

# Add the backend directory (this file's parent's parent) to the Python path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.embedding_service import EmbeddingService
from supabase import create_client, Client
import json

def get_supabase_client() -> Client:
    """Get Supabase client instance"""
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_KEY")
    
    # Ensure real Supabase credentials are provided
    if not url or not key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_KEY must be provided - no mock data allowed")
    
    return create_client(url, key)

async def setup_embeddings():
    """Generate embeddings for all existing individuals"""
    load_dotenv()
    
    print("🚀 Starting embedding setup...")
    
    # Check if OpenAI API key is set
    if not os.getenv("OPENAI_API_KEY"):
        print("❌ OPENAI_API_KEY not found in environment variables")
        print("Please set OPENAI_API_KEY in your .env file")
        return
    
    embedding_service = EmbeddingService()
    
    try:
        # Get database connection
        supabase = get_supabase_client()
        print("📊 Connected to database")
        
        # Count total individuals
        result = supabase.table("individuals").select("id", count="exact").execute()
        total_individuals = result.count if hasattr(result, 'count') else len(result.data)
        print(f"📋 Found {total_individuals} individuals in database")
        
        if total_individuals == 0:
            print("⚠️ No individuals found in database")
            return
        
        # Check existing embeddings
        embedding_result = supabase.table("individual_embeddings").select("id", count="exact").execute()
        existing_embeddings = embedding_result.count if hasattr(embedding_result, 'count') else len(embedding_result.data)
        print(f"🧠 Found {existing_embeddings} existing embeddings")
        
        # Get all individuals
        result = supabase.table("individuals").select("*").execute()
        individuals = result.data
        
        generated_count = 0
        errors = []
        
        print(f"🔄 Generating embeddings for {total_individuals} individuals...")
        
        for i, individual in enumerate(individuals, 1):
            try:
                print(f"  [{i}/{total_individuals}] Processing {individual.get('name', 'Unknown')}...")
                
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
                print(f"    ✅ Generated embedding ({len(embedding)} dimensions)")
                
                # Small delay to avoid rate limiting
                await asyncio.sleep(0.1)
                
            except Exception as e:
                error_msg = f"Failed to generate embedding for {individual.get('name', 'Unknown')}: {str(e)}"
                print(f"    ❌ {error_msg}")
                errors.append(error_msg)
                continue
        
        print(f"\n🎉 Embedding setup completed!")
        print(f"✅ Successfully generated: {generated_count} embeddings")
        if errors:
            print(f"❌ Errors: {len(errors)}")
            for error in errors[:5]:  # Show first 5 errors
                print(f"   - {error}")
            if len(errors) > 5:
                print(f"   ... and {len(errors) - 5} more errors")
        
        # Verify final count
        final_result = supabase.table("individual_embeddings").select("id", count="exact").execute()
        final_embeddings = final_result.count if hasattr(final_result, 'count') else len(final_result.data)
        print(f"📊 Total embeddings in database: {final_embeddings}")
        
    except Exception as e:
        print(f"❌ Setup failed: {str(e)}")
        raise

if __name__ == "__main__":
    asyncio.run(setup_embeddings())
