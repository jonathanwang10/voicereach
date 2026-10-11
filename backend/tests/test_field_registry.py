"""Shared field normaliser (C-09/C-14/C-15 backend half, C-67)."""
import pytest

from services.field_registry import category_key, normalize_individual_data, parse_height_inches
from services.validation_helper import validate_categorized_data

CATEGORIES = [
    {"name": "name", "type": "text", "is_required": True},
    {"name": "height", "type": "number", "is_required": True},
    {"name": "weight", "type": "number", "is_required": True},
    {"name": "age", "type": "number", "is_required": False},
    {"name": "gender", "type": "single_select", "is_required": False,
     "options": [{"label": "Male", "value": 0}, {"label": "Female", "value": 0},
                 {"label": "Other", "value": 0}, {"label": "Unknown", "value": 0}]},
    {"name": "medical_conditions", "type": "multi_select", "is_required": False,
     "options": ["Diabetes", "Heart Disease", "Mental Health", "Cancer", "None"]},
    {"name": "Housing_status", "type": "text", "is_required": False},
    {"name": "last_location", "type": "location", "is_required": False},
]


# --- category_key ---
@pytest.mark.parametrize("raw,expected", [
    ("HIV status", "hiv_status"), ("  Name ", "name"), ("Housing_status", "housing_status"),
    ("housing-status", "housing_status"), ("Veteran   Status", "veteran_status"),
])
def test_category_key(raw, expected):
    assert category_key(raw) == expected


# --- parse_height_inches ---
@pytest.mark.parametrize("raw,expected", [
    (6, 72), (5.5, 66), ("6", 72), ("5.5 feet", 66), ("5, 10", 70), ("5'10", 70),
    ("5' 10\"", 70), ("5 ft 10", 70), ("5 feet 10 inches", 70), ("6 ft 180 lbs", 72),
    ("5 foot 150 pounds", 60), ("70", 70), (70, 70), ("70.5", 70.5), ("70 inches", 70),
    ("178 cm", 70.1), ("1.78 m", 70.1), ("1.78 meters", 70.1), ("180 centimeters", 70.9),
])
def test_parse_height_inches(raw, expected):
    assert parse_height_inches(raw) == pytest.approx(expected, abs=0.05)


@pytest.mark.parametrize("raw", [None, "", "tall", True, [70]])
def test_parse_height_inches_unparseable(raw):
    assert parse_height_inches(raw) is None


# --- normalize_individual_data ---
def test_multi_select_string_is_split_on_commas():
    clean, errors = normalize_individual_data({"medical_conditions": "Diabetes, Cancer"}, CATEGORIES)
    assert clean["medical_conditions"] == ["Diabetes", "Cancer"]
    assert errors == []


def test_multi_select_case_insensitive_and_deduplicated():
    clean, errors = normalize_individual_data(
        {"medical_conditions": ["diabetes", "DIABETES", " heart disease "]}, CATEGORIES)
    assert clean["medical_conditions"] == ["Diabetes", "Heart Disease"]
    assert errors == []


def test_multi_select_unknown_option_is_an_error():
    _, errors = normalize_individual_data({"medical_conditions": "Diabetes, Flu"}, CATEGORIES)
    assert [e["field"] for e in errors] == ["medical_conditions"]


@pytest.mark.parametrize("empty", [None, "", "   ", []])
def test_empty_values_are_dropped(empty):
    clean, errors = normalize_individual_data({"name": "Ann", "age": empty, "gender": empty}, CATEGORIES)
    assert clean == {"name": "Ann"}
    assert errors == []


def test_single_select_matches_case_insensitively():
    clean, errors = normalize_individual_data({"gender": "male"}, CATEGORIES)
    assert clean["gender"] == "Male"
    assert errors == []


def test_single_select_unknown_label_is_an_error():
    _, errors = normalize_individual_data({"gender": "Yes"}, CATEGORIES)
    assert errors and errors[0]["field"] == "gender"


def test_numbers_are_coerced():
    clean, errors = normalize_individual_data({"weight": "180", "age": "45.0", "height": "70.5"}, CATEGORIES)
    assert clean == {"weight": 180, "age": 45, "height": 70.5}
    assert isinstance(clean["weight"], int) and isinstance(clean["age"], int)
    assert errors == []


def test_bare_small_height_is_feet():
    clean, _ = normalize_individual_data({"height": "6"}, CATEGORIES)
    assert clean["height"] == 72


@pytest.mark.parametrize("field,value", [("age", -1), ("weight", 301), ("height", 400), ("age", "nan"),
                                         ("weight", "heavy"), ("age", True)])
def test_bad_numbers_are_errors(field, value):
    _, errors = normalize_individual_data({field: value}, CATEGORIES)
    assert [e["field"] for e in errors] == [field]


def test_name_is_stripped():
    clean, _ = normalize_individual_data({"name": "  John Doe  "}, CATEGORIES)
    assert clean["name"] == "John Doe"


def test_keys_are_matched_to_category_names():
    clean, errors = normalize_individual_data(
        {"Name": "Ann", "HEIGHT": 65, "housing_status": "Shelter"}, CATEGORIES)
    assert clean == {"name": "Ann", "height": 65, "Housing_status": "Shelter"}
    assert errors == []


def test_unknown_keys_are_kept_after_cleaning():
    clean, errors = normalize_individual_data({"nickname": "  Jo ", "blank": "  ", "nothing": None}, CATEGORIES)
    assert clean == {"nickname": "Jo"}
    assert errors == []


def test_location_dict_kept_as_is():
    loc = {"latitude": 1.0, "longitude": 2.0, "address": "Market St"}
    clean, _ = normalize_individual_data({"last_location": loc}, CATEGORIES)
    assert clean["last_location"] == loc


def test_normalising_is_idempotent():
    data = {"Name": " Ann ", "height": "5'10", "weight": "150", "gender": "female",
            "medical_conditions": "diabetes, none"}
    once, _ = normalize_individual_data(data, CATEGORIES)
    twice, errors = normalize_individual_data(once, CATEGORIES)
    assert once == twice
    assert errors == []


# --- validate_categorized_data uses the normaliser ---
def test_validation_returns_normalized_data():
    result = validate_categorized_data(
        {"name": "Ann", "height": "65", "weight": "140", "gender": "female", "age": ""}, CATEGORIES)
    assert result.is_valid
    assert result.normalized_data == {"name": "Ann", "height": 65, "weight": 140, "gender": "Female"}


def test_whitespace_name_counts_as_missing():
    result = validate_categorized_data({"name": "   ", "height": 65, "weight": 140}, CATEGORIES)
    assert not result.is_valid
    assert result.missing_required == ["name"]


def test_validation_flags_invalid_multi_select_string():
    result = validate_categorized_data(
        {"name": "Ann", "height": 65, "weight": 140, "medical_conditions": "Diabetes, Flu"}, CATEGORIES)
    assert not result.is_valid
    assert result.validation_errors[0]["field"] == "medical_conditions"
