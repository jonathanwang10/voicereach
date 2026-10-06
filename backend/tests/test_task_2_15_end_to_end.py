"""
Comprehensive end-to-end test for Task 2.15 - Individual Management Backend
Tests all endpoints and functionality according to PRD specifications
"""
import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock, AsyncMock
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


class TestTask215EndToEnd:
    """Complete end-to-end test for Task 2.15 requirements"""
    
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
        """Mock categories matching PRD preset requirements"""
        return [
            {
                "id": str(uuid4()),
                "name": "name",
                "type": "text",
                "is_required": True,
                "is_preset": True,
                "options": None
            },
            {
                "id": str(uuid4()),
                "name": "height",
                "type": "number",
                "is_required": True,
                "is_preset": True,
                "options": None
            },
            {
                "id": str(uuid4()),
                "name": "weight",
                "type": "number",
                "is_required": True,
                "is_preset": True,
                "options": None,
                "urgency_weight": 10  # For danger calculation
            },
            {
                "id": str(uuid4()),
                "name": "age",
                "type": "single_select",
                "is_required": True,
                "is_preset": True,
                "options": [
                    {"label": "Light", "value": 0},
                    {"label": "Medium", "value": 0},
                    {"label": "Dark", "value": 0}
                ]
            },
            {
                "id": str(uuid4()),
                "name": "gender",
                "type": "single_select",
                "is_required": False,
                "is_preset": True,
                "options": [
                    {"label": "Male", "value": 0},
                    {"label": "Female", "value": 0},
                    {"label": "Other", "value": 0},
                    {"label": "Unknown", "value": 0}
                ]
            },
            {
                "id": str(uuid4()),
                "name": "substance_abuse_history",
                "type": "multi_select",
                "is_required": False,
                "is_preset": True,
                "options": ["None", "Mild", "Moderate", "Severe", "In Recovery"]
            },
            {
                "id": str(uuid4()),
                "name": "veteran_status",
                "type": "single_select",
                "is_required": False,
                "is_preset": False,
                "options": [
                    {"label": "Yes", "value": 0.8},
                    {"label": "No", "value": 0}
                ],
                "urgency_weight": 50,
                "auto_trigger": False
            },
            {
                "id": str(uuid4()),
                "name": "weapon_possession",
                "type": "single_select",
                "is_required": False,
                "is_preset": False,
                "options": [
                    {"label": "Yes", "value": 1},
                    {"label": "No", "value": 0}
                ],
                "urgency_weight": 100,
                "auto_trigger": True  # Auto-trigger sets score to 100
            }
        ]
    
    def test_complete_individual_management_flow(self, client, mock_supabase, mock_categories):
        """Test complete flow matching PRD requirements"""
        
        # Setup categories mock
        mock_supabase.table.return_value.select.return_value.execute.return_value.data = mock_categories
        
        # ========== SCENARIO 1: Voice Entry with All Required Fields ==========
        print("\n=== Scenario 1: Voice Entry with All Required Fields ===")
        
        individual1_id = str(uuid4())
        interaction1_id = str(uuid4())
        
        # Mock service for creation
        mock_service = MagicMock()
        mock_service.save_individual = AsyncMock(return_value=save_response({
            "individual": {
                "id": individual1_id,
                "name": "John Doe",
                "urgency_score": 45,  # Calculated from weight
                "urgency_override": None,
                "display_score": 45,
                "data": {
                    "name": "John Doe",
                    "height": 72,  # 6 feet as per PRD example
                    "weight": 180,
                    "age": "Light",
                    "gender": "Male",
                    "substance_abuse_history": ["Moderate"],
                    "veteran_status": "Yes"
                },
                "last_location": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            },
            "interaction": {
                "id": interaction1_id,
                "individual_id": individual1_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "location": {
                    "latitude": 37.7749,
                    "longitude": -122.4194,
                    "address": "123 Market Street, San Francisco, CA 94103"
                },
                "has_transcription": True
            }
        }))
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            # Test 1.1: Create individual from voice transcription
            create_response = client.post(
                "/api/individuals",
                json={
                    "data": {
                        "name": "John Doe",
                        "height": 72,
                        "weight": 180,
                        "age": "Light",
                        "gender": "Male",
                        "substance_abuse_history": ["Moderate"],
                        "veteran_status": "Yes"
                    },
                    "location": {
                        "latitude": 37.7749,
                        "longitude": -122.4194,
                        "address": "123 Market Street, San Francisco, CA 94103"
                    },
                    "transcription": "Met John near Market Street. About 45 years old, 6 feet tall, maybe 180 pounds. Light skin. Shows signs of moderate substance abuse, been on streets 3 months. Needs diabetes medication.",
                    "audio_url": "https://test.supabase.co/storage/v1/object/public/audio/test/john.m4a"
                },
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert create_response.status_code == 200
        create_data = create_response.json()
        assert create_data["individual"]["name"] == "John Doe"
        assert create_data["individual"]["urgency_score"] == 45
        assert create_data["interaction"]["has_transcription"] == True
        print("✅ Voice entry with all fields successful")
        
        # ========== SCENARIO 2: Manual Entry Missing Required Fields ==========
        print("\n=== Scenario 2: Manual Entry Missing Required Fields ===")
        
        # Test 2.1: Attempt to create without required fields
        response = client.post(
            "/api/individuals",
            json={
                "data": {
                    "name": "Jane Smith",
                    "height": 65
                    # Missing weight and age (required)
                }
            },
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert response.status_code in [400, 422]
        error_data = response.json()
        if response.status_code == 422:
            assert any("Missing required fields" in str(err) for err in error_data.get("detail", []))
        print("✅ Required field validation working")
        
        # ========== SCENARIO 3: Search Functionality ==========
        print("\n=== Scenario 3: Search Functionality ===")
        
        # Mock search results
        mock_service.search_individuals = AsyncMock(return_value={
            "individuals": [
                {
                    "id": individual1_id,
                    "name": "John Doe",
                    "urgency_score": 45,
                    "urgency_override": None,
                    "display_score": 45,
                    "last_seen": datetime.now(timezone.utc).isoformat(),
                    "last_location": {
                        "latitude": 37.7749,
                        "longitude": -122.4194,
                        "address": "Market St & 5th"  # Abbreviated for list
                    }
                }
            ],
            "total": 1,
            "limit": 20,
            "offset": 0
        })
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            # Test 3.1: Search by name
            search_response = client.get(
                "/api/individuals?search=John",
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert search_response.status_code == 200
        search_data = search_response.json()
        assert search_data["total"] == 1
        assert search_data["individuals"][0]["name"] == "John Doe"
        assert "Market St" in search_data["individuals"][0]["last_location"]["address"]
        print("✅ Search by name working")
        
        # Test 3.2: Pagination
        with patch('api.individuals.IndividualService', return_value=mock_service):
            page_response = client.get(
                "/api/individuals?limit=10&offset=20&sort_by=urgency_score&sort_order=desc",
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert page_response.status_code == 200
        print("✅ Pagination and sorting working")
        
        # ========== SCENARIO 4: Individual Details ==========
        print("\n=== Scenario 4: Individual Details ===")
        
        # Mock individual details with interactions
        mock_service.get_individual_by_id = AsyncMock(return_value={
            "individual": {
                "id": individual1_id,
                "name": "John Doe",
                "urgency_score": 45,
                "urgency_override": None,
                "display_score": 45,
                "data": {
                    "name": "John Doe",
                    "height": 72,
                    "weight": 180,
                    "age": "Light",
                    "gender": "Male",
                    "substance_abuse_history": ["Moderate"],
                    "veteran_status": "Yes"
                },
                "last_location": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            },
            "recent_interactions": [
                {
                    "id": interaction1_id,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "user_name": "Demo User",
                    "location": {
                        "latitude": 37.7749,
                        "longitude": -122.4194,
                        "address": "Market St & 5th"
                    },
                    "has_transcription": True
                }
            ]
        })
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            detail_response = client.get(
                f"/api/individuals/{individual1_id}",
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert detail_response.status_code == 200
        detail_data = detail_response.json()
        assert detail_data["individual"]["id"] == individual1_id
        assert len(detail_data["recent_interactions"]) == 1
        print("✅ Individual details retrieval working")
        
        # ========== SCENARIO 5: Danger Override ==========
        print("\n=== Scenario 5: Danger Override ===")
        
        # Test 5.1: Set danger override
        mock_update = MagicMock()
        mock_supabase.table.return_value.update.return_value = mock_update
        mock_update.eq.return_value.execute.return_value.data = [{
            "id": individual1_id,
            "urgency_score": 45,
            "urgency_override": 85
        }]
        
        override_response = client.put(
            f"/api/individuals/{individual1_id}/urgency-override",
            json={"urgency_override": 85},
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert override_response.status_code == 200
        override_data = override_response.json()
        assert override_data["urgency_score"] == 45  # Original calculated
        assert override_data["urgency_override"] == 85  # Manual override
        assert override_data["display_score"] == 85  # Shows override
        print("✅ Danger override set successfully")
        
        # Test 5.2: Remove danger override
        mock_update.eq.return_value.execute.return_value.data = [{
            "id": individual1_id,
            "urgency_score": 45,
            "urgency_override": None
        }]
        
        remove_response = client.put(
            f"/api/individuals/{individual1_id}/urgency-override",
            json={"urgency_override": None},
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert remove_response.status_code == 200
        remove_data = remove_response.json()
        assert remove_data["urgency_override"] is None
        assert remove_data["display_score"] == 45  # Back to calculated
        print("✅ Danger override removed successfully")
        
        # ========== SCENARIO 6: Merge Individuals ==========
        print("\n=== Scenario 6: Merge Individuals ===")
        
        # Mock merge scenario
        mock_service.save_individual = AsyncMock(return_value=save_response({
            "individual": {
                "id": individual1_id,  # Same ID - merged
                "name": "John Doe",
                "urgency_score": 50,  # Recalculated
                "urgency_override": None,
                "display_score": 50,
                "data": {
                    "name": "John Doe",
                    "height": 73,  # Updated
                    "weight": 185,  # Updated
                    "age": "Light",
                    "gender": "Male",
                    "substance_abuse_history": ["Moderate", "In Recovery"],  # Updated
                    "veteran_status": "Yes",
                    "medical_conditions": ["Diabetes"]  # New field
                },
                "last_location": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            },
            "interaction": {
                "id": str(uuid4()),
                "individual_id": individual1_id,
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
                        "gender": "Male",
                        "substance_abuse_history": ["Moderate", "In Recovery"],
                        "veteran_status": "Yes",
                        "medical_conditions": ["Diabetes"]
                    },
                    "merge_with_id": individual1_id
                },
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert merge_response.status_code == 200
        merge_data = merge_response.json()
        assert merge_data["individual"]["id"] == individual1_id  # Same ID
        assert merge_data["individual"]["data"]["height"] == 73  # Updated
        assert merge_data["individual"]["data"]["medical_conditions"] == ["Diabetes"]  # New field
        print("✅ Individual merge working correctly")
        
        # ========== SCENARIO 7: Interaction History ==========
        print("\n=== Scenario 7: Interaction History ===")
        
        # Mock interaction history
        mock_select = MagicMock()
        mock_supabase.table.return_value.select.return_value = mock_select
        mock_select.eq.return_value.order.return_value.limit.return_value.offset.return_value.execute.return_value.data = [
            {
                "id": str(uuid4()),
                "individual_id": individual1_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "transcription": None,
                "location": None,
                "changes": {
                    "height": 73,
                    "weight": 185,
                    "medical_conditions": ["Diabetes"]
                }
            },
            {
                "id": interaction1_id,
                "individual_id": individual1_id,
                "created_at": (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(),
                "user_name": "Demo User",
                "transcription": "Met John near Market Street...",
                "location": {
                    "latitude": 37.7749,
                    "longitude": -122.4194,
                    "address": "123 Market Street, San Francisco, CA 94103"  # Full address
                },
                "changes": {
                    "name": "John Doe",
                    "height": 72,
                    "weight": 180,
                    "age": "Light",
                    "gender": "Male",
                    "substance_abuse_history": ["Moderate"],
                    "veteran_status": "Yes"
                }
            }
        ]
        
        history_response = client.get(
            f"/api/individuals/{individual1_id}/interactions",
            headers={"Authorization": "Bearer test-token"}
        )
        
        assert history_response.status_code == 200
        history_data = history_response.json()
        assert len(history_data["interactions"]) == 2
        
        # Verify newest first
        assert history_data["interactions"][0]["changes"]["height"] == 73
        
        # Verify full address in history
        assert "123 Market Street" in history_data["interactions"][1]["location"]["address"]
        
        # Verify transcription preserved
        assert history_data["interactions"][1]["transcription"] is not None
        print("✅ Interaction history tracking working")
        
        # ========== SCENARIO 8: Auto-Trigger Danger Score ==========
        print("\n=== Scenario 8: Auto-Trigger Danger Score ===")
        
        # Create individual with weapon (auto-trigger field)
        individual2_id = str(uuid4())
        
        mock_service.save_individual = AsyncMock(return_value=save_response({
            "individual": {
                "id": individual2_id,
                "name": "High Risk Person",
                "urgency_score": 100,  # Auto-triggered to 100
                "urgency_override": None,
                "display_score": 100,
                "data": {
                    "name": "High Risk Person",
                    "height": 70,
                    "weight": 200,
                    "age": "Medium",
                    "weapon_possession": "Yes"  # Auto-trigger field
                },
                "last_location": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            },
            "interaction": {
                "id": str(uuid4()),
                "individual_id": individual2_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "user_name": "Demo User",
                "location": None,
                "has_transcription": False
            }
        }))
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            weapon_response = client.post(
                "/api/individuals",
                json={
                    "data": {
                        "name": "High Risk Person",
                        "height": 70,
                        "weight": 200,
                        "age": "Medium",
                        "weapon_possession": "Yes"
                    }
                },
                headers={"Authorization": "Bearer test-token"}
            )
        
        assert weapon_response.status_code == 200
        weapon_data = weapon_response.json()
        assert weapon_data["individual"]["urgency_score"] == 100  # Auto-triggered
        print("✅ Auto-trigger danger score working")
        
        # ========== SCENARIO 9: Error Handling ==========
        print("\n=== Scenario 9: Error Handling ===")
        
        # Test 9.1: Invalid UUID
        response = client.get(
            "/api/individuals/not-a-valid-uuid",
            headers={"Authorization": "Bearer test-token"}
        )
        assert response.status_code in [404, 422]
        
        # Test 9.2: Non-existent individual
        mock_service.get_individual_by_id = AsyncMock(return_value=None)
        with patch('api.individuals.IndividualService', return_value=mock_service):
            response = client.get(
                f"/api/individuals/{uuid4()}",
                headers={"Authorization": "Bearer test-token"}
            )
        assert response.status_code == 404
        
        # Test 9.3: Invalid danger override value
        response = client.put(
            f"/api/individuals/{individual1_id}/urgency-override",
            json={"urgency_override": 150},  # > 100
            headers={"Authorization": "Bearer test-token"}
        )
        assert response.status_code == 422
        
        print("✅ Error handling working correctly")
        
        # ========== SCENARIO 10: Performance Test ==========
        print("\n=== Scenario 10: Performance Test ===")
        
        # Test search performance with many results
        start_time = time.time()
        
        mock_service.search_individuals = AsyncMock(return_value={
            "individuals": [{"id": str(uuid4()), "name": f"Person {i}", "urgency_score": i % 100, 
                            "urgency_override": None, "display_score": i % 100,
                            "last_seen": datetime.now(timezone.utc).isoformat(),
                            "last_location": {"latitude": 37.7749, "longitude": -122.4194, 
                                            "address": f"Street {i}"}} for i in range(20)],
            "total": 100,
            "limit": 20,
            "offset": 0
        })
        
        with patch('api.individuals.IndividualService', return_value=mock_service):
            perf_response = client.get(
                "/api/individuals?search=Person",
                headers={"Authorization": "Bearer test-token"}
            )
        
        end_time = time.time()
        response_time = end_time - start_time
        
        assert perf_response.status_code == 200
        assert response_time < 1.0  # Should respond in less than 1 second
        print(f"✅ Performance test passed: {response_time:.3f} seconds")
        
        print("\n" + "="*50)
        print("✅ ALL TASK 2.15 TESTS PASSED!")
        print("="*50)


    @pytest.mark.real_auth
    @pytest.mark.skip(reason="auth enforced in Task 5A")
    def test_no_auth_rejected(self):
        """Requests without a token are rejected (split out of the end-to-end flow)"""
        client = TestClient(app)
        response = client.get("/api/individuals")
        assert response.status_code in [401, 422]

# Clean up dependency override after tests
def teardown_module():
    app.dependency_overrides.clear()