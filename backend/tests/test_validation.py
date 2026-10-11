"""validation_helper.validate_categorized_data: required fields, ranges, options."""
import pytest

from services.validation_helper import validate_categorized_data

AGE_LABELS = [{"label": "Light", "value": 0}, {"label": "Medium", "value": 0}, {"label": "Dark", "value": 0}]
CATEGORIES = [
    {"name": "name", "type": "text", "is_required": True},
    {"name": "height", "type": "number", "is_required": True},
    {"name": "weight", "type": "number", "is_required": True},
    {"name": "tone", "type": "single_select", "is_required": False, "options": AGE_LABELS},
    {"name": "gender", "type": "single_select", "is_required": False,
     "options": [{"label": "Male", "value": 0}, {"label": "Female", "value": 0}]},
]


def test_all_required_present_is_valid():
    result = validate_categorized_data({"name": "John Doe", "height": 72, "weight": 180, "tone": "Light"}, CATEGORIES)
    assert (result.is_valid, result.missing_required, result.validation_errors) == (True, [], [])


def test_missing_required_fields_are_listed():
    result = validate_categorized_data({"name": "John Doe", "height": 72}, CATEGORIES)
    assert not result.is_valid
    assert result.missing_required == ["weight"]


def test_blank_required_value_counts_as_missing():
    result = validate_categorized_data({"name": "   ", "height": 72, "weight": 180}, CATEGORIES)
    assert result.missing_required == ["name"]


def test_number_range_is_0_to_300():
    result = validate_categorized_data({"name": "John", "height": 400, "weight": -10}, CATEGORIES)
    assert not result.is_valid
    errors = {e["field"]: e["message"] for e in result.validation_errors}
    assert set(errors) == {"height", "weight"}
    assert "300" in errors["height"]


def test_invalid_select_option_is_an_error_on_that_field():
    result = validate_categorized_data({"name": "John", "height": 72, "weight": 180, "tone": "Blue"}, CATEGORIES)
    assert not result.is_valid
    assert [e["field"] for e in result.validation_errors] == ["tone"]


def test_optional_fields_may_be_missing():
    result = validate_categorized_data({"name": "John", "height": 72, "weight": 180}, CATEGORIES)
    assert result.is_valid and "gender" not in result.missing_required


@pytest.mark.parametrize("bad", ["nan", "NaN", "inf", "-inf"])
def test_validation_rejects_non_finite_numbers(bad):
    cats = [{"name": "age", "type": "number", "is_required": False}]
    result = validate_categorized_data({"age": bad}, cats)
    assert not result.is_valid
