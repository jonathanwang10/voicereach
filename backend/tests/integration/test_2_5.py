#!/usr/bin/env python3
"""
Test Task 2.5: /api/transcribe Endpoint
"""
import asyncio
import os
import sys
import httpx
import json
from dotenv import load_dotenv

print("Starting Task 2.5 test...")

# Load environment variables
load_dotenv()

# Add backend to path

# Test data
# Import centralized IP configuration
import sys
import os
from tests.integration.conftest import API_URL

TEST_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXItMTIzIn0.test"

# Test cases
TEST_CASES = [
    {
        "name": "Valid request",
        "request": {
            "audio_url": "https://test.supabase.co/storage/v1/object/public/audio/test.m4a",
            "location": {
                "latitude": 37.7749,
                "longitude": -122.4194
            }
        },
        "expect_error": False
    },
    {
        "name": "Missing audio_url",
        "request": {
            "location": {
                "latitude": 37.7749,
                "longitude": -122.4194
            }
        },
        "expect_error": True,
        "expected_status": 422  # Pydantic validation error
    },
    {
        "name": "Invalid URL format",
        "request": {
            "audio_url": "not-a-url"
        },
        "expect_error": True,
        "expected_status": 400
    },
    {
        "name": "No location (optional)",
        "request": {
            "audio_url": "https://test.supabase.co/storage/v1/object/public/audio/test2.m4a"
        },
        "expect_error": False
    }
]

async def test_transcribe_endpoint():
    print("Testing Task 2.5: /api/transcribe Endpoint")
    print("=" * 50)
    
    # Check if server is running
    print("\nChecking if server is running...")
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{API_URL}/health")
            if response.status_code == 200:
                print("✅ Server is running")
            else:
                print("❌ Server returned unexpected status:", response.status_code)
                return
    except Exception as e:
        print(f"❌ Server not running at {API_URL}")
        print("Please start the server with: uvicorn main:app --reload --port 8001")
        return
    
    # Test authorization
    print("\nTesting authorization...")
    try:
        async with httpx.AsyncClient() as client:
            # Test without auth header
            response = await client.post(
                f"{API_URL}/api/transcribe",
                json={"audio_url": "test"}
            )
            if response.status_code == 422:
                print("✅ Missing auth header rejected")
            else:
                print(f"❌ Expected 422 but got {response.status_code}")
    except Exception as e:
        print(f"❌ Error testing auth: {e}")
    
    # Test endpoint structure
    print("\nTesting endpoint structure...")
    headers = {"Authorization": f"Bearer {TEST_TOKEN}"}
    
    for test in TEST_CASES:
        print(f"\nTest: {test['name']}")
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{API_URL}/api/transcribe",
                    json=test["request"],
                    headers=headers,
                    timeout=30.0
                )
                
                print(f"Status: {response.status_code}")
                
                if test["expect_error"]:
                    if response.status_code >= 400:
                        if "expected_status" in test:
                            if response.status_code == test["expected_status"]:
                                print(f"✅ Got expected error status {test['expected_status']}")
                            else:
                                print(f"❌ Expected status {test['expected_status']} but got {response.status_code}")
                        else:
                            print(f"✅ Got error as expected")
                        print(f"Error: {response.json()}")
                    else:
                        print(f"❌ Expected error but got success")
                else:
                    if response.status_code == 200:
                        print(f"✅ Request succeeded")
                        data = response.json()
                        
                        # Validate response structure
                        required_keys = ["transcription", "categorized_data", "missing_required", "potential_matches"]
                        missing_keys = [k for k in required_keys if k not in data]
                        
                        if missing_keys:
                            print(f"❌ Missing response keys: {missing_keys}")
                        else:
                            print(f"✅ Response has all required keys")
                            
                        # Note: Actual transcription will fail without real audio
                        # This is expected for structure testing
                    else:
                        print(f"❌ Expected success but got error")
                        print(f"Error: {response.text}")
                        
        except httpx.TimeoutException:
            print("❌ Request timed out")
        except Exception as e:
            print(f"❌ Error: {e}")
    
    print("\n" + "=" * 50)
    print("Task 2.5 endpoint structure test complete!")
    print("\nNotes:")
    print("- Endpoint accepts audio_url and optional location")
    print("- Requires JWT authorization")
    print("- Returns transcription, categorized data, missing fields, and matches")
    print("- Actual transcription requires real M4A files and API keys")
    print("- Full integration test will be in Task 2.7")
