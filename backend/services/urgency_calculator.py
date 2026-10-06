"""
Urgency score calculation service
"""
from typing import Any


def _auto_trigger_fires(category: dict, value: Any) -> bool:
    """True when an auto-trigger category's value should pin urgency to 100."""
    if value is None or value == "":
        return False
    if category["type"] == "single_select":
        for option in category.get("options") or []:
            if option.get("label") == value:
                try:
                    return float(option.get("value", 0)) > 0
                except (TypeError, ValueError):
                    return False
        return False
    try:
        return float(value) != 0
    except (TypeError, ValueError):
        return False


def calculate_urgency_score(individual_data: dict, categories: list) -> int:
    """
    Calculate urgency score based on weighted category values

    Args:
        individual_data: Dictionary of field values for the individual
        categories: List of category definitions with urgency weights

    Returns:
        Integer urgency score 0-100

    Formula:
        - Auto-trigger: If value exists AND auto_trigger=true → return 100
        - Numbers: (value / 300) * weight
        - Single-select: option_value * weight
        - Final: (sum of weighted values / sum of weights) * 100
    """
    # Check for auto-trigger first
    for category in categories:
        if category.get('auto_trigger') and category['type'] in ['number', 'single_select']:
            if _auto_trigger_fires(category, individual_data.get(category['name'])):
                return 100

    total_weight = 0
    weighted_sum = 0
    
    for category in categories:
        # Skip if no urgency weight or not applicable type
        if category.get('urgency_weight', 0) == 0:
            continue
        if category['type'] not in ['number', 'single_select']:
            continue

        value = individual_data.get(category['name'])
        
        if value is None:
            continue
            
        weight = category['urgency_weight']
        total_weight += weight
        
        if category['type'] == 'number':
            # Normalize numeric values (max 300 for all fields)
            normalized = min(float(value) / 300, 1.0)
            contribution = normalized * weight
            weighted_sum += contribution
        elif category['type'] == 'single_select':
            # Find the urgency value for selected option
            if category.get('options'):
                for option in category['options']:
                    if option.get('label') == value:
                        option_value = float(option.get('value', 0))
                        contribution = option_value * weight
                        weighted_sum += contribution
                        break

    if total_weight == 0:
        return 0
        
    final_score = int((weighted_sum / total_weight) * 100)
    return final_score


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
