"""
Duplicate decision labels (H2-3.6): which match the merge screen showed, its
confidence, and whether the worker merged or saved new. Labels for the duplicate
eval; recording one must never fail the save it belongs to.
"""
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


def record_duplicate_decision(supabase: Any, *, candidate_id: str, matched_id: str, confidence: int,
                              decision: str, model: Optional[str], client_request_id: Optional[str]) -> None:
    """Write one label. A retried save (same client_request_id) writes nothing new.
    Sync (it runs as a background task). Never raises; logs only the error type."""
    try:
        supabase.table("duplicate_decisions").upsert({
            "candidate_id": candidate_id,
            "matched_id": matched_id,
            "confidence": confidence,
            "decision": decision,
            "model": model,
            "client_request_id": client_request_id,
        }, on_conflict="client_request_id", ignore_duplicates=True).execute()
    except Exception as e:
        logger.warning("Recording duplicate decision failed: %s", type(e).__name__)
