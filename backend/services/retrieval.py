"""
Read-only retrieval for the voice assistant's tools (H2-4.7).

Four functions over the database, each returning plain JSON-safe dicts with every
value clipped (field_registry.clip_value) and every label cut to MAX_LABEL_CHARS.
They are not escaped: the realtime proxy (Phase 5) serialises and delimits them as
tool output. Every database call goes through run_db; database errors propagate.

- search_people: the hybrid search, plus people found only through a matching visit.
- get_person: everything about one person, sensitive fields included, and recent visits.
- recent_interactions: one person's visits, newest first.
- most_urgent: the most urgent people, optionally near an SF neighbourhood.
"""
import logging
import re
from typing import Any, Dict, List, Optional

from db.client import get_supabase, run_db
from services.embedding_service import DEFAULT_SIMILARITY_THRESHOLD, get_embedding_service
from services.field_registry import clip_value, display_label, export_columns, sensitive_keys
from services.individual_service import IndividualService, fetch_last_seen
from services.sf_neighborhoods import area_name, resolve_area
from services.urgency_calculator import get_display_urgency_score

logger = logging.getLogger(__name__)

MAX_LIMIT = 20
MAX_LABEL_CHARS = 50
MAX_TRANSCRIPT_CHARS = 500
MAX_EXCERPT_CHARS = 200
SUMMARY_MAX_FACTS = 6
RECENT_VISITS = 5

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_abbreviate = IndividualService(None).abbreviate_address


class UnknownAreaError(ValueError):
    """`near` names no known SF neighbourhood (the name is not echoed)."""

    def __init__(self):
        super().__init__("Unknown area")


def _clamp(limit: Any) -> int:
    try:
        return max(1, min(int(limit), MAX_LIMIT))
    except (TypeError, ValueError):
        return RECENT_VISITS


def _empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or (isinstance(value, str) and not value.strip())


def _area(location: Any) -> Optional[str]:
    """The neighbourhood holding the point, else the abbreviated address, else None."""
    if not isinstance(location, dict):
        return None
    lat, lng = location.get("latitude"), location.get("longitude")
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (lat, lng)):
        name = area_name(float(lat), float(lng))
        if name:
            return name
    address = location.get("address")
    if isinstance(address, str) and address.strip() and address.strip() != "Unknown Address":
        return _abbreviate(address) or None
    return None


def _label(category: dict) -> str:
    return display_label(category)[:MAX_LABEL_CHARS]


def _labels(categories: List[dict]) -> Dict[str, str]:
    return {c["name"]: _label(c) for c in categories if c.get("name")}


async def _categories(supabase: Any) -> List[dict]:
    return (await run_db(lambda: supabase.table("categories").select("*").order("created_at").execute())).data or []


def _facts(data: dict, categories: List[dict]) -> Dict[str, Any]:
    """Up to SUMMARY_MAX_FACTS non-empty, non-sensitive fields, in export order, no name."""
    hidden = sensitive_keys(categories) | {"name"}
    facts: Dict[str, Any] = {}
    for key, label in export_columns(categories):
        if key in hidden or _empty(data.get(key)):
            continue
        facts[label[:MAX_LABEL_CHARS]] = clip_value(data[key])
        if len(facts) == SUMMARY_MAX_FACTS:
            break
    return facts


def _summary(row: dict, categories: List[dict], last_seen: Optional[str], location: Any) -> dict:
    return {
        "id": str(row["id"]),
        "name": clip_value(row.get("name") or "Unknown"),
        "urgency": get_display_urgency_score(row),
        "urgency_overridden": row.get("urgency_override") is not None,
        "last_seen": last_seen or row.get("created_at"),
        "last_seen_area": _area(location),
        "facts": _facts(row.get("data") if isinstance(row.get("data"), dict) else {}, categories),
    }


def _interaction(row: dict, labels: Dict[str, str]) -> dict:
    changes = row.get("changes") if isinstance(row.get("changes"), dict) else {}
    removed = [k for k in (changes.get("_removed") or []) if isinstance(k, str)]
    label = lambda key: labels.get(key) or display_label({"name": key})[:MAX_LABEL_CHARS]  # noqa: E731
    changed = [label(k) for k in changes if k != "_removed" and k not in removed]
    transcript = row.get("transcription")
    return {
        "id": str(row["id"]),
        "date": row.get("created_at"),
        "area": _area(row.get("location")),
        "worker": clip_value(row.get("user_name") or "Unknown"),
        "transcript": transcript[:MAX_TRANSCRIPT_CHARS] if isinstance(transcript, str) and transcript else None,
        "changed_fields": changed + [f"{label(k)} (removed)" for k in removed],
    }


async def _visits(supabase: Any, individual_id: str, limit: int) -> List[dict]:
    return (await run_db(lambda: supabase.table("interactions").select("*")
                         .eq("individual_id", individual_id)
                         .order("created_at", desc=True).limit(limit).execute())).data or []


