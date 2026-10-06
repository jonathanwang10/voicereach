"""
Integration tests for GET /api/individuals/{id}/interactions endpoint
Tests detailed interaction history retrieval
"""
import pytest
from fastapi.testclient import TestClient
from unittest.mock import Mock, patch, MagicMock
from uuid import uuid4
from datetime import datetime, timezone, timedelta

from main import app
from api.auth import get_current_user


# Mock auth dependency
def mock_get_current_user():
    return "test-user-123"


# Override auth dependency
app.dependency_overrides[get_current_user] = mock_get_current_user


class TestGetInteractions:
    """Test GET /api/individuals/{id}/interactions endpoint"""
    
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
    
    def test_get_interactions_success(self, client, mock_supabase):
        """Test getting interaction history successfully"""
        individual_id = str(uuid4())
        
        # Mock interactions data
        mock_interactions = [
            {
                "id": str(uuid4()),
                "individual_id": individual_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "transcription": "Met John near Market Street. About 45 years old, 6 feet tall...",
                "location": {
                    "latitude": 37.7749,
                    "longitude": -122.4194,
                    "address": "123 Market Street, San Francisco, CA 94103"  # Full address
                },
                "changes": {
                    "height": 72,
                    "veteran_status": "Yes"
                }
            },
            {
                "id": str(uuid4()),
                "individual_id": individual_id,
                "created_at": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
                "user_name": "Demo User",
                "transcription": None,  # Manual entry
                "location": {
                    "latitude": 37.7849,
                    "longitude": -122.4094,
                    "address": "456 Mission Street, San Francisco, CA 94105"
                },
                "changes": {
                    "substance_abuse_history": ["Moderate"],
                    "housing_priority": "High"
                }
            },
            {
                "id": str(uuid4()),
                "individual_id": individual_id,
                "created_at": (datetime.now(timezone.utc) - timedelta(days=7)).isoformat(),
                "user_name": "Demo User",
                "transcription": None,
                "location": None,  # No location
                "changes": {
                    "name": "John Doe",
                    "height": 70,
                    "weight": 160,
                    "age": "Light"
                }
            }
        ]
        
        # Mock the query
        mock_select = MagicMock()
        mock_supabase.table.return_value.select.return_value = mock_select
        mock_select.eq.return_value.order.return_value.limit.return_value.offset.return_value.execute.return_value.data = mock_interactions
        
        response = client.get(
            f"/api/individuals/{individual_id}/interactions",
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert "interactions" in data
        assert len(data["interactions"]) == 3
        
        # Check first interaction
        first = data["interactions"][0]
        assert "id" in first
        assert "created_at" in first
        assert first["user_name"] == "Demo User"
        assert first["transcription"] is not None
        assert first["location"]["address"] == "123 Market Street, San Francisco, CA 94103"
        assert first["changes"]["height"] == 72
    
    def test_get_interactions_pagination(self, client, mock_supabase):
        """Test interaction pagination"""
        individual_id = str(uuid4())
        
        # Mock limited results
        mock_interactions = [
            {
                "id": str(uuid4()),
                "individual_id": individual_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "transcription": None,
                "location": None,
                "changes": {"weight": 165}
            }
        ]
        
        # Mock query with pagination
        mock_select = MagicMock()
        mock_supabase.table.return_value.select.return_value = mock_select
        mock_select.eq.return_value.order.return_value.limit.return_value.offset.return_value.execute.return_value.data = mock_interactions
        
        response = client.get(
            f"/api/individuals/{individual_id}/interactions?limit=10&offset=20",
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert len(data["interactions"]) == 1
    
    def test_get_interactions_empty(self, client, mock_supabase):
        """Test individual with no interactions"""
        individual_id = str(uuid4())
        
        # Mock empty results
        mock_select = MagicMock()
        mock_supabase.table.return_value.select.return_value = mock_select
        mock_select.eq.return_value.order.return_value.limit.return_value.offset.return_value.execute.return_value.data = []
        
        response = client.get(
            f"/api/individuals/{individual_id}/interactions",
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["interactions"] == []
    
    def test_get_interactions_chronological_order(self, client, mock_supabase):
        """Test interactions are returned in chronological order"""
        individual_id = str(uuid4())
        
        # Create timestamps
        now = datetime.now(timezone.utc)
        timestamps = [
            now.isoformat(),
            (now - timedelta(hours=1)).isoformat(),
            (now - timedelta(days=1)).isoformat()
        ]
        
        # Mock interactions in chronological order (newest first)
        mock_interactions = [
            {
                "id": str(uuid4()),
                "individual_id": individual_id,
                "created_at": timestamps[0],
                "user_name": "Demo User",
                "transcription": None,
                "location": None,
                "changes": {"field1": "value1"}
            },
            {
                "id": str(uuid4()),
                "individual_id": individual_id,
                "created_at": timestamps[1],
                "user_name": "Demo User",
                "transcription": None,
                "location": None,
                "changes": {"field2": "value2"}
            },
            {
                "id": str(uuid4()),
                "individual_id": individual_id,
                "created_at": timestamps[2],
                "user_name": "Demo User",
                "transcription": None,
                "location": None,
                "changes": {"field3": "value3"}
            }
        ]
        
        # Mock query
        mock_select = MagicMock()
        mock_supabase.table.return_value.select.return_value = mock_select
        mock_select.eq.return_value.order.return_value.limit.return_value.offset.return_value.execute.return_value.data = mock_interactions
        
        response = client.get(
            f"/api/individuals/{individual_id}/interactions",
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        
        # Check order
        for i in range(len(data["interactions"]) - 1):
            current_time = datetime.fromisoformat(data["interactions"][i]["created_at"].replace("Z", "+00:00"))
            next_time = datetime.fromisoformat(data["interactions"][i + 1]["created_at"].replace("Z", "+00:00"))
            assert current_time >= next_time  # Newest first
    
    def test_get_interactions_with_voice_transcription(self, client, mock_supabase):
        """Test interactions show transcription for voice entries"""
        individual_id = str(uuid4())
        
        # Mock interactions with and without transcription
        mock_interactions = [
            {
                "id": str(uuid4()),
                "individual_id": individual_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "transcription": "Sarah by the library, approximately 35, 5 foot 4, 120 pounds...",
                "location": None,
                "changes": {"name": "Sarah Smith", "height": 64}
            },
            {
                "id": str(uuid4()),
                "individual_id": individual_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "transcription": None,  # Manual entry
                "location": None,
                "changes": {"medical_conditions": ["Diabetes"]}
            }
        ]
        
        # Mock query
        mock_select = MagicMock()
        mock_supabase.table.return_value.select.return_value = mock_select
        mock_select.eq.return_value.order.return_value.limit.return_value.offset.return_value.execute.return_value.data = mock_interactions
        
        response = client.get(
            f"/api/individuals/{individual_id}/interactions",
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        
        # First interaction has transcription
        assert data["interactions"][0]["transcription"] is not None
        assert "Sarah" in data["interactions"][0]["transcription"]
        
        # Second interaction doesn't have transcription
        assert data["interactions"][1]["transcription"] is None
    
    def test_get_interactions_invalid_uuid(self, client, mock_supabase):
        """Test with invalid UUID format"""
        response = client.get(
            "/api/individuals/not-a-valid-uuid/interactions",
            headers={"Authorization": "Bearer test-token"}
        )
        
        # Should return 422 for invalid UUID format
        assert response.status_code in [404, 422]
    
    @pytest.mark.real_auth
    @pytest.mark.skip(reason="auth enforced in Task 5A")
    def test_get_interactions_no_auth(self, client, mock_supabase):
        """Test endpoint requires authentication"""
        # Clear dependency override temporarily
        original_override = app.dependency_overrides.get(get_current_user)
        del app.dependency_overrides[get_current_user]
        
        try:
            individual_id = str(uuid4())
            response = client.get(f"/api/individuals/{individual_id}/interactions")
            assert response.status_code in [401, 422]
        finally:
            # Restore auth override
            if original_override:
                app.dependency_overrides[get_current_user] = original_override


# Clean up dependency override after tests
def teardown_module():
    app.dependency_overrides.clear()