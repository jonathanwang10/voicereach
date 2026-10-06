#!/usr/bin/env python3
"""
Test extraction of optional fields from audio transcriptions
"""
import asyncio
import httpx
import json
from tests.integration.test_api_integration import TEST_AUDIO_FILES

# Import centralized IP configuration
import sys
import os
from tests.integration.conftest import API_URL

TEST_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXItMTIzIn0.test"

async def test_optional_fields():
    async with httpx.AsyncClient(base_url=API_URL, timeout=30.0) as client:
        headers = {"Authorization": f"Bearer {TEST_TOKEN}"}
        
        print("="*60)
        print("OPTIONAL FIELDS EXTRACTION TEST")
        print("="*60)
        
        # Test each audio file for optional field extraction
        test_expectations = {
            "john": {
                "transcription_snippet": "moderate substance abuse, been on streets 3 months",
                "expected_fields": {
                    "substance_abuse_history": ["Moderate"],  # Should extract this
                    "age": 45  # Mentioned in audio
                }
            },
            "sarah": {
                "transcription_snippet": "in recovery, looking for shelter",
                "expected_fields": {
                    "substance_abuse_history": ["In Recovery"],  # Should extract this
                    "age": 35  # Mentioned in audio
                }
            },
            "robert": {
                "transcription_snippet": "Veteran, mild substance issues",
                "expected_fields": {
                    "substance_abuse_history": ["Mild"],  # Should extract this
                    "age": 55,  # Mentioned in audio
                    "veteran_status": "Yes"  # If custom category exists
                }
            }
        }
        
        for name, expectations in test_expectations.items():
            print(f"\n\nTesting '{name}' audio for optional fields...")
            
            response = await client.post(
                "/api/transcribe",
                json={
                    "audio_url": TEST_AUDIO_FILES[name]["url"],
                    "location": {"latitude": 37.7749, "longitude": -122.4194}
                },
                headers=headers
            )
            
            if response.status_code == 200:
                result = response.json()
                data = result["categorized_data"]
                
                print(f"\nTranscription snippet: ...{expectations['transcription_snippet']}...")
                print(f"\nExtracted optional fields:")
                
                # Check substance abuse history
                if "substance_abuse_history" in data:
                    print(f"   ✅ substance_abuse_history: {data['substance_abuse_history']}")
                else:
                    print(f"   ❌ substance_abuse_history: Not extracted")
                
                # Check gender (if mentioned)
                if "gender" in data:
                    print(f"   ✅ gender: {data['gender']}")
                else:
                    print(f"   ℹ️  gender: Not mentioned/extracted")
                
                # Check age (not a preset category but might be extracted)
                if "age" in data:
                    print(f"   ℹ️  age: {data['age']} (custom field)")
                
                # Show all extracted fields
                print(f"\nAll extracted fields:")
                for field, value in data.items():
                    print(f"   - {field}: {value}")
                
                # Check if required fields are still being extracted
                required_present = all(field in data for field in ["name", "height", "weight"])
                print(f"\n   {'✅' if required_present else '❌'} All required fields present")
        
        print("\n" + "="*60)
        print("Optional fields test complete!")
        print("="*60)