async def search_people(query: str, limit: int = 5) -> list[dict]:
    """Hybrid search (exact name first, then fused name/full-text/semantic), then people
    found only through a matching visit transcript (`match: "visit"`)."""
    q = (query or "").strip()
    if not q:
        return []
    limit = _clamp(limit)
    supabase = get_supabase()
    try:
        vector = await get_embedding_service().embed_query(q)
    except Exception as e:
        logger.warning("Query embedding failed: %s", type(e).__name__)
        vector = None
    params = {"p_query": q, "p_query_embedding": vector, "p_limit": limit,
              "p_min_similarity": DEFAULT_SIMILARITY_THRESHOLD}
    rows = (await run_db(lambda: supabase.rpc("search_individuals_hybrid", params).execute())).data or []

    visits: List[dict] = []
    if vector is not None:
        visit_params = {"p_query_embedding": vector, "p_individual_id": None, "p_limit": limit}
        visits = [v for v in (await run_db(lambda: supabase.rpc("match_interactions", visit_params).execute())).data or []
                  if (v.get("similarity") or 0) >= DEFAULT_SIMILARITY_THRESHOLD]
    best_visit: Dict[str, dict] = {}
    for visit in visits:   # nearest first
        best_visit.setdefault(str(visit["individual_id"]), visit)

    found = {str(r["id"]) for r in rows}
    extra_ids = [pid for pid in best_visit if pid not in found]
    if extra_ids:
        people = (await run_db(lambda: supabase.table("individuals").select("*")
                               .in_("id", extra_ids).execute())).data or []
        by_id = {str(p["id"]): p for p in people}
        rows = rows + [{**by_id[pid], "match_source": "visit"} for pid in extra_ids if pid in by_id]

    categories = await _categories(supabase)
    seen = await run_db(lambda: fetch_last_seen(supabase, [r["id"] for r in rows])) if rows else {}
    out = []
    for row in rows[:limit]:
        pid = str(row["id"])
        latest = seen.get(pid) or {}
        summary = _summary(row, categories, latest.get("last_seen"), latest.get("location") or row.get("last_location"))
        visit = best_visit.get(pid)
        summary["match"] = row.get("match_source") or "semantic"
        summary["matched_visit"] = ({"date": visit.get("created_at"),
                                     "excerpt": (visit.get("transcription") or "")[:MAX_EXCERPT_CHARS]}
                                    if visit else None)
        out.append(summary)
    return out


async def get_person(individual_id: str) -> dict | None:
    """Everything about one person (sensitive fields included, and listed), with their
    RECENT_VISITS newest visits; None for a malformed or unknown id."""
    if not isinstance(individual_id, str) or not _UUID.match(individual_id.strip()):
        return None
    individual_id = individual_id.strip()
    supabase = get_supabase()
    response = await run_db(lambda: supabase.table("individuals").select("*").eq("id", individual_id)
                            .maybe_single().execute())
    row = response.data if response is not None else None
    if not row:
        return None
    categories = await _categories(supabase)
    visits = await _visits(supabase, individual_id, RECENT_VISITS)
    data = row.get("data") if isinstance(row.get("data"), dict) else {}
    sensitive = sensitive_keys(categories)

    fields: Dict[str, Any] = {}
    sensitive_fields: List[str] = []

    def add(key: str, label: str) -> None:
        if key == "name" or _empty(data.get(key)):
            return
        label = label[:MAX_LABEL_CHARS]
        if label in fields:
            label = f"{label} ({key})"
        fields[label] = clip_value(data[key])
        if key in sensitive:
            sensitive_fields.append(label)

    categorised = set()
    for key, label in export_columns(categories):
        categorised.add(key)
        add(key, label)
    for key in sorted(k for k in data if isinstance(k, str) and k not in categorised):
        add(key, display_label({"name": key}))

    newest = visits[0] if visits else None
    summary = _summary(row, categories, newest.get("created_at") if newest else None,
                       (newest or {}).get("location") or row.get("last_location"))
    labels = _labels(categories)
    return {
        **{k: summary[k] for k in ("id", "name", "urgency", "urgency_overridden", "last_seen", "last_seen_area")},
        "first_seen": row.get("created_at"),
        "fields": fields,
        "sensitive_fields": sensitive_fields,
        "recent_interactions": [_interaction(v, labels) for v in visits],
    }


async def recent_interactions(individual_id: str, limit: int = 5) -> list[dict]:
    """One person's visits, newest first: date, area, worker, clipped transcript and the
    labels of what changed (never the values); [] for a malformed or unknown id."""
    if not isinstance(individual_id, str) or not _UUID.match(individual_id.strip()):
        return []
    supabase = get_supabase()
    visits = await _visits(supabase, individual_id.strip(), _clamp(limit))
    if not visits:
        return []
    labels = _labels(await _categories(supabase))
    return [_interaction(v, labels) for v in visits]


async def most_urgent(near: str | None = None, limit: int = 5) -> list[dict]:
    """The most urgent people (display urgency), optionally within an SF neighbourhood's
    radius. An unknown `near` raises UnknownAreaError before any query."""
    lat = lng = radius = None
    if near is not None and near.strip():
        centre = resolve_area(near)
        if centre is None:
            raise UnknownAreaError()
        lat, lng, radius = centre
    supabase = get_supabase()
    params = {"p_lat": lat, "p_lng": lng, "p_radius_m": radius, "p_limit": _clamp(limit)}
    rows = (await run_db(lambda: supabase.rpc("most_urgent_individuals", params).execute())).data or []
    categories = await _categories(supabase)
    out = []
    for row in rows:
        summary = _summary(row, categories, row.get("last_seen"), row.get("last_location"))
        distance = row.get("distance_m")
        summary["distance_m"] = int(round(distance)) if isinstance(distance, (int, float)) else None
        out.append(summary)
    return out
