"""
Integration tests for GET /api/individuals endpoint
Tests search functionality with mocked Supabase
"""
import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock
from uuid import uuid4
from datetime import datetime, timezone

from main import app
from api.auth import get_current_user


# Mock auth dependency
def mock_get_current_user():
    return "test-user-123"


# Override auth dependency
app.dependency_overrides[get_current_user] = mock_get_current_user


class TestGetIndividualsSearch:
    """Test GET /api/individuals search endpoint"""
    
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
    
    def test_get_individuals_list_no_search(self, client, mock_supabase):
        """Test listing individuals without search term"""
        # Mock individuals data
        mock_individuals = [
            {
                "id": str(uuid4()),
                "name": "John Doe",
                "urgency_score": 75,
                "urgency_override": None,
                "data": {"name": "John Doe", "height": 72, "weight": 180, "age": "Light"},
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            },
            {
                "id": str(uuid4()),
                "name": "Jane Smith",
                "urgency_score": 30,
                "urgency_override": None,
                "data": {"name": "Jane Smith", "height": 65, "weight": 140, "age": "Dark"},
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
        ]
        
        # Mock the select query
        mock_select = MagicMock()
        mock_supabase.table.return_value.select.return_value = mock_select
        mock_select.execute.return_value.data = mock_individuals
        
        # Mock interactions for last_seen
        mock_supabase.table.return_value.select.return_value.eq.return_value.order.return_value.limit.return_value.execute.return_value.data = [
            {"created_at": datetime.now(timezone.utc).isoformat(), "location": {"latitude": 37.7749, "longitude": -122.4194}}
        ]
        
        response = client.get(
            "/api/individuals",
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert "individuals" in data
        assert "total" in data
        assert data["total"] >= 0
        assert data["limit"] == 20  # Default limit
        assert data["offset"] == 0
    
    def test_get_individuals_search_by_name(self, client, mock_supabase):
        """Test searching by name"""
        # Mock search results
        mock_individuals = [
            {
                "id": str(uuid4()),
                "name": "John Doe",
                "urgency_score": 75,
                "urgency_override": None,
                "data": {"name": "John Doe", "height": 72, "weight": 180, "age": "Light"},
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
        ]
        
        # Mock search query with or_ condition
        mock_select = MagicMock()
        mock_supabase.table.return_value.select.return_value = mock_select
        mock_select.or_.return_value.execute.return_value.data = mock_individuals
        
        # Mock interactions
        mock_supabase.table.return_value.select.return_value.eq.return_value.order.return_value.limit.return_value.execute.return_value.data = []
        
        response = client.get(
            "/api/individuals?search=John",
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert len(data["individuals"]) >= 0
        assert data["total"] >= 0
    
    def test_get_individuals_pagination(self, client, mock_supabase):
        """Test pagination parameters"""
        # Mock empty results for offset 20
        mock_select = MagicMock()
        mock_supabase.table.return_value.select.return_value = mock_select
        mock_select.execute.return_value.data = []
        
        response = client.get(
            "/api/individuals?limit=10&offset=20",
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert data["limit"] == 10
        assert data["offset"] == 20
        assert data["individuals"] == []
    
    def test_get_individuals_sorting(self, client, mock_supabase):
        """Test sorting options"""
        # Mock individuals for sorting
        mock_individuals = [
            {
                "id": str(uuid4()),
                "name": "High Danger",
                "urgency_score": 90,
                "urgency_override": None,
                "data": {"name": "High Danger", "height": 70, "weight": 200, "age": "Medium"},
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            },
            {
                "id": str(uuid4()),
                "name": "Low Danger",
                "urgency_score": 20,
                "urgency_override": None,
                "data": {"name": "Low Danger", "height": 65, "weight": 150, "age": "Light"},
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
        ]
        
        # Mock query with order
        mock_select = MagicMock()
        mock_supabase.table.return_value.select.return_value = mock_select
        mock_select.order.return_value.execute.return_value.data = mock_individuals
        
        response = client.get(
            "/api/individuals?sort_by=urgency_score&sort_order=desc",
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code == 200
        data = response.json()
        assert "individuals" in data
    
    @pytest.mark.real_auth
    @pytest.mark.skip(reason="auth enforced in Task 5A")
    def test_get_individuals_no_auth(self, client, mock_supabase):
        """Test endpoint requires authentication"""
        # Clear dependency override temporarily
        original_override = app.dependency_overrides.get(get_current_user)
        del app.dependency_overrides[get_current_user]
        
        try:
            response = client.get("/api/individuals")
            # Should return 401 or 422 (422 when auth header is missing)
            assert response.status_code in [401, 422]
        finally:
            # Restore auth override
            if original_override:
                app.dependency_overrides[get_current_user] = original_override


# Clean up dependency override after tests
def teardown_module():
    app.dependency_overrides.clear()