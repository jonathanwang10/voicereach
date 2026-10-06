"""
Integration tests for POST /api/individuals endpoint
Tests with mocked Supabase and auth
"""
import pytest
from fastapi.testclient import TestClient
from unittest.mock import Mock, patch, MagicMock
from uuid import uuid4
from datetime import datetime, timezone

from main import app
from api.auth import get_current_user


# Mock auth dependency
def mock_get_current_user():
    return "test-user-123"


# Override auth dependency
app.dependency_overrides[get_current_user] = mock_get_current_user


class TestPostIndividuals:
    """Test POST /api/individuals endpoint"""
    
    @pytest.fixture
    def client(self):
        """Create test client"""
        return TestClient(app)
    
    @pytest.fixture
    def mock_supabase(self):
        """Mock Supabase client"""
        with patch('api.individuals.get_supabase_client') as mock:
            supabase_mock = MagicMock()
            mock.return_value = supabase_mock
            yield supabase_mock
    
    def test_post_individuals_new_success(self, client, mock_supabase):
        """Test creating new individual successfully"""
        # Mock categories
        mock_supabase.table.return_value.select.return_value.execute.return_value.data = [
            {"name": "height", "type": "number", "urgency_weight": 10},
            {"name": "weight", "type": "number", "urgency_weight": 5}
        ]
        
        # Mock individual creation
        individual_id = str(uuid4())
        mock_supabase.table.return_value.insert.return_value.execute.side_effect = [
            MagicMock(data=[{
                "id": individual_id,
                "name": "Test Person",
                "urgency_score": 15,
                "urgency_override": None,
                "data": {
                    "name": "Test Person",
                    "height": 70,
                    "weight": 160,
                    "age": "Medium"
                },
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            }]),
            MagicMock(data=[{
                "id": str(uuid4()),
                "individual_id": individual_id,
                "user_id": "test-user-123",
                "user_name": "Demo User",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "location": {"latitude": 37.7749, "longitude": -122.4194, "address": "123 Test Street"},
                "changes": {
                    "name": "Test Person",
                    "height": 70,
                    "weight": 160,
                    "age": "Medium"
                }
            }])
        ]
        
        response = client.post(
            "/api/individuals",
            json={
                "data": {
                    "name": "Test Person",
                    "height": 70,
                    "weight": 160,
                    "age": "Medium"
                },
                "location": {
                    "latitude": 37.7749,
                    "longitude": -122.4194,
                    "address": "123 Test Street"
                }
            },
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["individual"]["name"] == "Test Person"
        assert data["individual"]["urgency_score"] >= 0
        assert data["interaction"]["has_transcription"] == False
    
    def test_post_individuals_missing_required_fields(self, client, mock_supabase):
        """Test validation for missing required fields"""
        # Mock categories for validation
        mock_supabase.table.return_value.select.return_value.execute.return_value.data = [
            {"name": "height", "type": "number", "is_required": True},
            {"name": "weight", "type": "number", "is_required": True},
            {"name": "age", "type": "single_select", "is_required": True}
        ]
        
        response = client.post(
            "/api/individuals",
            json={
                "data": {
                    "name": "Test Person",
                    "height": 70
                    # Missing weight and age
                }
            },
            headers={"Authorization": "Bearer test-token"}
        )
        
        # 422 is returned by Pydantic validation in the model
        assert response.status_code == 422
        error_detail = response.json()["detail"]
        # Check that it's about missing required fields
        assert any("Missing required fields" in str(error) for error in error_detail)
    
    def test_post_individuals_merge_success(self, client, mock_supabase):
        """Test merging individuals successfully"""
        merge_id = str(uuid4())
        
        # Mock categories
        mock_supabase.table.return_value.select.return_value.execute.return_value.data = []
        
        # Mock existing individual for merge check - use side_effect for multiple calls
        mock_supabase.table.return_value.select.return_value.eq.return_value.maybe_single.return_value.execute.side_effect = [
            MagicMock(data={
                "id": merge_id,
                "name": "John Doe",
                "urgency_score": 50,
                "urgency_override": None,
                "data": {"name": "John Doe", "height": 72, "weight": 180, "age": "Light"},
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            }),
            MagicMock(data={
                "id": merge_id,
                "name": "John Doe",
                "urgency_score": 50,
                "urgency_override": None,
                "data": {"name": "John Doe", "height": 72, "weight": 180, "age": "Light"},
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            })
        ]
        
        # Mock update
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value.data = [{
            "id": merge_id,
            "name": "John Doe",
            "urgency_score": 0,
            "urgency_override": None,
            "data": {
                "name": "John Doe",
                "height": 73,
                "weight": 180,
                "age": "Light",
                "veteran_status": "Yes"
            },
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }]
        
        # Mock interaction
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [{
            "id": str(uuid4()),
            "individual_id": merge_id,
            "changes": {"height": 73, "veteran_status": "Yes"},
            "user_name": "Demo User",
            "created_at": datetime.now(timezone.utc).isoformat()
        }]
        
        # Mock interaction query for response - need to handle the individual service's get_individual_by_id
        # This is called after saving to get recent interactions
        mock_supabase.table.return_value.select.return_value.eq.return_value.order.return_value.limit.return_value.execute.return_value.data = [{
            "id": str(uuid4()),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "user_name": "Demo User",
            "location": None,
            "transcription": None
        }]
        
        response = client.post(
            "/api/individuals",
            json={
                "data": {
                    "name": "John Doe",
                    "height": 73,
                    "weight": 180,
                    "age": "Light",
                    "veteran_status": "Yes"
                },
                "merge_with_id": merge_id
            },
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["individual"]["id"] == merge_id
    
    def test_post_individuals_merge_not_found(self, client, mock_supabase):
        """Test merge with non-existent individual"""
        # Mock categories
        mock_supabase.table.return_value.select.return_value.execute.return_value.data = []
        
        # Mock individual not found - empty data
        mock_supabase.table.return_value.select.return_value.eq.return_value.maybe_single.return_value.execute.return_value.data = None
        
        # Mock empty interactions
        mock_supabase.table.return_value.select.return_value.eq.return_value.order.return_value.limit.return_value.execute.return_value.data = []
        
        response = client.post(
            "/api/individuals",
            json={
                "data": {
                    "name": "Test",
                    "height": 70,
                    "weight": 160,
                    "age": "Light"
                },
                "merge_with_id": str(uuid4())
            },
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 404
        assert "Individual not found" in response.json()["detail"]
    
    def test_post_individuals_with_transcription(self, client, mock_supabase):
        """Test saving with transcription data"""
        # Mock categories
        mock_supabase.table.return_value.select.return_value.execute.return_value.data = []
        
        # Mock individual creation
        individual_id = str(uuid4())
        mock_supabase.table.return_value.insert.return_value.execute.side_effect = [
            MagicMock(data=[{
                "id": individual_id,
                "name": "Voice Person",
                "urgency_score": 0,
                "data": {
                    "name": "Voice Person",
                    "height": 68,
                    "weight": 150,
                    "age": "Dark"
                },
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            }]),
            MagicMock(data=[{
                "id": str(uuid4()),
                "transcription": "Met Voice Person near the library...",
                "audio_url": "https://example.com/audio.m4a",
                "user_name": "Demo User",
                "created_at": datetime.now(timezone.utc).isoformat()
            }])
        ]
        
        response = client.post(
            "/api/individuals",
            json={
                "data": {
                    "name": "Voice Person",
                    "height": 68,
                    "weight": 150,
                    "age": "Dark"
                },
                "transcription": "Met Voice Person near the library...",
                "audio_url": "https://example.com/audio.m4a"
            },
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["interaction"]["has_transcription"] == True


# Clean up dependency override after tests
def teardown_module():
    app.dependency_overrides.clear()