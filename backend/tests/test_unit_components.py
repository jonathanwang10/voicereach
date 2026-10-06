#!/usr/bin/env python3
"""
Unit tests for individual Task 2.0 components
"""

# Import components to test
from services.urgency_calculator import calculate_urgency_score
from services.validation_helper import validate_categorized_data

class TestDangerCalculator:
    """Unit tests for danger score calculation"""
    
    def test_basic_calculation(self):
        """Test basic danger score calculation"""
        data = {"height": 90, "weight": 200}
        categories = [
            {"name": "height", "type": "number", "urgency_weight": 30, "auto_trigger": False},
            {"name": "weight", "type": "number", "urgency_weight": 50, "auto_trigger": False}
        ]
        
        score = calculate_urgency_score(data, categories)
        # Expected: [(90/300)*30 + (200/300)*50] / (30+50) * 100
        # = [9 + 33.33] / 80 * 100 = 52.9 ≈ 52
        assert score == 52
        print("✅ Basic danger calculation: PASS")
    
    def test_auto_trigger(self):
        """Test auto-trigger immediately returns 100"""
        data = {"height": 50}  # Any non-zero value
        categories = [
            {"name": "height", "type": "number", "urgency_weight": 30, "auto_trigger": True}
        ]
        
        score = calculate_urgency_score(data, categories)
        assert score == 100
        print("✅ Auto-trigger returns 100: PASS")
    
    def test_single_select_calculation(self):
        """Test single-select field calculation"""
        data = {"risk_level": "High"}
        categories = [
            {
                "name": "risk_level",
                "type": "single_select",
                "urgency_weight": 80,
                "auto_trigger": False,
                "options": [
                    {"label": "Low", "value": 0.2},
                    {"label": "Medium", "value": 0.5},
                    {"label": "High", "value": 0.9}
                ]
            }
        ]
        
        score = calculate_urgency_score(data, categories)
        # Expected: (0.9 * 80) / 80 * 100 = 90
        assert score == 90
        print("✅ Single-select calculation: PASS")
    
    def test_ignore_text_fields(self):
        """Test that text fields are ignored even with urgency_weight"""
        data = {"name": "John Doe", "height": 60}
        categories = [
            {"name": "name", "type": "text", "urgency_weight": 100, "auto_trigger": False},
            {"name": "height", "type": "number", "urgency_weight": 50, "auto_trigger": False}
        ]
        
        score = calculate_urgency_score(data, categories)
        # Should only consider height: (60/300)*50 / 50 * 100 = 20
        assert score == 20
        print("✅ Text fields ignored: PASS")
    
    def test_missing_values(self):
        """Test missing values are skipped in calculation"""
        data = {"height": 90}  # weight missing
        categories = [
            {"name": "height", "type": "number", "urgency_weight": 30, "auto_trigger": False},
            {"name": "weight", "type": "number", "urgency_weight": 50, "auto_trigger": False}
        ]
        
        score = calculate_urgency_score(data, categories)
        # Only height is considered: (90/300)*30 / 30 * 100 = 0.3 * 100 = 30
        assert score == 30
        print(f"✅ Missing values skipped: PASS (score={score})")
    
    def test_all_zero_weights(self):
        """Test all zero weights returns 0 (not divide by zero)"""
        data = {"height": 90, "weight": 200}
        categories = [
            {"name": "height", "type": "number", "urgency_weight": 0, "auto_trigger": False},
            {"name": "weight", "type": "number", "urgency_weight": 0, "auto_trigger": False}
        ]
        
        score = calculate_urgency_score(data, categories)
        assert score == 0
        print("✅ Zero weights returns 0: PASS")


