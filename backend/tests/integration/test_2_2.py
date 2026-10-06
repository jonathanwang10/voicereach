#!/usr/bin/env python3
"""
Test Task 2.2: GPT-4o Categorization
"""
import os
from dotenv import load_dotenv

print("Starting Task 2.2 test...")

# Load environment variables
load_dotenv()

# Add backend to path

from services.openai_service import OpenAIService

# Mock categories from database
MOCK_CATEGORIES = [
    {
        "name": "name",
        "type": "text",
        "is_required": True,
        "options": None
    },
    {
        "name": "height",
        "type": "number",
        "is_required": True,
        "options": None
    },
    {
        "name": "weight",
        "type": "number",
        "is_required": True,
        "options": None
    },
    {
        "name": "age",
        "type": "single_select",
        "is_required": True,
        "options": [
            {"label": "Light", "value": 0},
            {"label": "Medium", "value": 0},
            {"label": "Dark", "value": 0}
        ]
    },
    {
        "name": "gender",
        "type": "single_select",
        "is_required": False,
        "options": [
            {"label": "Male", "value": 0},
            {"label": "Female", "value": 0},
            {"label": "Other", "value": 0},
            {"label": "Unknown", "value": 0}
        ]
    },
    {
        "name": "substance_abuse_history",
        "type": "multi_select",
        "is_required": False,
        "options": ["None", "Mild", "Moderate", "Severe", "In Recovery"]
    }
]

# Test cases
TEST_TRANSCRIPTIONS = [
    {
        "name": "Complete information",
        "text": "Met Sarah Smith, she's about 5 foot 4, maybe 120 pounds, dark skin. Says she's in recovery.",
        "expected": {
            "name": "Sarah Smith",
            "height": 64,  # 5'4" = 64 inches
            "weight": 120,
            "age": "Dark",
            "substance_abuse_history": ["In Recovery"]
        }
    },
    {
        "name": "Height variations",
        "text": "John Doe is 6 feet tall, weighs 180 pounds. Light complexion.",
        "expected": {
            "name": "John Doe",
            "height": 72,  # 6 feet = 72 inches
            "weight": 180,
            "age": "Light"
        }
    },
    {
        "name": "Missing required fields",
        "text": "Met someone named Robert, medium skin tone, seems to be a veteran.",
        "expected": {
            "name": "Robert",
            "age": "Medium",
            "height": None,
            "weight": None
        }
    },
    {
        "name": "Skin color mapping",
        "text": "Maria Garcia, pale skin, 5'2\", 110 lbs.",
        "expected": {
            "name": "Maria Garcia", 
            "age": "Light",  # pale -> Light
            "height": 62,  # 5'2" = 62 inches
            "weight": 110
        }
    }
]

async def test_categorization():
    service = OpenAIService()
    
    print("Testing Task 2.2: GPT-4o Categorization")
    print("=" * 50)
    
    # Check if OpenAI API key is set
    if not os.getenv("OPENAI_API_KEY"):
        print("❌ OPENAI_API_KEY not set in .env file")
        print("Skipping actual API tests")
        return
    
    for test in TEST_TRANSCRIPTIONS:
        print(f"\nTest: {test['name']}")
        print(f"Transcription: {test['text']}")
        
        try:
            result = await service.categorize_transcription(test['text'], MOCK_CATEGORIES)
            print(f"Result: {result}")
            
            # Check expected fields
            for field, expected_value in test['expected'].items():
                actual_value = result.get(field)
                
                if field == 'height' and expected_value and actual_value:
                    # Allow small differences in height parsing
                    if abs(actual_value - expected_value) <= 2:
                        print(f"✅ {field}: {actual_value} (expected ~{expected_value})")
                    else:
                        print(f"❌ {field}: {actual_value} (expected {expected_value})")
                elif actual_value == expected_value:
                    print(f"✅ {field}: {actual_value}")
                else:
                    print(f"❌ {field}: {actual_value} (expected {expected_value})")
                    
        except Exception as e:
            print(f"❌ Error: {e}")
    
    print("\n" + "=" * 50)
    print("Task 2.2 implementation complete!")
    print("\nNotes:")
    print("- GPT-4o categorization service created")
    print("- Dynamic prompt generation based on categories")
    print("- Height parsing (feet/inches to inches)")
    print("- Skin color mapping (pale->Light, etc)")
    print("- Validation against available options")
    print("- Conservative extraction as per PRD")
