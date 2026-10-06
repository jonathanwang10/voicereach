"""
Test cases for POST /api/categories endpoint
"""
import pytest
from httpx import AsyncClient
from unittest.mock import patch, MagicMock, AsyncMock
from main import app
from datetime import datetime, timezone
from uuid import uuid4
from api.auth import get_current_user

@pytest.mark.asyncio
class TestCreateCategory:
    
    def setup_method(self):
        """Setup test dependencies"""
        async def mock_auth():
            return "test_user_id"
        app.dependency_overrides[get_current_user] = mock_auth
        
    def teardown_method(self):
        """Cleanup test dependencies"""
        app.dependency_overrides.clear()
    
    async def test_create_category_success(self):
        """Test successful category creation with proper validation"""
        
        # Mock Supabase client
        with patch("api.categories.create_client") as mock_create_client:
            mock_client = MagicMock()
            mock_create_client.return_value = mock_client
            
            # Mock no existing category with same name
            mock_table = MagicMock()
            mock_client.table.return_value = mock_table
            mock_select = MagicMock()
            mock_table.select.return_value = mock_select
            mock_ilike = MagicMock()
            mock_select.ilike.return_value = mock_ilike
            mock_ilike.execute.return_value.data = []
            
            # Mock successful insert
            mock_insert = MagicMock()
            mock_table.insert.return_value = mock_insert
            mock_insert.execute.return_value.data = [{
                "id": str(uuid4()),
                "name": "Test category",  # Capitalized
                "type": "single_select",
                "priority": "high",
                "urgency_weight": 30,
                "auto_trigger": False,
                "is_required": False,
                "is_preset": False,
                "options": [
                    {"label": "Low", "value": 0.2},
                    {"label": "High", "value": 0.8}
                ],
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            }]
            
            async with AsyncClient(app=app, base_url="http://test") as client:
                response = await client.post(
                    "/api/categories",
                    json={
                        "name": "test category",  # Should be capitalized
                        "type": "single_select",
                        "priority": "high",
                        "urgency_weight": 30,
                        "options": [
                            {"label": "Low", "value": 0.2},
                            {"label": "High", "value": 0.8}
                        ]
                    },
                    headers={"Authorization": "Bearer test_token"}
                )
                
            assert response.status_code == 201
            data = response.json()
            assert data["name"] == "Test category"  # Capitalized
            assert data["urgency_weight"] == 30
            
    async def test_reject_invalid_urgency_weight(self):
        """Test rejection when non-numeric/single-select has urgency_weight > 0"""
        
        async with AsyncClient(app=app, base_url="http://test") as client:
            response = await client.post(
                "/api/categories",
                json={
                    "name": "invalid category",
                    "type": "text",
                    "urgency_weight": 50  # Invalid for text type
                },
                headers={"Authorization": "Bearer test_token"}
            )
            
        assert response.status_code == 422  # FastAPI returns 422 for Pydantic validation errors
        assert "urgency_weight" in str(response.json())
            
    async def test_reject_duplicate_name(self):
        """Test rejection when category name already exists"""
        
        with patch("api.categories.create_client") as mock_create_client:
            mock_client = MagicMock()
            mock_create_client.return_value = mock_client
            
            # Mock existing category
            mock_client.table().select().eq().execute.return_value.data = [
                {"name": "Existing category"}
            ]
            
            async with AsyncClient(app=app, base_url="http://test") as client:
                response = await client.post(
                    "/api/categories",
                    json={
                        "name": "existing category",  # Case insensitive duplicate
                        "type": "text"
                    },
                    headers={"Authorization": "Bearer test_token"}
                )
                
        assert response.status_code == 409
                
    async def test_options_validation(self):
        """Test options format validation for different types"""
        
        async with AsyncClient(app=app, base_url="http://test") as client:
            # Invalid options for single_select
            response = await client.post(
                "/api/categories",
                json={
                    "name": "bad options",
                    "type": "single_select",
                    "options": ["Just", "Strings"]  # Should be objects
                },
                headers={"Authorization": "Bearer test_token"}
            )
            
        assert response.status_code == 422  # FastAPI returns 422 for Pydantic validation errors
        assert "options" in str(response.json())
            
    async def test_auto_trigger_validation(self):
        """Test auto_trigger only allowed for number/single_select"""
        
        async with AsyncClient(app=app, base_url="http://test") as client:
            response = await client.post(
                "/api/categories",
                json={
                    "name": "invalid trigger",
                    "type": "multi_select",
                    "auto_trigger": True,  # Invalid for multi_select
                    "options": ["Option1", "Option2"]
                },
                headers={"Authorization": "Bearer test_token"}
            )
            
        assert response.status_code == 422  # FastAPI returns 422 for Pydantic validation errors
        assert "auto_trigger" in str(response.json())
            
    @pytest.mark.real_auth
    @pytest.mark.skip(reason="auth enforced in Task 5A")
    async def test_missing_auth(self):
        """Test authentication required"""
        # Clear auth override for this test
        app.dependency_overrides.clear()
        
        async with AsyncClient(app=app, base_url="http://test") as client:
            response = await client.post(
                "/api/categories",
                json={"name": "test", "type": "text"}
            )
        assert response.status_code in [401, 422]
        
        # Restore auth override for other tests
        async def mock_auth():
            return "test_user_id"
        app.dependency_overrides[get_current_user] = mock_auth