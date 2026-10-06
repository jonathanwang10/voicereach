"""
Unit tests for duplicate detection service
Following TDD approach - tests written before implementation
"""
import pytest
import json
from unittest.mock import Mock, AsyncMock, patch, MagicMock
from datetime import datetime
import uuid

# Import the service (will be created after tests)
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def mock_supabase():
    """Mock Supabase client"""
    mock = MagicMock()
    return mock


@pytest.fixture
def mock_openai_service():
    """Mock OpenAI service"""
    mock = Mock()
    mock.compare_individuals = AsyncMock()
    return mock


@pytest.fixture
def sample_individual():
    """Sample individual data for testing"""
    return {
        "id": str(uuid.uuid4()),
        "name": "John Doe",
        "data": {
            "height": 72,
            "weight": 180,
            "skin_color": "Light",
            "age": 45,
            "medical_conditions": ["Diabetes"],
            "veteran_status": "No"
        },
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat()
    }


class TestDuplicateDetectionService:
    """Test duplicate detection service functionality"""

    @pytest.mark.asyncio
    async def test_exact_name_match_high_confidence(self, mock_supabase, mock_openai_service, sample_individual):
        """Test that exact name matches return high confidence (>=95%)"""
        # Import here to avoid import errors before implementation
        from services.duplicate_detection_service import DuplicateDetectionService

        # Arrange
        service = DuplicateDetectionService(mock_supabase, mock_openai_service)
        new_data = {
            "name": "John Doe",
            "height": 72,
            "weight": 180
        }

        # Mock chain for exact match query - returns sample_individual
        exact_mock_chain = MagicMock()
        exact_mock_chain.execute.return_value.data = [sample_individual]

        # Mock chain for fuzzy match query - returns empty
        fuzzy_mock_chain = MagicMock()
        fuzzy_mock_chain.execute.return_value.data = []

        # Mock chain for all individuals query - returns empty
        all_mock_chain = MagicMock()
        all_mock_chain.execute.return_value.data = []

        # Set up the mock to return the proper chain for each query type
        mock_supabase.table.return_value.select.return_value.ilike.return_value.limit.return_value = exact_mock_chain
        mock_supabase.table.return_value.select.return_value.limit.return_value = all_mock_chain

        # Mock OpenAI returns high confidence for exact match
        mock_openai_service.compare_individuals.return_value = {
            sample_individual["id"]: 96
        }

        # Act
        matches = await service.find_duplicates(new_data)

        # Assert
        assert len(matches) == 1
        assert matches[0]["id"] == sample_individual["id"]
        assert matches[0]["confidence"] >= 95
        assert matches[0]["name"] == "John Doe"

    @pytest.mark.asyncio
    async def test_fuzzy_name_match_medium_confidence(self, mock_supabase, mock_openai_service, sample_individual):
        """Test fuzzy matching for similar names returns medium confidence (70-90%)"""
        from services.duplicate_detection_service import DuplicateDetectionService

        # Arrange
        service = DuplicateDetectionService(mock_supabase, mock_openai_service)
        new_data = {
            "name": "Jon Smith",
            "height": 70,
            "weight": 175
        }

        # Modify sample for fuzzy match
        fuzzy_individual = sample_individual.copy()
        fuzzy_individual["name"] = "John Smith"

        # Setup mock chain for exact match (empty)
        exact_mock = MagicMock()
        exact_mock.data = []

        # Setup mock chain for fuzzy match (returns fuzzy_individual)
        fuzzy_mock = MagicMock()
        fuzzy_mock.data = [fuzzy_individual]

        # Setup mock chain for all individuals
        all_mock = MagicMock()
        all_mock.data = []

        # Configure mock to return different results for different calls
        table = mock_supabase.table.return_value.select.return_value
        # Exact match: ilike().limit(); fuzzy: ilike().order().limit() (most recent first)
        table.ilike.return_value.limit.return_value.execute.return_value = exact_mock
        table.ilike.return_value.order.return_value.limit.return_value.execute.return_value = fuzzy_mock
        table.order.return_value.limit.return_value.execute.return_value = all_mock

        # Mock OpenAI returns medium confidence for fuzzy match
        mock_openai_service.compare_individuals.return_value = {
            fuzzy_individual["id"]: 82
        }

        # Act
        matches = await service.find_duplicates(new_data)

        # Assert
        assert len(matches) == 1
        assert matches[0]["confidence"] >= 70
        assert matches[0]["confidence"] < 95

    @pytest.mark.asyncio
    async def test_no_duplicates_returns_empty(self, mock_supabase, mock_openai_service):
        """Test that unique individuals return empty matches"""
        from services.duplicate_detection_service import DuplicateDetectionService

        # Arrange
        service = DuplicateDetectionService(mock_supabase, mock_openai_service)
        new_data = {
            "name": "Unique Person",
            "height": 65,
            "weight": 150
        }

        # Mock database returns no matches for all queries
        empty_result = MagicMock()
        empty_result.data = []

        mock_supabase.table.return_value.select.return_value.ilike.return_value.limit.return_value.execute.return_value = empty_result
        mock_supabase.table.return_value.select.return_value.limit.return_value.execute.return_value = empty_result

        # Act
        matches = await service.find_duplicates(new_data)

        # Assert
        assert len(matches) == 0

    @pytest.mark.asyncio
    async def test_multiple_candidates_returns_highest_confidence(self, mock_supabase, mock_openai_service):
        """Test that when multiple candidates exist, only highest confidence is returned"""
        from services.duplicate_detection_service import DuplicateDetectionService

        # Arrange
        service = DuplicateDetectionService(mock_supabase, mock_openai_service)
        new_data = {
            "name": "John",
            "height": 72
        }

        id1, id2, id3 = (str(uuid.uuid4()) for _ in range(3))
        candidates = [
            {"id": id1, "name": "John Doe", "data": {}},
            {"id": id2, "name": "John Smith", "data": {}},
            {"id": id3, "name": "Johnny Brown", "data": {}}
        ]

        # Mock database returns multiple candidates
        result_mock = MagicMock()
        result_mock.data = candidates

        mock_supabase.table.return_value.select.return_value.ilike.return_value.limit.return_value.execute.return_value = result_mock
        mock_supabase.table.return_value.select.return_value.limit.return_value.execute.return_value.data = []

        # Mock OpenAI returns different confidences
        mock_openai_service.compare_individuals.return_value = {
            id1: 95,
            id2: 75,
            id3: 65
        }

        # Act
        matches = await service.find_duplicates(new_data)

        # Assert - per PRD 4.8: only top match for MVP
        assert len(matches) == 1
        assert matches[0]["id"] == id1
        assert matches[0]["confidence"] == 95

    @pytest.mark.asyncio
    async def test_low_confidence_matches_filtered(self, mock_supabase, mock_openai_service):
        """Test that matches below 60% confidence are filtered out"""
        from services.duplicate_detection_service import DuplicateDetectionService

        # Arrange
        service = DuplicateDetectionService(mock_supabase, mock_openai_service)
        new_data = {
            "name": "John",
            "height": 60
        }

        candidates = [
            {"id": "id1", "name": "Sarah", "data": {}},
            {"id": "id2", "name": "Mike", "data": {}}
        ]

        # Mock database returns candidates
        result_mock = MagicMock()
        result_mock.data = candidates

        mock_supabase.table.return_value.select.return_value.ilike.return_value.limit.return_value.execute.return_value = result_mock

        # Mock OpenAI returns low confidence
        mock_openai_service.compare_individuals.return_value = {
            "id1": 45,
            "id2": 30
        }

        # Act
        matches = await service.find_duplicates(new_data)

        # Assert
        assert len(matches) == 0  # All below 60% threshold

    @pytest.mark.asyncio
    async def test_handles_missing_name(self, mock_supabase, mock_openai_service):
        """Test that missing or empty name returns empty matches"""
        from services.duplicate_detection_service import DuplicateDetectionService

        # Arrange
        service = DuplicateDetectionService(mock_supabase, mock_openai_service)
        test_cases = [
            {},  # No name field
            {"name": ""},  # Empty name
            {"name": "  "},  # Whitespace only
            {"Name": "a"}  # Too short (less than 2 chars)
        ]

        # Act & Assert
        for new_data in test_cases:
            matches = await service.find_duplicates(new_data)
            assert len(matches) == 0

    @pytest.mark.asyncio
    async def test_case_insensitive_name_matching(self, mock_supabase, mock_openai_service, sample_individual):
        """Test that name matching is case-insensitive"""
        from services.duplicate_detection_service import DuplicateDetectionService

        # Arrange
        service = DuplicateDetectionService(mock_supabase, mock_openai_service)
        test_cases = ["JOHN DOE", "john doe", "John Doe", "JoHn DoE"]

        for name_variant in test_cases:
            new_data = {"name": name_variant, "height": 72}

            # Mock database returns match
            result_mock = MagicMock()
            result_mock.data = [sample_individual]

            mock_supabase.table.return_value.select.return_value.ilike.return_value.limit.return_value.execute.return_value = result_mock
            mock_supabase.table.return_value.select.return_value.limit.return_value.execute.return_value.data = []

            # Mock OpenAI returns high confidence
            mock_openai_service.compare_individuals.return_value = {
                sample_individual["id"]: 95
            }

            # Act
            matches = await service.find_duplicates(new_data)

            # Assert
            assert len(matches) == 1
            assert matches[0]["id"] == sample_individual["id"]

    @pytest.mark.asyncio
    async def test_handles_both_name_fields(self, mock_supabase, mock_openai_service, sample_individual):
        """Test that both 'name' and 'Name' fields are handled"""
        from services.duplicate_detection_service import DuplicateDetectionService

        # Arrange
        service = DuplicateDetectionService(mock_supabase, mock_openai_service)

        # Test with lowercase 'name'
        new_data_lower = {"name": "John Doe", "height": 72}
        # Test with uppercase 'Name'
        new_data_upper = {"Name": "John Doe", "height": 72}

        for new_data in [new_data_lower, new_data_upper]:
            # Mock database returns match
            result_mock = MagicMock()
            result_mock.data = [sample_individual]

            mock_supabase.table.return_value.select.return_value.ilike.return_value.limit.return_value.execute.return_value = result_mock
            mock_supabase.table.return_value.select.return_value.limit.return_value.execute.return_value.data = []

            # Mock OpenAI returns high confidence
            mock_openai_service.compare_individuals.return_value = {
                sample_individual["id"]: 95
            }

            # Act
            matches = await service.find_duplicates(new_data)

            # Assert
            assert len(matches) == 1
            assert matches[0]["id"] == sample_individual["id"]