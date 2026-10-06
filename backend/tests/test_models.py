"""
Unit tests for data models (Task 2.15.1)
Tests Pydantic model validation and computed fields
"""
import pytest
from uuid import uuid4
from datetime import datetime
from db.models import (
    LocationData,
    SaveIndividualRequest,
    UrgencyOverrideRequest,
    IndividualSummary,
    IndividualResponse,
    InteractionSummary,
    InteractionDetail,
    SaveIndividualResponse,
    SearchIndividualsResponse,
    IndividualDetailResponse,
    UrgencyOverrideResponse,
    InteractionsResponse
)


class TestLocationData:
    """Test location data validation"""
    
    def test_valid_location(self):
        """Test creating valid location data"""
        location = LocationData(
            latitude=37.7749,
            longitude=-122.4194,
            address="123 Market Street, San Francisco, CA"
        )
        assert location.latitude == 37.7749
        assert location.longitude == -122.4194
        assert location.address == "123 Market Street, San Francisco, CA"
    
    def test_invalid_latitude(self):
        """Test latitude validation (must be -90 to 90)"""
        with pytest.raises(ValueError):
            LocationData(
                latitude=91,  # Invalid - too high
                longitude=-122.4194,
                address="Test Address"
            )
        
        with pytest.raises(ValueError):
            LocationData(
                latitude=-91,  # Invalid - too low
                longitude=-122.4194,
                address="Test Address"
            )
    
    def test_invalid_longitude(self):
        """Test longitude validation (must be -180 to 180)"""
        with pytest.raises(ValueError):
            LocationData(
                latitude=37.7749,
                longitude=181,  # Invalid - too high
                address="Test Address"
            )
        
        with pytest.raises(ValueError):
            LocationData(
                latitude=37.7749,
                longitude=-181,  # Invalid - too low
                address="Test Address"
            )


class TestSaveIndividualRequest:
    """Test save individual request validation"""
    
    def test_valid_request_minimal(self):
        """Test minimal valid request with only required fields"""
        request = SaveIndividualRequest(
            data={
                "name": "John Doe",
                "height": 72,
                "weight": 180,
                "age": "Light"
            }
        )
        assert request.data["name"] == "John Doe"
        assert request.merge_with_id is None
        assert request.location is None
        assert request.transcription is None
        assert request.audio_url is None
    
    def test_valid_request_full(self):
        """Test full request with all optional fields"""
        location = LocationData(
            latitude=37.7749,
            longitude=-122.4194,
            address="Golden Gate Park"
        )
        merge_id = uuid4()
        
        request = SaveIndividualRequest(
            data={
                "name": "Jane Smith",
                "height": 65,
                "weight": 140,
                "age": "Dark",
                "gender": "Female",
                "substance_abuse_history": ["None"]
            },
            merge_with_id=merge_id,
            location=location,
            transcription="Met Jane near the park...",
            audio_url="https://storage.example.com/audio/123.m4a"
        )
        assert request.data["gender"] == "Female"
        assert request.merge_with_id == merge_id
        assert request.location.address == "Golden Gate Park"
        assert request.transcription == "Met Jane near the park..."
        assert request.audio_url == "https://storage.example.com/audio/123.m4a"
    
    def test_missing_required_field_name(self):
        """Test validation fails when name is missing"""
        with pytest.raises(ValueError) as exc_info:
            SaveIndividualRequest(
                data={
                    # Missing name
                    "height": 72,
                    "weight": 180,
                    "age": "Light"
                }
            )
        assert "Missing required fields: ['name']" in str(exc_info.value)
    
    def test_missing_multiple_required_fields(self):
        """Test validation fails when multiple required fields missing"""
        with pytest.raises(ValueError) as exc_info:
            SaveIndividualRequest(
                data={
                    "name": "John Doe"
                    # Missing height, weight
                }
            )
        assert "Missing required fields:" in str(exc_info.value)
        assert "height" in str(exc_info.value)
        assert "weight" in str(exc_info.value)
    
    def test_null_required_field(self):
        """Test validation fails when required field is null"""
        with pytest.raises(ValueError) as exc_info:
            SaveIndividualRequest(
                data={
                    "name": "John Doe",
                    "height": None,  # Null is not allowed
                    "weight": 180,
                    "age": "Light"
                }
            )
        assert "Missing required fields: ['height']" in str(exc_info.value)


class TestUrgencyOverrideRequest:
    """Test danger override request validation"""
    
    def test_valid_override(self):
        """Test valid danger override values"""
        # Valid values
        for value in [0, 50, 100]:
            request = UrgencyOverrideRequest(urgency_override=value)
            assert request.urgency_override == value
    
    def test_null_override(self):
        """Test null override (remove override)"""
        request = UrgencyOverrideRequest(urgency_override=None)
        assert request.urgency_override is None
    
    def test_invalid_override_too_high(self):
        """Test danger override > 100 fails"""
        with pytest.raises(ValueError):
            UrgencyOverrideRequest(urgency_override=101)
    
    def test_invalid_override_negative(self):
        """Test negative danger override fails"""
        with pytest.raises(ValueError):
            UrgencyOverrideRequest(urgency_override=-1)