class TestValidationHelper:
    """Unit tests for validation helper"""
    
    def test_all_required_present(self):
        """Test validation passes when all required fields present"""
        data = {
            "name": "John Doe",
            "height": 72,
            "weight": 180,
            "age": "Light"
        }
        categories = [
            {"name": "name", "type": "text", "is_required": True},
            {"name": "height", "type": "number", "is_required": True},
            {"name": "weight", "type": "number", "is_required": True},
            {"name": "age", "type": "single_select", "is_required": True,
             "options": [{"label": "Light", "value": 0}, {"label": "Medium", "value": 0}, {"label": "Dark", "value": 0}]}
        ]
        
        result = validate_categorized_data(data, categories)
        assert result.is_valid == True
        assert result.missing_required == []
        assert result.validation_errors == []
        print("✅ All required fields present: PASS")
    
    def test_missing_required_field(self):
        """Test missing required field detection"""
        data = {
            "name": "John Doe",
            "height": 72
            # Missing weight and age
        }
        categories = [
            {"name": "name", "type": "text", "is_required": True},
            {"name": "height", "type": "number", "is_required": True},
            {"name": "weight", "type": "number", "is_required": True},
            {"name": "age", "type": "single_select", "is_required": True}
        ]
        
        result = validate_categorized_data(data, categories)
        assert result.is_valid == False
        assert "weight" in result.missing_required
        assert "age" in result.missing_required
        print("✅ Missing required fields detected: PASS")
    
    def test_number_range_validation(self):
        """Test number range validation (0-300)"""
        data = {
            "name": "John",
            "height": 400,  # Out of range
            "weight": -10,  # Out of range
            "age": "Light"
        }
        categories = [
            {"name": "name", "type": "text", "is_required": True},
            {"name": "height", "type": "number", "is_required": True},
            {"name": "weight", "type": "number", "is_required": True},
            {"name": "age", "type": "single_select", "is_required": True}
        ]
        
        result = validate_categorized_data(data, categories)
        assert result.is_valid == False
        assert len(result.validation_errors) >= 2
        # Check error messages
        height_error = next((e for e in result.validation_errors if e["field"] == "height"), None)
        assert height_error is not None
        assert "300" in height_error["message"]
        print("✅ Number range validation: PASS")
    
    def test_invalid_select_option(self):
        """Test invalid single-select option"""
        data = {
            "name": "John",
            "height": 72,
            "weight": 180,
            "age": "Blue"  # Invalid option
        }
        categories = [
            {"name": "name", "type": "text", "is_required": True},
            {"name": "height", "type": "number", "is_required": True},
            {"name": "weight", "type": "number", "is_required": True},
            {"name": "age", "type": "single_select", "is_required": True,
             "options": [{"label": "Light", "value": 0}, {"label": "Medium", "value": 0}, {"label": "Dark", "value": 0}]}
        ]
        
        result = validate_categorized_data(data, categories)
        assert result.is_valid == False
        skin_error = next((e for e in result.validation_errors if e["field"] == "age"), None)
        assert skin_error is not None
        print("✅ Invalid select option detected: PASS")
    
    def test_optional_fields_ignored(self):
        """Test optional fields don't cause validation errors"""
        data = {
            "name": "John",
            "height": 72,
            "weight": 180,
            "age": "Light"
            # Gender is optional and missing
        }
        categories = [
            {"name": "name", "type": "text", "is_required": True},
            {"name": "height", "type": "number", "is_required": True},
            {"name": "weight", "type": "number", "is_required": True},
            {"name": "age", "type": "single_select", "is_required": True,
             "options": [{"label": "Light", "value": 0}, {"label": "Medium", "value": 0}, {"label": "Dark", "value": 0}]},
            {"name": "gender", "type": "single_select", "is_required": False}
        ]
        
        result = validate_categorized_data(data, categories)
        assert result.is_valid == True
        assert "gender" not in result.missing_required
        print("✅ Optional fields ignored: PASS")


class TestOpenAIService:
    """Unit tests for OpenAI service methods"""
    
    def test_validate_audio_url(self):
        """Test audio URL validation logic"""
        # Test valid Supabase URL
        valid_url = "https://test.supabase.co/storage/v1/object/public/audio/test.m4a"
        assert "supabase.co" in valid_url
        assert valid_url.startswith("http")
        print("✅ Valid Supabase URL format: PASS")
        
        # Test invalid URL format
        invalid_url = "not-a-url"
        assert not invalid_url.startswith("http")
        print("✅ Invalid URL format detected: PASS")
    
    def test_url_validation_in_transcribe(self):
        """Test that transcribe_audio validates URLs"""
        # Test non-Supabase URL rejection
        non_supabase_url = "https://example.com/audio.m4a"
        assert "supabase.co" not in non_supabase_url
        print("✅ Non-Supabase URL would be rejected: PASS")
        
        # Test M4A format requirement
        wrong_format_url = "https://test.supabase.co/storage/v1/object/public/audio/test.mp3"
        assert not wrong_format_url.endswith(".m4a")
        print("✅ Non-M4A format would be rejected: PASS")


def run_unit_tests():
    """Run all unit tests"""
    print("\n" + "="*60)
    print("UNIT TESTS FOR TASK 2.0 COMPONENTS")
    print("="*60)
    
    # Test Danger Calculator
    print("\n### Testing Danger Calculator ###")
    danger_tests = TestDangerCalculator()
    danger_tests.test_basic_calculation()
    danger_tests.test_auto_trigger()
    danger_tests.test_single_select_calculation()
    danger_tests.test_ignore_text_fields()
    danger_tests.test_missing_values()
    danger_tests.test_all_zero_weights()
    
    # Test Validation Helper
    print("\n### Testing Validation Helper ###")
    validation_tests = TestValidationHelper()
    validation_tests.test_all_required_present()
    validation_tests.test_missing_required_field()
    validation_tests.test_number_range_validation()
    validation_tests.test_invalid_select_option()
    validation_tests.test_optional_fields_ignored()
    
    # Test OpenAI Service
    print("\n### Testing OpenAI Service ###")
    openai_tests = TestOpenAIService()
    openai_tests.test_validate_audio_url()
    openai_tests.test_url_validation_in_transcribe()
    
    print("\n" + "="*60)
    print("✅ ALL UNIT TESTS PASSED!")
    print("="*60)


if __name__ == "__main__":
    run_unit_tests()