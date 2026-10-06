"""
Category management endpoints
Minimal implementation for Task 2.0 prerequisite
"""
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from typing import List, Dict, Any
import os
import csv
import io
from supabase import create_client, Client
from api.auth import get_current_user
from db.models import CreateCategoryRequest, CategoryResponse
from datetime import datetime, timezone
from uuid import uuid4

router = APIRouter()

@router.get("/api/export")
async def export_csv(user_id: str = Depends(get_current_user)):
    """
    Export all individuals data as CSV file.
    Returns CSV with columns: name, height, weight, urgency_score, last_seen
    Multi-select values are comma-separated.
    """
    try:
        # Initialize Supabase client
        supabase: Client = create_client(
            os.getenv("SUPABASE_URL"),
            os.getenv("SUPABASE_SERVICE_KEY")
        )
        
        # Get all individuals with their data
        response = supabase.table("individuals").select("*").order("created_at", desc=True).execute()
        
        if not response.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No individuals found to export"
            )
        
        # Create CSV content
        output = io.StringIO()
        writer = csv.writer(output)
        
        # Write header
        writer.writerow([
            'Name', 'Height', 'Weight', 'Urgency Score', 'Last Seen',
            'Age', 'Gender', 'Substance Abuse History', 'Medical Conditions',
            'Veteran Status', 'Housing Priority', 'Behavior'
        ])
        
        # Write data rows
        for individual in response.data:
            data = individual.get("data", {})
            
            # Format multi-select values as comma-separated
            substance_abuse = data.get("substance_abuse_history", "")
            if isinstance(substance_abuse, list):
                substance_abuse = ", ".join(substance_abuse)
            
            medical_conditions = data.get("medical_conditions", "")
            if isinstance(medical_conditions, list):
                medical_conditions = ", ".join(medical_conditions)
            
            # Calculate display urgency score (override or calculated)
            override = individual.get("urgency_override")
            urgency_score = override if override is not None else individual.get("urgency_score", 0)
            
            writer.writerow([
                individual.get("name", ""),
                data.get("height", ""),
                data.get("weight", ""),
                urgency_score,
                individual.get("updated_at", ""),
                data.get("age", ""),
                data.get("gender", ""),
                substance_abuse,
                medical_conditions,
                data.get("veteran_status", ""),
                data.get("housing_priority", ""),
                data.get("behavior", "")
            ])
        
        # Prepare response
        output.seek(0)
        csv_content = output.getvalue()
        
        # Create streaming response
        return StreamingResponse(
            io.BytesIO(csv_content.encode('utf-8')),
            media_type="text/csv",
            headers={
                "Content-Disposition": f"attachment; filename=individuals_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to export CSV: {str(e)}"
        )


@router.get("/api/categories", response_model=Dict[str, List[Dict[str, Any]]])
async def get_categories(user_id: str = Depends(get_current_user)):
    """
    Get all categories (preset and custom) for dynamic prompt generation.
    Returns categories with their configuration for use in GPT-4o categorization.
    """
    try:
        # Initialize Supabase client inside function to ensure env vars are loaded
        supabase: Client = create_client(
            os.getenv("SUPABASE_URL"),
            os.getenv("SUPABASE_SERVICE_KEY")  # Use service key for full access
        )
        
        # Fetch all categories from database
        response = supabase.table("categories").select("*").order("created_at").execute()
        
        # Format response
        categories = []
        for category in response.data:
            # Parse options if they exist (for select types)
            cat_data = {
                "id": category["id"],
                "name": category["name"],
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
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch categories: {str(e)}")


@router.post("/api/categories", response_model=CategoryResponse, status_code=status.HTTP_201_CREATED)
async def create_category(
    request: CreateCategoryRequest,
    user_id: str = Depends(get_current_user)
):
    """
    Create a new custom category with validation.
    
    Validation rules:
    - Only number and single_select types can have urgency_weight > 0
    - Only number and single_select types can have auto_trigger = true
    - Category names must be unique (case insensitive)
    - Single-select options must be list of {label, value} objects
    - Multi-select options must be list of strings
    """
    try:
        # Initialize Supabase client
        supabase: Client = create_client(
            os.getenv("SUPABASE_URL"),
            os.getenv("SUPABASE_SERVICE_KEY")
        )
        
        # Check for duplicate name (case insensitive)
        existing = supabase.table("categories").select("name").ilike("name", request.name).execute()
        if existing.data:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Category with name '{request.name}' already exists"
            )
        
        # Prepare category data
        now = datetime.now(timezone.utc).isoformat()
        category_data = {
            "id": str(uuid4()),
            "name": request.name,  # Already capitalized by validator
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
        
        # Insert into database
        result = supabase.table("categories").insert(category_data).execute()
        
        if not result.data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create category"
            )
        
        # Return created category
        created = result.data[0]
        return CategoryResponse(
            id=created["id"],
            name=created["name"],
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
    except ValueError as e:
        # Pydantic validation errors
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "success": False,
                "errors": {
                    "validation": [str(e)],
                    "missing_required": []
                }
            }
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create category: {str(e)}"
        )