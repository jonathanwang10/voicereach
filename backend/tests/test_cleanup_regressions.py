from unittest.mock import MagicMock

import pytest

from services.urgency_calculator import calculate_urgency_score
from services.openai_service import OpenAIService
from services.validation_helper import validate_categorized_data
from services.context_service import ContextService
from services.duplicate_detection_service import DuplicateDetectionService
from db.models import CreateCategoryRequest

BEHAVIOR = {
    "name": "behavior", "type": "single_select", "urgency_weight": 40, "auto_trigger": True,
    "options": [{"label": "None", "value": 0}, {"label": "Verbal Only", "value": 0.3},
                {"label": "Physical", "value": 1}],
}


# --- D2: auto-trigger uses the option's value, not its label ---
def test_auto_trigger_ignores_zero_value_option():
    assert calculate_urgency_score({"behavior": "None"}, [BEHAVIOR]) == 0

def test_auto_trigger_fires_for_positive_option():
    assert calculate_urgency_score({"behavior": "Verbal Only"}, [BEHAVIOR]) == 100

def test_auto_trigger_number_zero_does_not_fire():
    cat = {"name": "incidents", "type": "number", "urgency_weight": 10, "auto_trigger": True}
    assert calculate_urgency_score({"incidents": 0}, [cat]) == 0


# --- height parsing ---
@pytest.mark.parametrize("raw,expected", [
    ("5 ft 10", 70), ("5 feet 10 inches", 70), ("5'10", 70), ("5' 10\"", 70),
    ("6 feet", 72),
    ("6 ft 180 lbs", 72), ("5 foot 150 pounds", 60), ("5'", 60), ("5 ft", 60), ("6 foot 2", 74), ("70 inches", 70), ("70", 70),
    ("5 feet, 10 inches", 70), ("6 ft, 2 in", 74),
])
def test_parse_height(raw, expected):
    assert OpenAIService.__new__(OpenAIService)._parse_height(raw) == expected


# --- validation rejects nan/inf ---
@pytest.mark.parametrize("bad", ["nan", "NaN", "inf", "-inf"])
def test_validation_rejects_non_finite_numbers(bad):
    cats = [{"name": "age", "type": "number", "is_required": False}]
    result = validate_categorized_data({"age": bad}, cats)
    assert not result.is_valid


# --- context includes age ---
def test_context_includes_age():
    svc = ContextService.__new__(ContextService)
    text = svc.format_individual_context([{"name": "Ann", "urgency_score": 10, "urgency_override": None,
                                            "data": {"age": 52}}])
    assert "Age: 52" in text


# --- category model defaults never null; select option values numeric ---
def test_category_null_weight_defaults_to_zero():
    req = CreateCategoryRequest(name="notes2", type="text")
    assert req.urgency_weight == 0 and req.priority == "medium"

def test_category_rejects_null_weight():
    with pytest.raises(Exception):
        CreateCategoryRequest(name="x", type="text", urgency_weight=None)

def test_single_select_option_value_must_be_numeric():
    with pytest.raises(Exception):
        CreateCategoryRequest(name="x", type="single_select",
                              options=[{"label": "A", "value": "high"}])


# --- duplicate detection tolerates non-string names ---
@pytest.mark.asyncio
async def test_find_duplicates_non_string_name_returns_empty():
    svc = DuplicateDetectionService.__new__(DuplicateDetectionService)
    assert await svc.find_duplicates({"name": 123}) == []

def test_ilike_escape():
    assert DuplicateDetectionService._escape_ilike("a_b%c*") == r"a\_b\%c\*"


# --- display score honours an override of 0 ---
@pytest.mark.asyncio
async def test_display_score_honours_override_of_zero():
    from services.individual_service import IndividualService
    row = {"id": "11111111-1111-1111-1111-111111111111", "name": "Ann", "urgency_score": 80,
           "urgency_override": 0, "data": {}, "created_at": "2025-01-01T00:00:00",
           "updated_at": "2025-01-01T00:00:00", "last_location": None}
    sb = MagicMock()
    sb.table.return_value.select.return_value.eq.return_value.maybe_single.return_value.execute.return_value.data = row
    sb.table.return_value.select.return_value.eq.return_value.order.return_value.limit.return_value.execute.return_value.data = []
    result = await IndividualService(sb).get_individual_by_id(row["id"])
    assert result.individual.display_score == 0


def test_invalidate_context_cache_empties_shared_cache():
    from unittest.mock import MagicMock
    from services import context_service
    svc = context_service.get_context_service(MagicMock())
    svc.cache["k"] = {"timestamp": 0, "data": {}}
    context_service.invalidate_context_cache()
    assert svc.cache == {}
