"""
Integration tests for individuals API endpoints (Task 2.15.3+)
Tests API endpoint functionality
"""
import pytest
from httpx import AsyncClient
from uuid import uuid4
import os
import sys

# Add backend to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


from main import app


@pytest.fixture
def client():
    # sync fixture: async-generator fixtures break on pytest-asyncio 0.21.1 + pytest 8
    return AsyncClient(app=app, base_url="http://test")


@pytest.mark.asyncio
class TestIndividualsAPI:
    """Test individuals API endpoints"""
    
    @pytest.fixture
    def auth_token(self):
        """Get test auth token"""
        # For MVP, we'll use a simple test token
        return "test-token-123"
    
    @pytest.mark.asyncio
    async def test_post_individuals_new(self, client, auth_token):
        """Test creating new individual via API"""
        response = await client.post(
            "/api/individuals",
            json={
                "data": {
                    "name": "Test Person",
                    "height": 70,
                    "weight": 160,
                    "age": "Medium",
                    "gender": "Female"
                },
                "location": {
                    "latitude": 37.7749,
                    "longitude": -122.4194,
                    "address": "123 Test Street, SF"
                }
            },
            headers={"Authorization": f"Bearer {auth_token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["individual"]["name"] == "Test Person"
        assert data["individual"]["urgency_score"] >= 0
        assert data["interaction"]["has_transcription"] == False
    
    @pytest.mark.asyncio
    async def test_post_individuals_missing_required(self, client, auth_token):
        """Test validation for missing required fields"""
        response = await client.post(
            "/api/individuals",
            json={
                "data": {
                    "name": "Test Person",
                    "height": 70
                    # Missing weight and age
                }
            },
            headers={"Authorization": f"Bearer {auth_token}"}
        )
        
        assert response.status_code == 400
        error = response.json()
        assert "Missing required fields" in error["detail"]
    
    @pytest.mark.asyncio
    async def test_post_individuals_merge(self, client, auth_token):
        """Test merging individuals"""
        # First create an individual
        response1 = await client.post(
            "/api/individuals",
            json={
                "data": {
                    "name": "John Doe",
                    "height": 72,
                    "weight": 180,
                    "age": "Light"
                }
            },
            headers={"Authorization": f"Bearer {auth_token}"}
        )
        assert response1.status_code == 200
        individual_id = response1.json()["individual"]["id"]
        
        # Merge with new data
        response2 = await client.post(
            "/api/individuals",
            json={
                "data": {
                    "name": "John Doe",
                    "height": 73,  # Changed
                    "weight": 180,  # Same
                    "age": "Light",  # Same
                    "veteran_status": "Yes"  # New
                },
                "merge_with_id": individual_id
            },
            headers={"Authorization": f"Bearer {auth_token}"}
        )
        
        assert response2.status_code == 200
        data = response2.json()
        assert data["individual"]["id"] == individual_id  # Same ID
        assert data["individual"]["data"]["height"] == 73  # Updated
    
    @pytest.mark.asyncio
    async def test_post_individuals_invalid_merge_id(self, client, auth_token):
        """Test merge with non-existent ID"""
        response = await client.post(
            "/api/individuals",
            json={
                "data": {
                    "name": "Test",
                    "height": 70,
                    "weight": 160,
                    "age": "Light"
                },
                "merge_with_id": str(uuid4())  # Non-existent ID
            },
            headers={"Authorization": f"Bearer {auth_token}"}
        )
        
        assert response.status_code == 404
        assert "Individual not found" in response.json()["detail"]
    
    @pytest.mark.asyncio
    async def test_post_individuals_with_transcription(self, client, auth_token):
        """Test saving from voice transcription"""
        response = await client.post(
            "/api/individuals",
            json={
                "data": {
                    "name": "Voice Person",
                    "height": 68,
                    "weight": 150,
                    "age": "Dark"
                },
                "transcription": "Met Voice Person near the library...",
                "audio_url": "https://example.com/audio.m4a",
                "location": {
                    "latitude": 37.7749,
                    "longitude": -122.4194,
                    "address": "Library Street"
                }
            },
            headers={"Authorization": f"Bearer {auth_token}"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["interaction"]["has_transcription"] == True
    
    @pytest.mark.asyncio
    @pytest.mark.real_auth
    @pytest.mark.skip(reason="auth enforced in Task 5A")
    async def test_post_individuals_no_auth(self, client):
        """Test endpoint requires authentication"""
        response = await client.post(
            "/api/individuals",
            json={
                "data": {
                    "name": "Test",
                    "height": 70,
                    "weight": 160,
                    "age": "Light"
                }
            }
        )
        
        assert response.status_code == 401