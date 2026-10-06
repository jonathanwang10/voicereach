"""
Integration tests for PUT /api/individuals/{id}/urgency-override endpoint
Tests manual urgency score override functionality
"""
import pytest
from fastapi.testclient import TestClient
from unittest.mock import Mock, patch, MagicMock, AsyncMock
from uuid import uuid4
from datetime import datetime, timezone

from main import app
from api.auth import get_current_user


# Mock auth dependency
def mock_get_current_user():
    return "test-user-123"


# Override auth dependency
app.dependency_overrides[get_current_user] = mock_get_current_user


class TestUrgencyOverride:
    """Test PUT /api/individuals/{id}/urgency-override endpoint"""
    
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
    
    def test_set_urgency_override_success(self, client, mock_supabase):
        """Test setting urgency override value"""
        individual_id = str(uuid4())
        
        # Mock the update operation
        mock_update = MagicMock()
        mock_supabase.table.return_value.update.return_value = mock_update
        mock_update.eq.return_value.execute.return_value.data = [{
            "id": individual_id,
            "urgency_score": 45,  # Original calculated score
            "urgency_override": 85  # New override value
        }]
        
        response = client.put(
            f"/api/individuals/{individual_id}/urgency-override",
            json={"urgency_override": 85},
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["urgency_score"] == 45
        assert data["urgency_override"] == 85
        assert data["display_score"] == 85  # Should show override
    
    def test_remove_urgency_override(self, client, mock_supabase):
        """Test removing urgency override (null)"""
        individual_id = str(uuid4())
        
        # Mock the update operation
        mock_update = MagicMock()
        mock_supabase.table.return_value.update.return_value = mock_update
        mock_update.eq.return_value.execute.return_value.data = [{
            "id": individual_id,
            "urgency_score": 45,
            "urgency_override": None  # Override removed
        }]
        
        response = client.put(
            f"/api/individuals/{individual_id}/urgency-override",
            json={"urgency_override": None},
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["urgency_score"] == 45
        assert data["urgency_override"] is None
        assert data["display_score"] == 45  # Should show calculated score
    
    def test_urgency_override_validation_min(self, client, mock_supabase):
        """Test urgency override minimum value validation"""
        individual_id = str(uuid4())
        
        response = client.put(
            f"/api/individuals/{individual_id}/urgency-override",
            json={"urgency_override": -1},  # Invalid: less than 0
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 422  # Validation error
    
    def test_urgency_override_validation_max(self, client, mock_supabase):
        """Test urgency override maximum value validation"""
        individual_id = str(uuid4())
        
        response = client.put(
            f"/api/individuals/{individual_id}/urgency-override",
            json={"urgency_override": 101},  # Invalid: greater than 100
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 422  # Validation error
    
    def test_urgency_override_individual_not_found(self, client, mock_supabase):
        """Test updating non-existent individual"""
        individual_id = str(uuid4())
        
        # Mock empty result (not found)
        mock_update = MagicMock()
        mock_supabase.table.return_value.update.return_value = mock_update
        mock_update.eq.return_value.execute.return_value.data = []
        
        response = client.put(
            f"/api/individuals/{individual_id}/urgency-override",
            json={"urgency_override": 50},
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 404
        assert "Individual not found" in response.json()["detail"]
    
    def test_urgency_override_edge_values(self, client, mock_supabase):
        """Test edge values (0 and 100)"""
        individual_id = str(uuid4())
        
        # Test 0 value
        mock_update = MagicMock()
        mock_supabase.table.return_value.update.return_value = mock_update
        mock_update.eq.return_value.execute.return_value.data = [{
            "id": individual_id,
            "urgency_score": 75,
            "urgency_override": 0
        }]
        
        response = client.put(
            f"/api/individuals/{individual_id}/urgency-override",
            json={"urgency_override": 0},
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["urgency_override"] == 0
        assert data["display_score"] == 0
        
        # Test 100 value
        mock_update.eq.return_value.execute.return_value.data = [{
            "id": individual_id,
            "urgency_score": 75,
            "urgency_override": 100
        }]
        
        response = client.put(
            f"/api/individuals/{individual_id}/urgency-override",
            json={"urgency_override": 100},
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["urgency_override"] == 100
        assert data["display_score"] == 100
    
    @pytest.mark.real_auth
    @pytest.mark.skip(reason="auth enforced in Task 5A")
    def test_urgency_override_no_auth(self, client, mock_supabase):
        """Test endpoint requires authentication"""
        # Clear dependency override temporarily
        original_override = app.dependency_overrides.get(get_current_user)
        del app.dependency_overrides[get_current_user]
        
        try:
            individual_id = str(uuid4())
            response = client.put(
                f"/api/individuals/{individual_id}/urgency-override",
                json={"urgency_override": 50}
            )
            assert response.status_code in [401, 422]
        finally:
            # Restore auth override
            if original_override:
                app.dependency_overrides[get_current_user] = original_override


# Clean up dependency override after tests
def teardown_module():
    app.dependency_overrides.clear()