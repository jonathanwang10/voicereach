"""
Integration test for category creation and usage
"""
import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import patch, MagicMock
from main import app
from api.auth import get_current_user
from datetime import datetime, timezone
from uuid import uuid4


@pytest.mark.asyncio
class TestCategoryIntegration:
    
    def setup_method(self):
        """Setup test dependencies"""
        async def mock_auth():
            return "test_user_id"
        app.dependency_overrides[get_current_user] = mock_auth
        
    def teardown_method(self):
        """Cleanup test dependencies"""
        app.dependency_overrides.clear()
    
    async def test_create_and_retrieve_category(self):
        """Test creating a category and retrieving it via GET /api/categories"""
        
        with patch("api.categories.create_client") as mock_create_client:
            mock_client = MagicMock()
            mock_create_client.return_value = mock_client
            
            # Create category
            new_category_id = str(uuid4())
            new_category = {
                "id": new_category_id,
                "name": "Emergency status",
                "type": "single_select",
                "is_required": False,
                "is_preset": False,
                "priority": "high",
                "urgency_weight": 50,
                "auto_trigger": False,
                "options": [
                    {"label": "None", "value": 0},
                    {"label": "Medical", "value": 0.8},
                    {"label": "Critical", "value": 1}
                ],
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
            
            # Mock duplicate check
            mock_table = MagicMock()
            mock_client.table.return_value = mock_table
            mock_select = MagicMock()
            mock_table.select.return_value = mock_select
            mock_ilike = MagicMock()
            mock_select.ilike.return_value = mock_ilike
            mock_ilike.execute.return_value.data = []
            
            # Mock insert
            mock_insert = MagicMock()
            mock_table.insert.return_value = mock_insert
            mock_insert.execute.return_value.data = [new_category]
            
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                # Create category
                create_response = await client.post(
                    "/api/categories",
                    json={
                        "name": "emergency status",
                        "type": "single_select",
                        "priority": "high",
                        "urgency_weight": 50,
                        "options": [
                            {"label": "None", "value": 0},
                            {"label": "Medical", "value": 0.8},
                            {"label": "Critical", "value": 1}
                        ]
                    },
                    headers={"Authorization": "Bearer test_token"}
                )
                
                assert create_response.status_code == 201
                created = create_response.json()
                assert created["name"] == "Emergency status"  # Capitalized
                assert created["urgency_weight"] == 50
                
                # Now mock GET categories to include the new one
                mock_table.select.return_value.order.return_value.execute.return_value.data = [
                    # Existing preset categories
                    {
                        "id": "preset1",
                        "name": "name",
                        "type": "text",
                        "is_required": True,
                        "is_preset": True,
                        "priority": "high",
                        "urgency_weight": 0,
                        "auto_trigger": False,
                        "options": None
                    },
                    # Our new category
                    new_category
                ]
                
                # Get all categories
                get_response = await client.get(
                    "/api/categories",
                    headers={"Authorization": "Bearer test_token"}
                )
                
                assert get_response.status_code == 200
                data = get_response.json()
                assert "categories" in data
                assert len(data["categories"]) == 2
                
                # Find our new category
                custom_category = next(
                    (cat for cat in data["categories"] if cat["name"] == "Emergency status"),
                    None
                )
                assert custom_category is not None
                assert custom_category["urgency_weight"] == 50
                assert custom_category["is_preset"] is False