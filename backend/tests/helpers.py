"""Shared helpers for tests that mock IndividualService."""
from db.models import SaveIndividualResponse


def save_response(payload: dict) -> SaveIndividualResponse:
    """Build the object IndividualService.save_individual really returns.

    The route reads result.individual.id, so a bare dict is not enough.
    """
    payload["individual"].setdefault("last_location", None)
    return SaveIndividualResponse.model_validate(payload)
