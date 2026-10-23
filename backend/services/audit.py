"""
The audit log (H2-2.7): who (user id, device id) did what to which record, when.

A row holds ids and counts only, never names or field values, and the table is
append-only. Writing it must never break the action it records, so record_audit
swallows every error and logs only the action and the error type.
"""
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Must match audit_log's CHECK constraints in supabase/schema.sql
AUDIT_ACTIONS = frozenset({
    "view_profile", "export_csv", "delete_individual", "override_urgency",
    "merge_individual", "create_individual", "create_category",
})
AUDIT_ENTITY_TYPES = frozenset({"individual", "category", "export"})


def record_audit(supabase: Any, *, user_id: str, device_id: Optional[str], action: str, entity_type: str,
                 entity_id: Optional[str], detail: Optional[dict] = None) -> None:
    """Insert one audit row. Sync: async routes call it as `await run_db(lambda: record_audit(...))`.
    Never raises."""
    if action not in AUDIT_ACTIONS or entity_type not in AUDIT_ENTITY_TYPES:
        logger.warning("Audit skipped: unknown action %s", action)
        return
    try:
        supabase.table("audit_log").insert({
            "user_id": user_id,
            "device_id": device_id,
            "action": action,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "detail": detail or {},
        }).execute()
    except Exception as e:  # a strict test fake's AssertionError included
        logger.warning("Audit write failed for %s: %s", action, type(e).__name__)
