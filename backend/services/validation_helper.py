"""
Validation helper for categorized data
"""
from typing import Any, Dict, List
from dataclasses import dataclass, field

from services.field_registry import normalize_individual_data


@dataclass
class ValidationResult:
    """Result of validation with errors, missing fields and the normalised data"""
    is_valid: bool
    missing_required: List[str]
    validation_errors: List[Dict[str, str]]  # [{"field": "height", "message": "Value 400 exceeds maximum of 300"}]
    normalized_data: Dict[str, Any] = field(default_factory=dict)


def validate_categorized_data(data: dict, categories: list) -> ValidationResult:
    """
    Normalise categorized data, then validate it against the categories.

    The values are normalised by `field_registry.normalize_individual_data`
    (types coerced, select labels canonicalised, empty values dropped), and the
    required check runs on the normalised data, so "  " counts as missing.

    Args:
        data: Dictionary of categorized data to validate
        categories: List of category definitions with types and constraints

    Returns:
        ValidationResult with validation status, missing fields, errors and normalized_data
    """
    normalized, validation_errors = normalize_individual_data(data, categories)

    missing_required = [
        category["name"]
        for category in categories
        if category.get("is_required") and category["name"] not in normalized
    ]

    return ValidationResult(
        is_valid=not missing_required and not validation_errors,
        missing_required=missing_required,
        validation_errors=validation_errors,
        normalized_data=normalized,
    )