class TestResponseModels:
    """Test response model creation"""
    
    def test_individual_summary(self):
        """Test IndividualSummary model"""
        summary = IndividualSummary(
            id=uuid4(),
            name="John Doe",
            urgency_score=75,
            urgency_override=None,
            display_score=75,  # Should match urgency_score when no override
            last_seen=datetime.now(),
            last_location={
                "latitude": 37.7749,
                "longitude": -122.4194,
                "address": "Market St & 5th"  # Abbreviated
            }
        )
        assert summary.display_score == summary.urgency_score
    
    def test_individual_summary_with_override(self):
        """Test IndividualSummary with danger override"""
        summary = IndividualSummary(
            id=uuid4(),
            name="Jane Smith",
            urgency_score=20,
            urgency_override=40,
            display_score=40,  # Should match override when set
            last_seen=datetime.now(),
            last_location=None
        )
        assert summary.display_score == summary.urgency_override
        assert summary.display_score != summary.urgency_score
    
    def test_individual_response(self):
        """Test IndividualResponse model"""
        response = IndividualResponse(
            id=uuid4(),
            name="Test Person",
            urgency_score=50,
            urgency_override=None,
            display_score=50,
            data={
                "name": "Test Person",
                "height": 70,
                "weight": 160,
                "age": "Medium",
                "veteran_status": "Unknown"
            },
            last_location=None,
            created_at=datetime.now(),
            updated_at=datetime.now()
        )
        assert response.data["veteran_status"] == "Unknown"
        assert response.display_score == response.urgency_score
    
    def test_interaction_summary(self):
        """Test InteractionSummary model"""
        interaction = InteractionSummary(
            id=uuid4(),
            created_at=datetime.now(),
            user_name="Demo User",
            location={
                "latitude": 37.7749,
                "longitude": -122.4194,
                "address": "Tenderloin"
            },
            has_transcription=True
        )
        assert interaction.user_name == "Demo User"
        assert interaction.has_transcription is True
    
    def test_interaction_detail(self):
        """Test InteractionDetail model"""
        detail = InteractionDetail(
            id=uuid4(),
            created_at=datetime.now(),
            user_name="Demo User",
            transcription="Met individual near library...",
            location={
                "latitude": 37.7749,
                "longitude": -122.4194,
                "address": "123 Main Library Street, San Francisco, CA 94102"  # Full address
            },
            changes={
                "height": 71,
                "weight": 175,
                "medical_conditions": ["Diabetes"]
            }
        )
        assert "height" in detail.changes
        assert detail.location["address"].startswith("123 Main Library")
    
    def test_urgency_override_response(self):
        """Test UrgencyOverrideResponse model"""
        response = UrgencyOverrideResponse(
            urgency_score=75,
            urgency_override=90,
            display_score=90  # Should be override value
        )
        assert response.display_score == response.urgency_override
        
        # Test without override
        response2 = UrgencyOverrideResponse(
            urgency_score=75,
            urgency_override=None,
            display_score=75  # Should be urgency_score
        )
        assert response2.display_score == response2.urgency_score
    
    def test_search_response(self):
        """Test SearchIndividualsResponse model"""
        individuals = [
            IndividualSummary(
                id=uuid4(),
                name=f"Person {i}",
                urgency_score=i * 10,
                urgency_override=None,
                display_score=i * 10,
                last_seen=datetime.now(),
                last_location=None
            )
            for i in range(3)
        ]
        
        response = SearchIndividualsResponse(
            individuals=individuals,
            total=50,
            offset=0,
            limit=20
        )
        assert len(response.individuals) == 3
        assert response.total == 50
        assert response.limit == 20
    
    def test_individual_detail_response(self):
        """Test IndividualDetailResponse model"""
        individual = IndividualResponse(
            id=uuid4(),
            name="Detail Test",
            urgency_score=60,
            urgency_override=None,
            display_score=60,
            data={"name": "Detail Test", "height": 70, "weight": 160, "age": "Light"},
            last_location=None,
            created_at=datetime.now(),
            updated_at=datetime.now()
        )
        
        interactions = [
            InteractionSummary(
                id=uuid4(),
                created_at=datetime.now(),
                user_name="Demo User",
                location=None,
                has_transcription=False
            )
        ]
        
        response = IndividualDetailResponse(
            individual=individual,
            recent_interactions=interactions
        )
        assert response.individual.name == "Detail Test"
        assert len(response.recent_interactions) == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])