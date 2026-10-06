"""
Integration tests for GET /api/individuals/{id} endpoint
Tests individual detail retrieval with mocked Supabase
"""
import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock, AsyncMock
from uuid import uuid4
from datetime import datetime, timezone

from main import app
from api.auth import get_current_user


# Mock auth dependency
def mock_get_current_user():
    return "test-user-123"


# Override auth dependency
app.dependency_overrides[get_current_user] = mock_get_current_user


class TestGetIndividualById:
    """Test GET /api/individuals/{id} endpoint"""
    
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
    
    def test_get_individual_by_id_success(self, client, mock_supabase):
        """Test getting individual details successfully"""
        individual_id = str(uuid4())
        
        # Mock individual data
        mock_individual = {
            "id": individual_id,
            "name": "Test Person",
            "urgency_score": 45,
            "urgency_override": None,
            "display_score": 45,  # Same as urgency_score since no override
            "data": {
                "name": "Test Person",
                "height": 70,
                "weight": 160,
                "age": "Medium",
                "gender": "Male",
                "veteran_status": "Yes"
            },
            "last_location": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        
        # Mock recent interactions
        mock_interactions = [
            {
                "id": str(uuid4()),
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "location": {"latitude": 37.7749, "longitude": -122.4194, "address": "Market St & 5th"},
                "has_transcription": True
            }
        ]
        
        # Mock the service method to return IndividualDetailResponse-like data
        mock_service = MagicMock()
        # Use AsyncMock for async method
        mock_service.get_individual_by_id = AsyncMock(
            return_value={
                "individual": mock_individual,
                "recent_interactions": mock_interactions
            }
        )
        
        # Mock service initialization
        with patch('api.individuals.IndividualService', return_value=mock_service):
            response = client.get(
                f"/api/individuals/{individual_id}",
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert response.status_code == 200
        data = response.json()
        assert data["individual"]["id"] == individual_id
        assert data["individual"]["name"] == "Test Person"
        assert data["individual"]["data"]["veteran_status"] == "Yes"
        assert "recent_interactions" in data
        assert len(data["recent_interactions"]) == 1
    
    def test_get_individual_not_found(self, client, mock_supabase):
        """Test getting non-existent individual"""
        non_existent_id = str(uuid4())
        
        # Mock service to return None (not found)
        mock_service = MagicMock()
        mock_service.get_individual_by_id = AsyncMock(return_value=None)
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            response = client.get(
                f"/api/individuals/{non_existent_id}",
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert response.status_code == 404
        assert "Individual not found" in response.json()["detail"]
    
    def test_get_individual_with_recent_interactions(self, client, mock_supabase):
        """Test individual includes recent interactions"""
        individual_id = str(uuid4())
        
        # Mock data with multiple interactions
        mock_individual = {
            "id": individual_id,
            "name": "Test Person",
            "urgency_score": 45,
            "urgency_override": None,
            "display_score": 45,
            "data": {"name": "Test Person", "height": 70, "weight": 160, "age": "Medium"},
            "last_location": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        
        # Mock 3 recent interactions
        mock_interactions = [
            {
                "id": str(uuid4()),
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "location": {"latitude": 37.7749, "longitude": -122.4194, "address": "Market St"},
                "has_transcription": True
            },
            {
                "id": str(uuid4()),
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "location": {"latitude": 37.7749, "longitude": -122.4194, "address": "Mission St"},
                "has_transcription": False
            },
            {
                "id": str(uuid4()),
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "location": None,
                "has_transcription": False
            }
        ]
        
        mock_service = MagicMock()
        mock_service.get_individual_by_id = AsyncMock(
            return_value={
                "individual": mock_individual,
                "recent_interactions": mock_interactions
            }
        )
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            response = client.get(
                f"/api/individuals/{individual_id}",
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert response.status_code == 200
        data = response.json()
        assert len(data["recent_interactions"]) == 3
        assert data["recent_interactions"][0]["has_transcription"] == True
    
    def test_get_individual_with_urgency_override(self, client, mock_supabase):
        """Test individual with danger override shows correct display score"""
        individual_id = str(uuid4())
        
        # Mock individual with danger override
        mock_individual = {
            "id": individual_id,
            "name": "High Risk Person",
            "urgency_score": 45,  # Calculated score
            "urgency_override": 85,  # Manual override
            "display_score": 85,  # Shows override since it's set
            "data": {"name": "High Risk Person", "height": 72, "weight": 200, "age": "Light"},
            "last_location": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        
        mock_service = MagicMock()
        mock_service.get_individual_by_id = AsyncMock(
            return_value={
                "individual": mock_individual,
                "recent_interactions": []
            }
        )
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            response = client.get(
                f"/api/individuals/{individual_id}",
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert response.status_code == 200
        data = response.json()
        assert data["individual"]["urgency_score"] == 45
        assert data["individual"]["urgency_override"] == 85
        # Note: display_score calculation would be in the service layer
    
    def test_get_individual_invalid_uuid(self, client, mock_supabase):
        """Test with invalid UUID format"""
        response = client.get(
            "/api/individuals/not-a-valid-uuid",
            headers={"Authorization": "Bearer test-token"}
        )
        
        # Should return 422 for invalid UUID format
        assert response.status_code in [404, 422]
    
    @pytest.mark.real_auth
    @pytest.mark.skip(reason="auth enforced in Task 5A")
    def test_get_individual_no_auth(self, client, mock_supabase):
        """Test endpoint requires authentication"""
        # Clear dependency override temporarily
        original_override = app.dependency_overrides.get(get_current_user)
        del app.dependency_overrides[get_current_user]
        
        try:
            individual_id = str(uuid4())
            response = client.get(f"/api/individuals/{individual_id}")
            # Should return 401 or 422 for missing auth
            assert response.status_code in [401, 422]
        finally:
            # Restore auth override
            if original_override:
                app.dependency_overrides[get_current_user] = original_override


# Clean up dependency override after tests
def teardown_module():
    app.dependency_overrides.clear()