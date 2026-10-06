#!/usr/bin/env python3
"""
Test duplicate detection functionality
"""
import asyncio
import httpx
from tests.integration.test_api_integration import TEST_AUDIO_FILES

# Import centralized IP configuration
from tests.integration.conftest import API_URL

TEST_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXItMTIzIn0.test"

async def test_duplicate_detection():
    async with httpx.AsyncClient(base_url=API_URL, timeout=30.0) as client:
        headers = {"Authorization": f"Bearer {TEST_TOKEN}"}
        
        print("="*60)
        print("DUPLICATE DETECTION TEST")
        print("="*60)
        
        # First, let's check if there are any existing individuals
        # We'll use a simple test by transcribing the same audio twice
        
        print("\n1. First transcription of 'John' audio...")
        response1 = await client.post(
            "/api/transcribe",
            json={
                "audio_url": TEST_AUDIO_FILES["john"]["url"],
                "location": {"latitude": 37.7749, "longitude": -122.4194}
            },
            headers=headers
        )
        
        if response1.status_code == 200:
            result1 = response1.json()
            print(f"   ✅ Transcribed: {result1['transcription'][:50]}...")
            print(f"   Extracted name: {result1['categorized_data'].get('name')}")
            print(f"   Potential matches found: {len(result1['potential_matches'])}")
            
            if result1['potential_matches']:
                for match in result1['potential_matches']:
                    print(f"   - {match['name']}: {match['confidence']}% confidence")
        
        # Small delay to ensure any DB operations complete
        await asyncio.sleep(1)
        
        print("\n2. Second transcription of same 'John' audio...")
        response2 = await client.post(
            "/api/transcribe",
            json={
                "audio_url": TEST_AUDIO_FILES["john"]["url"],
                "location": {"latitude": 37.7749, "longitude": -122.4194}
            },
            headers=headers
        )
        
        if response2.status_code == 200:
            result2 = response2.json()
            print(f"   ✅ Transcribed: {result2['transcription'][:50]}...")
            print(f"   Extracted name: {result2['categorized_data'].get('name')}")
            print(f"   Potential matches found: {len(result2['potential_matches'])}")
            
            if result2['potential_matches']:
                print("\n   Potential duplicates detected:")
                for match in result2['potential_matches']:
                    print(f"   - ID: {match['id'][:8]}...")
                    print(f"     Name: {match['name']}")
                    print(f"     Confidence: {match['confidence']}%")
                    
                    if match['confidence'] >= 95:
                        print(f"     🔄 Would auto-merge (confidence >= 95%)")
                    else:
                        print(f"     👤 Would show merge UI")
            else:
                print("   ⚠️  No duplicates found (might need to save individuals first)")
        
        # Test with similar but different data
        print("\n3. Testing with modified transcription...")
        
        # Create a test request with slightly different data
        test_transcription = "Met Johnny near Market Street. About 45 years old, 6 feet tall, maybe 175 pounds. Light skin."
        
        # We'll simulate this by testing if the API would detect similarity
        # In a real scenario, we'd need to save the first individual to the database
        
        print("\n" + "="*60)
        print("Note: Full duplicate detection requires saving individuals to database.")
        print("In production, the flow would be:")
        print("1. Transcribe → 2. Check duplicates → 3. Save/Merge → 4. Return result")
        print("="*60)
