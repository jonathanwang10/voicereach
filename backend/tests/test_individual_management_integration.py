"""
Comprehensive integration tests for individual management endpoints
Tests the full flow of all endpoints working together
"""
import pytest
from fastapi.testclient import TestClient
from unittest.mock import Mock, patch, MagicMock, AsyncMock
from uuid import uuid4
from datetime import datetime, timezone, timedelta
import time

from main import app
from tests.helpers import save_response
from api.auth import get_current_user


# Mock auth dependency
def mock_get_current_user():
    return "test-user-123"


# Override auth dependency
app.dependency_overrides[get_current_user] = mock_get_current_user


class TestIndividualManagementIntegration:
    """Test all individual management endpoints working together"""
    
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
    
    @pytest.fixture
    def mock_categories(self):
        """Mock categories data"""
        return [
            {"id": str(uuid4()), "name": "name", "type": "text", "is_required": True},
            {"id": str(uuid4()), "name": "height", "type": "number", "is_required": True},
            {"id": str(uuid4()), "name": "weight", "type": "number", "is_required": True},
            {"id": str(uuid4()), "name": "age", "type": "single_select", "is_required": True,
             "options": [{"label": "Light", "value": 0}, {"label": "Medium", "value": 0}, {"label": "Dark", "value": 0}]},
            {"id": str(uuid4()), "name": "veteran_status", "type": "single_select", "is_required": False,
             "options": [{"label": "Yes", "value": 0}, {"label": "No", "value": 0}], "urgency_weight": 30}
        ]
    
    def test_full_individual_management_flow(self, client, mock_supabase, mock_categories):
        """Test complete flow from creation to history"""
        # Setup mock for categories
        mock_supabase.table.return_value.select.return_value.execute.return_value.data = mock_categories
        
        # Step 1: Create a new individual
        individual_id = str(uuid4())
        interaction_id = str(uuid4())
        
        # Mock individual creation
        mock_service = MagicMock()
        mock_service.save_individual = AsyncMock(return_value=save_response({
            "individual": {
                "id": individual_id,
                "name": "John Doe",
                "urgency_score": 45,
                "urgency_override": None,
                "display_score": 45,  # Added display_score
                "data": {
                    "name": "John Doe",
                    "height": 72,
                    "weight": 180,
                    "age": "Light",
                    "veteran_status": "Yes"
                },
                "last_location": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            },
            "interaction": {
                "id": interaction_id,
                "individual_id": individual_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "location": {"latitude": 37.7749, "longitude": -122.4194, "address": "Market St"},
                "has_transcription": True
            }
        }))
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            create_response = client.post(
                "/api/individuals",
                json={
                    "data": {
                        "name": "John Doe",
                        "height": 72,
                        "weight": 180,
                        "age": "Light",
                        "veteran_status": "Yes"
                    },
                    "location": {
                        "latitude": 37.7749,
                        "longitude": -122.4194,
                        "address": "Market St"
                    },
                    "transcription": "Met John near Market Street..."
                },
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert create_response.status_code == 200
        create_data = create_response.json()
        assert create_data["individual"]["id"] == individual_id
        assert create_data["individual"]["urgency_score"] == 45
        
        # Step 2: Search for the individual
        mock_service.search_individuals = AsyncMock(return_value={
            "individuals": [{
                "id": individual_id,
                "name": "John Doe",
                "urgency_score": 45,
                "urgency_override": None,
                "display_score": 45,
                "last_seen": datetime.now(timezone.utc).isoformat(),
                "last_location": {"latitude": 37.7749, "longitude": -122.4194, "address": "Market St"}
            }],
            "total": 1,
            "limit": 20,
            "offset": 0
        })
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            search_response = client.get(
                "/api/individuals?search=John",
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert search_response.status_code == 200
        search_data = search_response.json()
        assert search_data["total"] == 1
        assert search_data["individuals"][0]["name"] == "John Doe"
        
        # Step 3: Get individual details
        mock_service.get_individual_by_id = AsyncMock(return_value={
            "individual": {
                "id": individual_id,
                "name": "John Doe",
                "urgency_score": 45,
                "urgency_override": None,
                "display_score": 45,
                "data": {
                    "name": "John Doe",
                    "height": 72,
                    "weight": 180,
                    "age": "Light",
                    "veteran_status": "Yes"
                },
                "last_location": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            },
            "recent_interactions": [{
                "id": interaction_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "location": {"latitude": 37.7749, "longitude": -122.4194, "address": "Market St"},
                "has_transcription": True
            }]
        })
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            detail_response = client.get(
                f"/api/individuals/{individual_id}",
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert detail_response.status_code == 200
        detail_data = detail_response.json()
        assert detail_data["individual"]["id"] == individual_id
        assert len(detail_data["recent_interactions"]) == 1
        
        # Step 4: Update danger override
        mock_update = MagicMock()
        mock_supabase.table.return_value.update.return_value = mock_update
        mock_update.eq.return_value.execute.return_value.data = [{
            "id": individual_id,
            "urgency_score": 45,
            "urgency_override": 85
        }]
        
        override_response = client.put(
            f"/api/individuals/{individual_id}/urgency-override",
            json={"urgency_override": 85},
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert override_response.status_code == 200
        override_data = override_response.json()
        assert override_data["urgency_override"] == 85
        assert override_data["display_score"] == 85
        
        # Step 5: Merge with new data
        mock_service.save_individual = AsyncMock(return_value=save_response({
            "individual": {
                "id": individual_id,
                "name": "John Doe",
                "urgency_score": 50,  # Recalculated
                "urgency_override": 85,  # Preserved
                "display_score": 85,  # Shows override
                "data": {
                    "name": "John Doe",
                    "height": 73,  # Changed
                    "weight": 185,  # Changed
                    "age": "Light",
                    "veteran_status": "Yes",
                    "substance_abuse_history": ["Moderate"]  # New field
                },
                "last_location": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            },
            "interaction": {
                "id": str(uuid4()),
                "individual_id": individual_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "location": None,
                "has_transcription": False
            }
        }))
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            merge_response = client.post(
                "/api/individuals",
                json={
                    "data": {
                        "name": "John Doe",
                        "height": 73,
                        "weight": 185,
                        "age": "Light",
                        "veteran_status": "Yes",
                        "substance_abuse_history": ["Moderate"]
                    },
                    "merge_with_id": individual_id
                },
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert merge_response.status_code == 200
        merge_data = merge_response.json()
        assert merge_data["individual"]["id"] == individual_id  # Same ID
        assert merge_data["individual"]["urgency_override"] == 85  # Preserved
        assert merge_data["individual"]["data"]["height"] == 73  # Updated data
        
        # Step 6: Get interaction history
        mock_select = MagicMock()
        mock_supabase.table.return_value.select.return_value = mock_select
        mock_select.eq.return_value.order.return_value.limit.return_value.offset.return_value.execute.return_value.data = [
            {
                "id": str(uuid4()),
                "individual_id": individual_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "transcription": None,
                "location": None,
                "changes": {
                    "height": 73,
                    "weight": 185,
                    "substance_abuse_history": ["Moderate"]
                }
            },
            {
                "id": interaction_id,
                "individual_id": individual_id,
                "created_at": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
                "user_name": "Demo User",
                "transcription": "Met John near Market Street...",
                "location": {"latitude": 37.7749, "longitude": -122.4194, "address": "Market St"},
                "changes": {
                    "name": "John Doe",
                    "height": 72,
                    "weight": 180,
                    "age": "Light",
                    "veteran_status": "Yes"
                }
            }
        ]
        
        history_response = client.get(
            f"/api/individuals/{individual_id}/interactions",
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert history_response.status_code == 200
        history_data = history_response.json()
        assert len(history_data["interactions"]) == 2
        assert history_data["interactions"][0]["changes"]["height"] == 73  # Most recent
        assert history_data["interactions"][1]["transcription"] is not None  # Original
    
    def test_search_performance_with_many_individuals(self, client, mock_supabase):
        """Test search performance with 100+ individuals"""
        # Create 100 mock individuals
        mock_individuals = []
        for i in range(100):
            mock_individuals.append({
                "id": str(uuid4()),
                "name": f"Person {i}",
                "urgency_score": i % 100,
                "urgency_override": None,
                "display_score": i % 100,
                "last_seen": datetime.now(timezone.utc).isoformat(),
                "last_location": {"latitude": 37.7749, "longitude": -122.4194, "address": f"Street {i}"}
            })
        
        mock_service = MagicMock()
        mock_service.search_individuals = AsyncMock(return_value={
            "individuals": mock_individuals[:20],  # Return first page
            "total": 100,
            "limit": 20,
            "offset": 0
        })
        
        start_time = time.time()
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            response = client.get(
                "/api/individuals?search=Person",
                headers={"Authorization": "Bearer test-token"}
            )
        
        end_time = time.time()
        response_time = end_time - start_time
        
        assert response.status_code == 200
        assert response_time < 1.0  # Should respond in less than 1 second
        
        data = response.json()
        assert data["total"] == 100
        assert len(data["individuals"]) == 20  # Paginated
    
    def test_error_handling_across_endpoints(self, client, mock_supabase):
        """Test error handling for various scenarios"""
        # Test 1: Create with missing required fields
        mock_categories = [
            {"id": str(uuid4()), "name": "name", "type": "text", "is_required": True},
            {"id": str(uuid4()), "name": "height", "type": "number", "is_required": True},
            {"id": str(uuid4()), "name": "weight", "type": "number", "is_required": True},
            {"id": str(uuid4()), "name": "age", "type": "single_select", "is_required": True}
        ]
        mock_supabase.table.return_value.select.return_value.execute.return_value.data = mock_categories
        
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
        # Pydantic validation returns 422 for validation errors
        assert response.status_code in [400, 422]
        # Check for error message in either format
        error_data = response.json()
        if response.status_code == 422:
            # Pydantic validation error format
            assert any("Missing required fields" in str(err) for err in error_data.get("detail", []))
        else:
            # Our custom error format
            assert "Missing required fields" in error_data["detail"]
        
        # Test 2: Get non-existent individual
        mock_service = MagicMock()
        mock_service.get_individual_by_id = AsyncMock(return_value=None)
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            response = client.get(
                f"/api/individuals/{uuid4()}",
                headers={"Authorization": "Bearer test-token"}
            )
        assert response.status_code == 404
        
        # Test 3: Invalid danger override value
        response = client.put(
            f"/api/individuals/{uuid4()}/urgency-override",
            json={"urgency_override": 150},  # > 100
            headers={"Authorization": "Bearer test-token"}
        )
        assert response.status_code == 422
        
        # Test 4: Merge with non-existent individual
        mock_service.get_individual_by_id = AsyncMock(return_value=None)
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            response = client.post(
                "/api/individuals",
                json={
                    "data": {"name": "Test", "height": 70, "weight": 160, "age": "Light"},
                    "merge_with_id": str(uuid4())
                },
                headers={"Authorization": "Bearer test-token"}
            )
        assert response.status_code == 404
    
    def test_data_integrity_across_operations(self, client, mock_supabase):
        """Test that data remains consistent across operations"""
        individual_id = str(uuid4())
        
        # Create individual with specific data
        initial_data = {
            "name": "Jane Smith",
            "height": 65,
            "weight": 140,
            "age": "Dark",
            "medical_conditions": ["Diabetes", "Hypertension"]
        }
        
        mock_service = MagicMock()
        mock_service.save_individual = AsyncMock(return_value=save_response({
            "individual": {
                "id": individual_id,
                "name": "Jane Smith",
                "urgency_score": 30,
                "urgency_override": None,
                "display_score": 30,
                "data": initial_data,
                "last_location": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            },
            "interaction": {
                "id": str(uuid4()),
                "individual_id": individual_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "location": None,
                "has_transcription": False
            }
        }))
        
        # Mock categories for validation
        mock_supabase.table.return_value.select.return_value.execute.return_value.data = [
            {"id": str(uuid4()), "name": "name", "type": "text", "is_required": True},
            {"id": str(uuid4()), "name": "height", "type": "number", "is_required": True},
            {"id": str(uuid4()), "name": "weight", "type": "number", "is_required": True},
            {"id": str(uuid4()), "name": "age", "type": "single_select", "is_required": True},
            {"id": str(uuid4()), "name": "medical_conditions", "type": "multi_select", "is_required": False}
        ]
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            create_response = client.post(
                "/api/individuals",
                json={"data": initial_data},
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert create_response.status_code == 200
        
        # Update only one field
        updated_data = initial_data.copy()
        updated_data["weight"] = 145
        
        # Mock the get_individual_by_id call for merge validation
        mock_service.get_individual_by_id = AsyncMock(return_value={
            "individual": {
                "id": individual_id,
                "name": "Jane Smith",
                "urgency_score": 30,
                "urgency_override": None,
                "display_score": 30,
                "data": initial_data,
                "last_location": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            },
            "recent_interactions": []
        })
        
        mock_service.save_individual = AsyncMock(return_value=save_response({
            "individual": {
                "id": individual_id,
                "name": "Jane Smith",
                "urgency_score": 32,  # Slightly changed due to weight
                "urgency_override": None,
                "display_score": 32,
                "data": updated_data,
                "last_location": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            },
            "interaction": {
                "id": str(uuid4()),
                "individual_id": individual_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "location": None,
                "has_transcription": False
            }
        }))
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            merge_response = client.post(
                "/api/individuals",
                json={
                    "data": updated_data,
                    "merge_with_id": individual_id
                },
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert merge_response.status_code == 200
        merge_data = merge_response.json()
        
        # Verify weight was updated
        assert merge_data["individual"]["data"]["weight"] == 145
        
        # Verify all other data preserved
        assert merge_data["individual"]["data"]["medical_conditions"] == ["Diabetes", "Hypertension"]
    
    def test_concurrent_operations(self, client, mock_supabase):
        """Test handling of concurrent operations on same individual"""
        individual_id = str(uuid4())
        
        # Simulate two concurrent updates
        mock_update = MagicMock()
        mock_supabase.table.return_value.update.return_value = mock_update
        
        # First update sets danger override to 60
        mock_update.eq.return_value.execute.return_value.data = [{
            "id": individual_id,
            "urgency_score": 45,
            "urgency_override": 60
        }]
        
        response1 = client.put(
            f"/api/individuals/{individual_id}/urgency-override",
            json={"urgency_override": 60},
            headers={"Authorization": "Bearer test-token"}
        )
        
        # Second update sets danger override to 80
        mock_update.eq.return_value.execute.return_value.data = [{
            "id": individual_id,
            "urgency_score": 45,
            "urgency_override": 80
        }]
        
        response2 = client.put(
            f"/api/individuals/{individual_id}/urgency-override",
            json={"urgency_override": 80},
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response1.status_code == 200
        assert response2.status_code == 200
        
        # Last update wins
        assert response2.json()["urgency_override"] == 80


# Clean up dependency override after tests
def teardown_module():
    app.dependency_overrides.clear()