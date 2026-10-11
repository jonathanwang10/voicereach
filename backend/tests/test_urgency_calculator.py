"""Urgency maths per owner decision OD-1 (C-21) plus the C-14/C-15 crash fixes."""
from services.urgency_calculator import calculate_urgency_score

VETERAN = {"name": "veteran_status", "type": "single_select", "urgency_weight": 20, "auto_trigger": False,
           "options": [{"label": "Yes", "value": 1}, {"label": "No", "value": 0}, {"label": "Unknown", "value": 0}]}
HOUSING = {"name": "housing_priority", "type": "single_select", "urgency_weight": 30, "auto_trigger": False,
           "options": [{"label": "Critical", "value": 1}, {"label": "High", "value": 0.7},
                       {"label": "Medium", "value": 0.4}, {"label": "Low", "value": 0.1}]}
BEHAVIOR = {"name": "behavior", "type": "single_select", "urgency_weight": 40, "auto_trigger": True,
            "options": [{"label": "None", "value": 0}, {"label": "Verbal Only", "value": 0.3},
                        {"label": "Physical", "value": 1}]}
SEED_WEIGHTED = [VETERAN, HOUSING, BEHAVIOR]


def test_c21_stating_a_benign_fact_does_not_change_the_score():
    """C-21: {veteran: Yes} scored 100 (red) but {veteran: Yes, behavior: None} scored 33 (green)."""
    alone = calculate_urgency_score({"veteran_status": "Yes"}, SEED_WEIGHTED)
    with_benign = calculate_urgency_score({"veteran_status": "Yes", "behavior": "None"}, SEED_WEIGHTED)
    assert alone == with_benign
    # 20 / (20 + 30 + 40) * 100
    assert alone == 22


def test_missing_weighted_values_count_as_zero():
    cats = [{"name": "height", "type": "number", "urgency_weight": 30, "auto_trigger": False},
            {"name": "weight", "type": "number", "urgency_weight": 50, "auto_trigger": False}]
    # (90/300 * 30) / (30 + 50) * 100 = 11.25
    assert calculate_urgency_score({"height": 90}, cats) == 11


def test_auto_trigger_rule_unchanged():
    assert calculate_urgency_score({"behavior": "Verbal Only"}, SEED_WEIGHTED) == 100
    assert calculate_urgency_score({"behavior": "None"}, SEED_WEIGHTED) == 0


def test_empty_string_number_does_not_raise():
    cats = [{"name": "days", "type": "number", "urgency_weight": 10, "auto_trigger": False}]
    assert calculate_urgency_score({"days": ""}, cats) == 0


def test_empty_string_number_auto_trigger_does_not_raise():
    cats = [{"name": "days", "type": "number", "urgency_weight": 10, "auto_trigger": True}]
    assert calculate_urgency_score({"days": ""}, cats) == 0


def test_null_weight_does_not_crash():
    cats = [{"name": "days", "type": "number", "urgency_weight": None, "auto_trigger": False}, HOUSING]
    assert calculate_urgency_score({"days": 5, "housing_priority": "Critical"}, cats) == 100


def test_negative_number_does_not_go_below_zero():
    cats = [{"name": "days", "type": "number", "urgency_weight": 10, "auto_trigger": False}]
    assert calculate_urgency_score({"days": -300}, cats) == 0


def test_score_is_clamped_to_100():
    cats = [{"name": "risk", "type": "single_select", "urgency_weight": 10, "auto_trigger": False,
             "options": [{"label": "Extreme", "value": 5}]}]
    assert calculate_urgency_score({"risk": "Extreme"}, cats) == 100


def test_non_numeric_number_value_counts_as_zero():
    cats = [{"name": "days", "type": "number", "urgency_weight": 10, "auto_trigger": False}]
    assert calculate_urgency_score({"days": "lots"}, cats) == 0


def test_no_weighted_categories_scores_zero():
    cats = [{"name": "name", "type": "text", "urgency_weight": 100, "auto_trigger": False}]
    assert calculate_urgency_score({"name": "Ann"}, cats) == 0


def _number(name, weight, auto_trigger=False):
    return {"name": name, "type": "number", "urgency_weight": weight, "auto_trigger": auto_trigger}


def test_numbers_are_value_over_300_times_weight_normalised_by_total_weight():
    # [(90/300)*30 + (200/300)*50] / (30+50) * 100 = 52.9 -> 52
    assert calculate_urgency_score({"height": 90, "weight": 200}, [_number("height", 30), _number("weight", 50)]) == 52


def test_single_select_uses_the_option_value():
    cats = [{"name": "risk_level", "type": "single_select", "urgency_weight": 80, "auto_trigger": False,
             "options": [{"label": "Low", "value": 0.2}, {"label": "High", "value": 0.9}]}]
    assert calculate_urgency_score({"risk_level": "High"}, cats) == 90


def test_text_categories_never_score_even_with_a_weight():
    cats = [{"name": "name", "type": "text", "urgency_weight": 100, "auto_trigger": False}, _number("height", 50)]
    # only height: (60/300)*50 / 50 * 100 = 20
    assert calculate_urgency_score({"name": "John Doe", "height": 60}, cats) == 20


def test_all_zero_weights_score_zero_not_a_division_error():
    assert calculate_urgency_score({"height": 90, "weight": 200}, [_number("height", 0), _number("weight", 0)]) == 0


def test_auto_trigger_number_fires_for_a_non_zero_value():
    assert calculate_urgency_score({"incidents": 50}, [_number("incidents", 30, auto_trigger=True)]) == 100


def test_auto_trigger_number_zero_does_not_fire():
    assert calculate_urgency_score({"incidents": 0}, [_number("incidents", 10, auto_trigger=True)]) == 0
