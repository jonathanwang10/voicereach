"""
Database models and Pydantic schemas for individual management
"""
import re

from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Optional, Dict, Any, List, Literal
from datetime import datetime
from uuid import UUID

from services.field_registry import category_key


MAX_NAME_LENGTH = 200
# Bounds on one save, so a request can't store an unbounded record (H2-1.5)
MAX_TRANSCRIPTION_LENGTH = 20000
MAX_DATA_FIELDS = 100


# Request Models
class LocationData(BaseModel):
    """Location data from frontend with geocoded address"""
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    address: str  # Full address from frontend geocoding


class DuplicateDecision(BaseModel):
    """What the worker did with the match on the merge screen (H2-3.6)"""
    matched_id: UUID
    confidence: int = Field(..., ge=0, le=100)
    decision: Literal["merged", "saved_new"]


class SaveIndividualRequest(BaseModel):
    """Request to save a new individual or update existing (merge)"""
    data: Dict[str, Any]  # Categorized data from AI or manual entry
    merge_with_id: Optional[UUID] = None  # If merging, ID of existing individual
    location: Optional[LocationData] = None
    transcription: Optional[str] = Field(None, max_length=MAX_TRANSCRIPTION_LENGTH)  # Original audio transcription if voice entry
    audio_url: Optional[str] = None  # Reference to audio file
    # The merge target's version when the app loaded it (H2-2.3); a stale one is a 409.
    # Optional for older clients: the service then guards with the version it reads.
    expected_version: Optional[int] = Field(None, ge=1)
    # Sent when the save came from the merge screen: a label for the duplicate eval
    duplicate_decision: Optional[DuplicateDecision] = None

    @model_validator(mode="after")
    def expected_version_needs_a_merge(self):
        if self.expected_version is not None and self.merge_with_id is None:
            raise ValueError("expected_version needs merge_with_id")
        decision = self.duplicate_decision
        if decision is not None:
            if decision.decision == "merged" and self.merge_with_id != decision.matched_id:
                raise ValueError("a merged duplicate_decision must name the merge target")
            if decision.decision == "saved_new" and self.merge_with_id is not None:
                raise ValueError("a saved_new duplicate_decision can't come with merge_with_id")
        return self

    @field_validator('data')
    def validate_required_fields(cls, v):
        """Ensure required fields exist per PRD. A blank or whitespace-only value counts as missing."""
        if len(v) > MAX_DATA_FIELDS:
            raise ValueError(f"data can have at most {MAX_DATA_FIELDS} fields")
        # The merge diff uses `_removed` for dropped fields (H2-2.5)
        if any(category_key(k) == "_removed" for k in v):
            raise ValueError("_removed is a reserved field name")
        required = ['name', 'height', 'weight']
        missing = [
            f for f in required
            if v.get(f) is None or (isinstance(v[f], str) and not v[f].strip())
        ]
        if missing:
            raise ValueError(f"Missing required fields: {', '.join(missing)}")
        name = v.get('name')
        if isinstance(name, str) and len(name.strip()) > MAX_NAME_LENGTH:
            # Names reach the assistant's prompt; keep them name-sized (C-28)
            raise ValueError(f"name must be at most {MAX_NAME_LENGTH} characters")
        return v


class UrgencyOverrideRequest(BaseModel):
    """Request to update urgency score override"""
    urgency_override: Optional[int] = Field(None, ge=0, le=100)


# Response Models
class IndividualSummary(BaseModel):
    """Individual summary for list views"""
    id: UUID
    name: str
    urgency_score: int
    urgency_override: Optional[int]
    display_score: int  # Computed: urgency_override if not null, else urgency_score
    last_seen: datetime
    last_location: Optional[Dict[str, Any]]  # Simplified location with abbreviated address


class IndividualResponse(BaseModel):
    """Full individual data"""
    id: UUID
    name: str
    urgency_score: int
    urgency_override: Optional[int]
    display_score: int  # Computed: urgency_override if not null, else urgency_score
    data: Dict[str, Any]  # All categorized fields
    created_at: datetime
    updated_at: datetime
    last_location: Optional[Dict[str, Any]]  # Last known location with address
    version: int = 1  # bumped by every save; a merge sends it back as expected_version (H2-2.3)


class InteractionSummary(BaseModel):
    """Brief interaction info for lists"""
    id: UUID
    created_at: datetime
    user_name: Optional[str]  # NOT NULL in schema.sql; Optional so one bad row can't 500 the route
    location: Optional[Dict[str, Any]]
    has_transcription: bool


class InteractionDetail(BaseModel):
    """Full interaction details with changes"""
    id: UUID
    created_at: datetime
    user_name: Optional[str]  # NOT NULL in schema.sql; Optional so one bad row can't 500 the route
    transcription: Optional[str]
    location: Optional[Dict[str, Any]]  # Full location with complete address
    changes: Dict[str, Any]  # Only fields that changed in this interaction


class SaveIndividualResponse(BaseModel):
    """Response after saving individual"""
    individual: IndividualResponse
    interaction: InteractionSummary
    # True when the Idempotency-Key was already used: this is the first save's result,
    # and nothing was written (H2-2.4)
    replayed: bool = False


class SearchIndividualsResponse(BaseModel):
    """Paginated search results"""
    individuals: List[IndividualSummary]
    total: int
    offset: int
    limit: int
    # The default list's next page (`?cursor=`), or None on the last page (H2-6.10)
    next_cursor: Optional[str] = None


