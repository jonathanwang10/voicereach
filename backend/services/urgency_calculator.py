"""
Urgency score calculation service
"""
import math
from typing import Any, Optional

SCORED_TYPES = ("number", "single_select")


def _is_missing(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _as_number(value: Any) -> Optional[float]:
    """A finite float, or None for missing/non-numeric values (never raises)."""
    if isinstance(value, bool) or _is_missing(value):
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    return num if math.isfinite(num) else None


def _weight(category: dict) -> float:
    """`urgency_weight or 0`, tolerating NULL and junk."""
    return _as_number(category.get("urgency_weight")) or 0.0


def _option_value(category: dict, value: Any) -> Optional[float]:
    """The numeric value of the chosen single-select option, or None."""
    for option in category.get("options") or []:
        if isinstance(option, dict) and option.get("label") == value:
            return _as_number(option.get("value"))
    return None


def _auto_trigger_fires(category: dict, value: Any) -> bool:
    """True when an auto-trigger category's value should pin urgency to 100."""
    if _is_missing(value):
        return False
    if category["type"] == "single_select":
        option_value = _option_value(category, value)
        return option_value is not None and option_value > 0
    num = _as_number(value)
    return num is not None and num != 0


def calculate_urgency_score(individual_data: dict, categories: list) -> int:
    """
    Calculate urgency score based on weighted category values (owner decision OD-1).

    Args:
        individual_data: Normalised field values for the individual
        categories: List of category definitions with urgency weights

    Returns:
        Integer urgency score 0-100

    Formula:
        - Auto-trigger: a number/single_select category with auto_trigger fires when a
          select's chosen option value is > 0 or a number is non-zero -> 100
        - Denominator: sum of `urgency_weight or 0` over EVERY number/single_select
          category with weight > 0, whether or not it has a value
        - Numbers: min(max(value, 0) / 300, 1) * weight
        - Single-select: option_value * weight
        - A missing (None / "") or unparseable value contributes 0
        - Final: int(sum / total_weight * 100), clamped to 0-100
    """
    for category in categories:
        if category.get("auto_trigger") and category.get("type") in SCORED_TYPES:
            if _auto_trigger_fires(category, individual_data.get(category["name"])):
                return 100

    total_weight = 0.0
    weighted_sum = 0.0

    for category in categories:
        weight = _weight(category)
        if weight <= 0 or category.get("type") not in SCORED_TYPES:
            continue
        total_weight += weight

        value = individual_data.get(category["name"])
        if _is_missing(value):
            continue

        if category["type"] == "number":
            num = _as_number(value)
            if num is not None:
                weighted_sum += min(max(num, 0.0) / 300, 1.0) * weight
        else:
            option_value = _option_value(category, value)
            if option_value is not None:
                weighted_sum += option_value * weight

    if total_weight == 0:
        return 0

    # round() first so float noise (e.g. 89.99999999) does not truncate a whole point
    score = int(round(weighted_sum / total_weight * 100, 6))
    return max(0, min(100, score))


def get_display_urgency_score(individual: dict) -> int:
    """
    Get urgency score to display (override or calculated)

    Args:
        individual: Individual record with urgency_score and urgency_override fields

    Returns:
        Integer urgency score to display
    """
    if individual.get('urgency_override') is not None:
        return individual['urgency_override']
    return individual.get('urgency_score', 0)
