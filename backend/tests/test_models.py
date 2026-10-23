"""Request-model validation: location bounds, required fields, override range, category rules."""
import pytest
from pydantic import ValidationError
from uuid import uuid4
from datetime import datetime, timezone
from db.models import (
    CreateCategoryRequest,
    InteractionSummary,
    LocationData,
    SaveIndividualRequest,
    UrgencyOverrideRequest,
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
        assert "Missing required fields: name" in str(exc_info.value)
    
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
        assert "Missing required fields: height" in str(exc_info.value)


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


def test_location_bounds_are_inclusive():
    assert LocationData(latitude=90, longitude=180, address="x").latitude == 90
    assert LocationData(latitude=-90, longitude=-180, address="x").longitude == -180


def test_interaction_summary_allows_null_user_name():
    """C-55: one NULL user_name (a row written outside the backend) must not 500 a route."""
    summary = InteractionSummary(id=uuid4(), created_at=datetime.now(timezone.utc), user_name=None,
                                 location=None, has_transcription=False)
    assert summary.user_name is None


# --- CreateCategoryRequest: defaults never null; select option values numeric ---

def test_category_null_weight_defaults_to_zero():
    req = CreateCategoryRequest(name="notes2", type="text")
    assert req.urgency_weight == 0 and req.priority == "medium"


def test_category_rejects_null_weight():
    with pytest.raises(ValueError):
        CreateCategoryRequest(name="x", type="text", urgency_weight=None)


def test_single_select_option_value_must_be_numeric():
    with pytest.raises(ValueError):
        CreateCategoryRequest(name="x", type="single_select",
                              options=[{"label": "A", "value": "high"}])


def test_missing_required_fields_are_listed_with_commas():
    with pytest.raises(ValidationError) as exc:
        SaveIndividualRequest(data={"name": "Ann"})
    assert "Missing required fields: height, weight" in str(exc.value) and "['" not in str(exc.value)