class IndividualDetailResponse(BaseModel):
    """Individual details with recent interactions"""
    individual: IndividualResponse
    recent_interactions: List[InteractionSummary]  # Last 10 interactions


class UrgencyOverrideResponse(BaseModel):
    """Response after updating urgency override"""
    urgency_score: int  # Original calculated score
    urgency_override: Optional[int]  # Manual override if set
    display_score: int  # What UI should show


class DeleteIndividualResponse(BaseModel):
    """Response after deleting an individual"""
    id: UUID
    deleted: bool = True


class InteractionsResponse(BaseModel):
    """List of detailed interactions"""
    interactions: List[InteractionDetail]


# Category Models
MAX_CATEGORY_NAME_LENGTH = 50
MAX_OPTION_LABEL_LENGTH = 50
MAX_OPTIONS = 50
SELECT_TYPES = ("single_select", "multi_select")
WEIGHTED_TYPES = ("number", "single_select")


class CreateCategoryRequest(BaseModel):
    """Request to create a new custom category.

    `name` is the worker's label ("HIV status"): stripped, 1-50 characters, and
    it must contain a letter or digit. The route stores `category_key(name)`
    ("hiv_status") as the category's `name` and the label as `display_name`.
    Select types need at least one option; single-select options are
    `{label, value}` with 0 <= value <= 1 (the fraction of the weight it adds),
    multi-select options are plain strings. Labels are stripped, non-blank,
    unique ignoring case, and can't contain commas (multi-select values are
    comma-separated).
    """
    name: str
    type: str = Field(..., pattern="^(text|number|single_select|multi_select|date|location)$")
    priority: str = Field("medium", pattern="^(high|medium|low)$")
    urgency_weight: int = Field(0, ge=0, le=100)
    auto_trigger: bool = False
    is_required: bool = False
    options: Optional[List[Any]] = None  # List[Dict] for single_select, List[str] for multi_select
    # The value that counts as the full weight (number only; None = 300) (H2-2.8)
    number_scale_max: Optional[float] = Field(None, gt=0, le=1_000_000)
    # Health or other sensitive information: never scored (H2-3.8). Also set by the
    # server when the key matches field_registry.SENSITIVE_KEY_PATTERN.
    is_sensitive: bool = False

    @field_validator('name')
    @classmethod
    def clean_name(cls, v):
        """Strip, keep the user's casing, bound the length, reject blank names."""
        v = " ".join(str(v).split())
        if not re.search(r"[A-Za-z0-9]", v):
            raise ValueError("Category name must contain a letter or digit")
        if len(v) > MAX_CATEGORY_NAME_LENGTH:
            raise ValueError(f"Category name must be at most {MAX_CATEGORY_NAME_LENGTH} characters")
        if category_key(v) == "_removed":
            raise ValueError("That name is reserved")  # the merge diff's list of dropped fields (H2-2.5)
        return v

    @model_validator(mode='after')
    def check_type_rules(self):
        """Options, weight and auto-trigger must fit the type."""
        if self.type in SELECT_TYPES:
            if not self.options:
                raise ValueError(f"options are required for type {self.type}")
            self.options = _clean_options(self.type, self.options)
        elif self.options is not None:
            raise ValueError(f"Options not allowed for type {self.type}")
        if self.type not in WEIGHTED_TYPES and self.urgency_weight > 0:
            raise ValueError(f"urgency_weight must be 0 for type {self.type}")
        if self.type not in WEIGHTED_TYPES and self.auto_trigger:
            raise ValueError(f"auto_trigger not allowed for type {self.type}")
        if self.number_scale_max is not None and self.type != "number":
            raise ValueError("number_scale_max is only allowed for number categories")
        return self


def _clean_options(field_type: str, options: List[Any]) -> List[Any]:
    """Validated, stripped options for a select type (raises ValueError)."""
    if len(options) > MAX_OPTIONS:
        raise ValueError(f"At most {MAX_OPTIONS} options are allowed")
    cleaned: List[Any] = []
    seen = set()
    for option in options:
        if field_type == "single_select":
            if not isinstance(option, dict) or "label" not in option or "value" not in option:
                raise ValueError("Single-select options must be list of objects with 'label' and 'value'")
            value = option["value"]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError("Single-select option values must be numbers")
            if not 0 <= value <= 1:
                raise ValueError("Single-select option values must be between 0 and 1")
            label = option["label"]
        else:
            if not isinstance(option, str):
                raise ValueError("Multi-select options must be list of strings")
            label = option
        if not isinstance(label, str) or not label.strip():
            raise ValueError("Option labels can't be blank")
        label = label.strip()
        if "," in label:
            raise ValueError("Option labels can't contain commas")
        if len(label) > MAX_OPTION_LABEL_LENGTH:
            raise ValueError(f"Option labels must be at most {MAX_OPTION_LABEL_LENGTH} characters")
        if label.lower() in seen:
            raise ValueError(f"Duplicate option '{label}'")
        seen.add(label.lower())
        cleaned.append({"label": label, "value": value} if field_type == "single_select" else label)
    return cleaned


class CategoryResponse(BaseModel):
    """Category data returned from API (`name` is the key, `display_name` the label)"""
    id: UUID
    name: str
    display_name: Optional[str] = None
    type: str
    is_required: bool
    is_preset: bool
    priority: str
    urgency_weight: int
    auto_trigger: bool
    options: Optional[List[Any]]
    number_scale_max: Optional[float] = None
    is_sensitive: bool = False
    created_at: datetime
    updated_at: datetime