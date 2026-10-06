"""
Integration tests for Task 2.0 - Complete transcription flow
"""
import pytest
import httpx
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Test configuration
# Import centralized IP configuration
from tests.integration.conftest import API_URL

TEST_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXItMTIzIn0.test"

# TODO: Replace these with your actual Supabase Storage URLs after uploading
TEST_AUDIO_FILES = {
    "john": {
        "url": "https://vhfyquescrbwbbvvhxdg.supabase.co/storage/v1/object/public/audio/test-audio-init/john.m4a",
        "expected_transcription": "Met John near Market Street",  # Partial match is fine
        "expected_data": {
            "name": "John",
            "height": 72,  # 6 feet
            "weight": 180,
            "age": "Light"
        },
        "expected_missing": []
    },
    "sarah": {
        "url": "https://vhfyquescrbwbbvvhxdg.supabase.co/storage/v1/object/public/audio/test-audio-init/sarah.m4a",
        "expected_transcription": "Sarah by the library",
        "expected_data": {
            "name": "Sarah",
            "height": 64,  # 5'4"
            "weight": 120,
            "age": "Dark"
        },
        "expected_missing": []
    },
    "robert": {
        "url": "https://vhfyquescrbwbbvvhxdg.supabase.co/storage/v1/object/public/audio/test-audio-init/robert.m4a",
        "expected_transcription": "Robert at Golden Gate Park",
        "expected_data": {
            "name": "Robert",
            "height": 70,  # 5'10"
            "weight": 200,
            "age": "Medium"
        },
        "expected_missing": []
    }
}


@pytest.fixture
async def client():
    """Create HTTP client"""
    async with httpx.AsyncClient(base_url=API_URL) as client:
        yield client


@pytest.fixture
def auth_headers():
    """Get authorization headers"""
    return {"Authorization": f"Bearer {TEST_TOKEN}"}


@pytest.mark.asyncio
async def test_categories_endpoint(client, auth_headers):
    """Test GET /api/categories returns all categories"""
    response = await client.get("/api/categories", headers=auth_headers)
    
    assert response.status_code == 200
    data = response.json()
    assert "categories" in data
    assert len(data["categories"]) >= 6  # At least 6 preset categories
    
    # Verify required categories exist
    category_names = [cat["name"] for cat in data["categories"]]
    assert "name" in category_names
    assert "height" in category_names
    assert "weight" in category_names
    assert "age" in category_names


@pytest.mark.asyncio
async def test_complete_transcription_flow(client, auth_headers):
    """Test complete flow: Upload M4A → Transcribe → Categorize → Validate → Find duplicates"""
    
    # Skip if test URLs not configured
    if "YOUR-PROJECT" in TEST_AUDIO_FILES["john"]["url"]:
        pytest.skip("Test audio URLs not configured. Upload files to Supabase first.")
    
    for test_name, test_data in TEST_AUDIO_FILES.items():
        print(f"\nTesting audio file: {test_name}")
        
        # Make transcription request
        request_data = {
            "audio_url": test_data["url"],
            "location": {
                "latitude": 37.80808794862037,
                "longitude": -122.43016054168524
            }
        }
        
        response = await client.post(
            "/api/transcribe",
            json=request_data,
            headers=auth_headers,
            timeout=30.0
        )
        
        assert response.status_code == 200, f"Failed for {test_name}: {response.text}"
        
        result = response.json()
        
        # Verify response structure
        assert "transcription" in result
        assert "categorized_data" in result
        assert "missing_required" in result
        assert "potential_matches" in result
        
        # Check transcription contains expected text
        if test_data["expected_transcription"]:
            assert test_data["expected_transcription"].lower() in result["transcription"].lower()
        
        # Verify categorized data
        for field, expected_value in test_data["expected_data"].items():
            actual_value = result["categorized_data"].get(field)
            if field == "height":
                # Allow some variance in height parsing
                assert abs(actual_value - expected_value) <= 2, f"Height mismatch for {test_name}"
            else:
                assert actual_value == expected_value, f"{field} mismatch for {test_name}"
        
        # Check missing required fields
        assert set(result["missing_required"]) == set(test_data["expected_missing"])
        
        # Verify danger score exists (even if 0)
        # Note: This would be in the individual record after saving
        
        print(f"✅ {test_name} test passed")


@pytest.mark.asyncio
async def test_duplicate_detection(client, auth_headers):
    """Test duplicate detection with existing data"""
    
    if "YOUR-PROJECT" in TEST_AUDIO_FILES["john"]["url"]:
        pytest.skip("Test audio URLs not configured")
    
    # First transcription (creates John)
    response1 = await client.post(
        "/api/transcribe",
        json={"audio_url": TEST_AUDIO_FILES["john"]["url"]},
        headers=auth_headers
    )
    assert response1.status_code == 200
    
    # Second transcription with same person should find duplicate
    response2 = await client.post(
        "/api/transcribe",
        json={"audio_url": TEST_AUDIO_FILES["john"]["url"]},
        headers=auth_headers
    )
    assert response2.status_code == 200
    
    result = response2.json()
    # Should find at least one potential match
    assert len(result["potential_matches"]) > 0
    # High confidence for exact match
    assert result["potential_matches"][0]["confidence"] > 90


@pytest.mark.asyncio
async def test_missing_required_fields(client, auth_headers):
    """Test audio missing some required fields"""
    # This would test with an audio file that doesn't mention all required fields
    # For now, we'll note this requires specific test audio
    pass


@pytest.mark.asyncio
async def test_performance_requirements(client, auth_headers):
    """Test performance: < 10 seconds for audio processing"""
    
    if "YOUR-PROJECT" in TEST_AUDIO_FILES["john"]["url"]:
        pytest.skip("Test audio URLs not configured")
    
    import time
    
    start_time = time.time()
    
    response = await client.post(
        "/api/transcribe",
        json={"audio_url": TEST_AUDIO_FILES["john"]["url"]},
        headers=auth_headers,
        timeout=15.0
    )
    
    end_time = time.time()
    processing_time = end_time - start_time
    
    assert response.status_code == 200
    assert processing_time < 10.0, f"Processing took {processing_time:.2f} seconds"
    print(f"✅ Performance test passed: {processing_time:.2f} seconds")


@pytest.mark.asyncio
async def test_error_scenarios(client, auth_headers):
    """Test various error scenarios"""
    
    # Invalid URL format
    response = await client.post(
        "/api/transcribe",
        json={"audio_url": "not-a-url"},
        headers=auth_headers
    )
    assert response.status_code == 400
    assert "Invalid URL format" in response.json()["detail"]
    
    # Non-Supabase URL
    response = await client.post(
        "/api/transcribe",
        json={"audio_url": "https://example.com/audio.m4a"},
        headers=auth_headers
    )
    assert response.status_code == 400
    assert "Supabase" in response.json()["detail"]
    
    # Missing authorization
    response = await client.post(
        "/api/transcribe",
        json={"audio_url": "https://test.supabase.co/storage/v1/object/public/audio/test.m4a"}
    )
    assert response.status_code == 422  # Pydantic validation runs first
    
    print("✅ Error handling tests passed")


# To run these tests:
# 1. Upload your M4A files to Supabase Storage
# 2. Update the TEST_AUDIO_FILES URLs above
# 3. Start the server: python3 -m uvicorn main:app --reload --port 8001
# 4. Run tests: python3 -m pytest tests/test_api_integration.py -v
