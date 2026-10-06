"""
Database models and Pydantic schemas for individual management
"""
from pydantic import BaseModel, Field, field_validator
from typing import Optional, Dict, Any, List
from datetime import datetime
from uuid import UUID


# Request Models
class LocationData(BaseModel):
    """Location data from frontend with geocoded address"""
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    address: str  # Full address from frontend geocoding


class SaveIndividualRequest(BaseModel):
    """Request to save a new individual or update existing (merge)"""
    data: Dict[str, Any]  # Categorized data from AI or manual entry
    merge_with_id: Optional[UUID] = None  # If merging, ID of existing individual
    location: Optional[LocationData] = None
    transcription: Optional[str] = None  # Original audio transcription if voice entry
    audio_url: Optional[str] = None  # Reference to audio file
    
    @field_validator('data')
    def validate_required_fields(cls, v):
        """Ensure required fields exist per PRD"""
        required = ['name', 'height', 'weight']
        missing = [f for f in required if f not in v or v[f] is None]
        if missing:
            raise ValueError(f"Missing required fields: {missing}")
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


class InteractionSummary(BaseModel):
    """Brief interaction info for lists"""
    id: UUID
    created_at: datetime
    user_name: str
    location: Optional[Dict[str, Any]]
    has_transcription: bool


class InteractionDetail(BaseModel):
    """Full interaction details with changes"""
    id: UUID
    created_at: datetime
    user_name: str
    transcription: Optional[str]
    location: Optional[Dict[str, Any]]  # Full location with complete address
    changes: Dict[str, Any]  # Only fields that changed in this interaction


class SaveIndividualResponse(BaseModel):
    """Response after saving individual"""
    individual: IndividualResponse
    interaction: InteractionSummary


class SearchIndividualsResponse(BaseModel):
    """Paginated search results"""
    individuals: List[IndividualSummary]
    total: int
    offset: int
    limit: int


class IndividualDetailResponse(BaseModel):
    """Individual details with recent interactions"""
    individual: IndividualResponse
    recent_interactions: List[InteractionSummary]  # Last 10 interactions


class UrgencyOverrideResponse(BaseModel):
    """Response after updating urgency override"""
    urgency_score: int  # Original calculated score
    urgency_override: Optional[int]  # Manual override if set
    display_score: int  # What UI should show


class InteractionsResponse(BaseModel):
    """List of detailed interactions"""
    interactions: List[InteractionDetail]


# Category Models
class CreateCategoryRequest(BaseModel):
    """Request to create a new custom category"""
    name: str  # Required, will be capitalized
    type: str = Field(..., pattern="^(text|number|single_select|multi_select|date|location)$")
    priority: str = Field("medium", pattern="^(high|medium|low)$")
    urgency_weight: int = Field(0, ge=0, le=100)
    auto_trigger: bool = False
    is_required: bool = False
    options: Optional[List[Any]] = None  # List[Dict] for single_select, List[str] for multi_select
    
    @field_validator('name')
    def capitalize_name(cls, v):
        """Capitalize first letter, lowercase rest"""
        return v.strip().capitalize() if v else v
    
    @field_validator('options')
    def validate_options_format(cls, v, values):
        """Validate options format based on type"""
        if 'type' in values.data:
            field_type = values.data['type']
            if field_type == 'single_select' and v is not None:
                # Must be list of dicts with label and value
                if not isinstance(v, list) or not all(
                    isinstance(opt, dict) and 'label' in opt and 'value' in opt 
                    for opt in v
                ):
                    raise ValueError("Single-select options must be list of objects with 'label' and 'value'")
                if not all(isinstance(opt['value'], (int, float)) and not isinstance(opt['value'], bool) for opt in v):
                    raise ValueError("Single-select option values must be numbers")
            elif field_type == 'multi_select' and v is not None:
                # Must be list of strings
                if not isinstance(v, list) or not all(isinstance(opt, str) for opt in v):
                    raise ValueError("Multi-select options must be list of strings")
            elif field_type not in ['single_select', 'multi_select'] and v is not None:
                raise ValueError(f"Options not allowed for type {field_type}")
        return v
    
    def model_post_init(self, __context):
        """Additional validation after model creation"""
        # Validate urgency_weight only for number/single_select
        if self.type not in ['number', 'single_select'] and self.urgency_weight > 0:
            raise ValueError(f"urgency_weight must be 0 for type {self.type}")
        
        # Validate auto_trigger only for number/single_select
        if self.type not in ['number', 'single_select'] and self.auto_trigger:
            raise ValueError(f"auto_trigger not allowed for type {self.type}")


class CategoryResponse(BaseModel):
    """Category data returned from API"""
    id: UUID
    name: str
    type: str
    is_required: bool
    is_preset: bool
    priority: str
    urgency_weight: int
    auto_trigger: bool
    options: Optional[List[Any]]
    created_at: datetime
    updated_at: datetime