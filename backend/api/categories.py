"""
Category management endpoints
Minimal implementation for Task 2.0 prerequisite
"""
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from typing import List, Dict, Any
import csv
import io
from api.auth import get_current_user
from api.errors import internal_error
from db.client import fetch_all, get_supabase
from db.models import CreateCategoryRequest, CategoryResponse
from services.field_registry import category_key, export_columns, format_field_value
from services.individual_service import fetch_last_seen, rescore_all_individuals
from services.urgency_calculator import get_display_urgency_score
from datetime import datetime, timezone
from uuid import uuid4
import logging

router = APIRouter()
logger = logging.getLogger(__name__)

# A cell starting with one of these runs as a formula when the CSV is opened in a
# spreadsheet (OWASP "CSV injection"); such cells get a leading "'".
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _csv_cell(value) -> str:
    """One CSV cell: text via field_registry.format_field_value, formula-safe.
    Real numbers are written as-is (a negative number is not a formula)."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    text = format_field_value(value)
    return "'" + text if text.startswith(_FORMULA_PREFIXES) else text


_FIXED_HEADERS = ("Urgency Score", "Last Seen")


def _unique_headers(columns):
    """A category label that equals a fixed header, or an earlier column's header
    (ignoring case), gets its key appended: "Urgency Score (urgency_score)". So
    every CSV header is distinct and the computed columns are never ambiguous."""
    taken = {h.lower() for h in _FIXED_HEADERS}
    out = []
    for key, header in columns:
        if header.lower() in taken:
            header = f"{header} ({key})"
        taken.add(header.lower())
        out.append((key, header))
    return out


@router.get("/api/export")
def export_csv(user_id: str = Depends(get_current_user)):
    """
    Export every individual as CSV.

    Columns: one per category (field_registry.export_columns: Name first, then
    required fields, other presets, then custom fields, headed with each
    category's label), then "Urgency Score" (get_display_urgency_score: the
    override if set, else the calculated score) and "Last Seen" (the latest
    interaction, else when the person was created; never `updated_at`, which an
    urgency override also bumps). Multi-select values are comma-separated, a
    location is its address. Cells that a spreadsheet would run as a formula are
    prefixed with "'". An empty database gives a header-only CSV.
    """
    try:
        supabase = get_supabase()

        categories = supabase.table("categories").select("*").order("created_at").execute().data or []
        individuals = fetch_all(lambda: supabase.table("individuals").select("*")
                                .order("created_at", desc=True).order("id"))
        latest = fetch_last_seen(supabase, [i["id"] for i in individuals]) if individuals else {}
        columns = _unique_headers(export_columns(categories))

        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([_csv_cell(header) for _, header in columns] + list(_FIXED_HEADERS))

        for individual in individuals:
            data = individual.get("data") or {}
            seen = latest.get(str(individual["id"]))
            row = [_csv_cell(individual.get("name") if key == "name" else data.get(key)) for key, _ in columns]
            row.append(get_display_urgency_score(individual))
            row.append(seen["last_seen"] if seen else individual.get("created_at") or "")
            writer.writerow(row)

        return StreamingResponse(
            io.BytesIO(output.getvalue().encode('utf-8')),
            media_type="text/csv",
            headers={
                "Content-Disposition": f"attachment; filename=individuals_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Export CSV", e)


@router.get("/api/categories", response_model=Dict[str, List[Dict[str, Any]]])
def get_categories(user_id: str = Depends(get_current_user)):
    """
    Get all categories (preset and custom) for dynamic prompt generation.
    Returns categories with their configuration for use in GPT-4o categorization.
    """
    try:
        supabase = get_supabase()
        
        # Fetch all categories from database
        response = supabase.table("categories").select("*").order("created_at").execute()
        
        # Format response
        categories = []
        for category in response.data:
            # Parse options if they exist (for select types)
            cat_data = {
                "id": category["id"],
                "name": category["name"],
                "display_name": category.get("display_name"),
                "type": category["type"],
                "is_required": category["is_required"],
                "is_preset": category["is_preset"],
                "priority": category.get("priority", "medium"),
                "urgency_weight": category.get("urgency_weight", 0),
                "auto_trigger": category.get("auto_trigger", False),
                "options": category.get("options", None)
            }
            categories.append(cat_data)
        
        return {"categories": categories}

    except HTTPException:
        raise
    except Exception as e:
        raise internal_error("Fetch categories", e)


def _is_unique_violation(exc: Exception) -> bool:
    """A Postgres unique-constraint error (23505), e.g. two concurrent creates."""
    return getattr(exc, "code", None) == "23505"


@router.post("/api/categories", response_model=CategoryResponse, status_code=status.HTTP_201_CREATED)
def create_category(
    request: CreateCategoryRequest,
    user_id: str = Depends(get_current_user)
):
    """
    Create a new custom category.

    The worker's text is kept as `display_name` ("HIV status") and its
    `category_key` ("hiv_status") is stored as `name`, the key used in every
    individual's `data`. A name whose key matches an existing category's key
    (by `name` or `display_name`) is a 409, so "Veteran status" can't shadow
    the preset `veteran_status` and "Housing-status" can't sit beside
    "Housing status". The check compares keys in Python (the table is small),
    so `%` and `_` are never LIKE wildcards. A concurrent duplicate that slips
    past the check hits the UNIQUE constraint (23505) and is also a 409.

    Type rules (options, weight, auto-trigger) are enforced by
    CreateCategoryRequest, so a bad request is a 422 before this runs.

    A category with `urgency_weight > 0` or `auto_trigger` changes the urgency
    maths for everyone, so every individual is re-scored
    (`rescore_all_individuals`). A re-score failure is logged and the 201 stands;
    scripts/rescore_urgency.py repairs the scores later.
    """
    try:
        supabase = get_supabase()

        key = category_key(request.name)
        conflict = HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A category named '{request.name}' already exists"
        )
        existing = supabase.table("categories").select("name, display_name").execute().data or []
        for row in existing:
            if key in {category_key(row.get("name") or ""), category_key(row.get("display_name") or "")}:
                raise conflict

        now = datetime.now(timezone.utc).isoformat()
        category_data = {
            "id": str(uuid4()),
            "name": key,
            "display_name": request.name,
            "type": request.type,
            "is_required": request.is_required,
            "is_preset": False,  # Custom categories are never preset
            "priority": request.priority,
            "urgency_weight": request.urgency_weight,
            "auto_trigger": request.auto_trigger,
            "options": request.options,
            "created_at": now,
            "updated_at": now
        }

        try:
            result = supabase.table("categories").insert(category_data).execute()
        except Exception as e:
            if _is_unique_violation(e):
                raise conflict
            raise

        if not result.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create category"
            )

        created = result.data[0]

        # OD-1: a weighted category joins everyone's denominator, so re-score all
        # stored scores now. The category exists either way, so a failure here is
        # logged (error type only) and the create still succeeds.
        if (created.get("urgency_weight") or 0) > 0 or created.get("auto_trigger"):
            try:
                rescore_all_individuals(supabase)
            except Exception as e:
                logger.warning("Re-scoring after category create failed: %s", type(e).__name__)

        return CategoryResponse(
            id=created["id"],
            name=created["name"],
            display_name=created.get("display_name"),
            type=created["type"],
            is_required=created["is_required"],
            is_preset=created["is_preset"],
            priority=created["priority"],
            urgency_weight=created["urgency_weight"],
            auto_trigger=created["auto_trigger"],
            options=created["options"],
            created_at=created["created_at"],
            updated_at=created["updated_at"]
        )

    except HTTPException:
        raise
    except Exception as e:
        # Request validation already happened (FastAPI returns 422 before this runs),
        # so anything else here is a server-side failure.
        raise internal_error("Create category", e)
