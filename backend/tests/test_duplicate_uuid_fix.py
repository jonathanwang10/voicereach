"""
Unit tests specifically for UUID mapping fix in duplicate detection service
Tests that placeholder keys from GPT-4o are correctly mapped to actual UUIDs
"""
import pytest
from unittest.mock import Mock, AsyncMock, MagicMock
import uuid
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestUUIDMappingFix:
    """Test UUID mapping fix for duplicate detection"""

    @pytest.mark.asyncio
    async def test_handles_placeholder_keys_from_llm(self):
        """Test that service correctly maps placeholder keys from GPT-4o to actual UUIDs"""
        from services.duplicate_detection_service import DuplicateDetectionService

        # Setup mocks
        mock_supabase = MagicMock()
        mock_openai_service = Mock()
        mock_openai_service.compare_individuals = AsyncMock()

        # Arrange
        service = DuplicateDetectionService(mock_supabase, mock_openai_service)

        # Create test individuals with valid UUIDs
        candidate1_id = str(uuid.uuid4())
        candidate2_id = str(uuid.uuid4())

        candidates = [
            {"id": candidate1_id, "name": "John Doe", "data": {"height": 72}},
            {"id": candidate2_id, "name": "John Smith", "data": {"height": 70}}
        ]

        new_data = {"name": "John", "height": 72}

        # Mock database returns candidates
        result_mock = MagicMock()
        result_mock.data = candidates

        mock_supabase.table.return_value.select.return_value.ilike.return_value.limit.return_value.execute.return_value = result_mock
        mock_supabase.table.return_value.select.return_value.limit.return_value.execute.return_value.data = []

        # Mock OpenAI returns placeholder keys instead of actual UUIDs
        # This simulates the problem where GPT-4o returns "candidate_id_1" instead of the actual UUID
        mock_openai_service.compare_individuals.return_value = {
            "candidate_1": 95,
            "candidate_2": 70,
            "candidate_3": 45  # This should be ignored as we only have 2 candidates
        }

        # Act
        matches = await service.find_duplicates(new_data)

        # Assert - should correctly map placeholder to actual UUID
        assert len(matches) == 1  # Only top match returned per PRD
        assert matches[0]["id"] == candidate1_id  # Should map to first candidate
        assert matches[0]["confidence"] == 95
        assert matches[0]["name"] == "John Doe"

    @pytest.mark.asyncio
    async def test_handles_candidate_id_placeholder_format(self):
        """Test handling of 'candidate_id_X' format from GPT-4o"""
        from services.duplicate_detection_service import DuplicateDetectionService

        # Setup mocks
        mock_supabase = MagicMock()
        mock_openai_service = Mock()
        mock_openai_service.compare_individuals = AsyncMock()

        service = DuplicateDetectionService(mock_supabase, mock_openai_service)

        # Create test individual with valid UUID
        valid_id = str(uuid.uuid4())
        candidates = [{"id": valid_id, "name": "John Doe", "data": {"height": 72}}]

        new_data = {"name": "John", "height": 72}

        # Mock database returns candidate
        result_mock = MagicMock()
        result_mock.data = candidates

        mock_supabase.table.return_value.select.return_value.ilike.return_value.limit.return_value.execute.return_value = result_mock
        mock_supabase.table.return_value.select.return_value.limit.return_value.execute.return_value.data = []

        # Mock OpenAI returns "candidate_id_1" format (the problematic format)
        mock_openai_service.compare_individuals.return_value = {
            "candidate_id_1": 96  # This is what causes the 22P02 error
        }

        # Act
        matches = await service.find_duplicates(new_data)

        # Assert - should map placeholder to actual UUID
        assert len(matches) == 1
        assert matches[0]["id"] == valid_id  # Should be the actual UUID, not "candidate_id_1"
        assert matches[0]["confidence"] == 96

    @pytest.mark.asyncio
    async def test_validates_uuids_before_returning(self):
        """Test that service only returns valid UUIDs and filters invalid ones"""
        from services.duplicate_detection_service import DuplicateDetectionService

        # Setup mocks
        mock_supabase = MagicMock()
        mock_openai_service = Mock()
        mock_openai_service.compare_individuals = AsyncMock()

        service = DuplicateDetectionService(mock_supabase, mock_openai_service)

        # Mix of valid and invalid IDs (simulating corrupted data)
        valid_uuid = str(uuid.uuid4())
        candidates = [
            {"id": valid_uuid, "name": "John Doe", "data": {}},
            {"id": "invalid-uuid", "name": "Invalid ID", "data": {}},
            {"id": "candidate_1", "name": "Placeholder ID", "data": {}}
        ]

        new_data = {"name": "John", "height": 72}

        # Mock database returns mixed candidates
        result_mock = MagicMock()
        result_mock.data = candidates

        mock_supabase.table.return_value.select.return_value.ilike.return_value.limit.return_value.execute.return_value = result_mock
        mock_supabase.table.return_value.select.return_value.limit.return_value.execute.return_value.data = []

        # Mock OpenAI returns confidence for all (including invalid)
        mock_openai_service.compare_individuals.return_value = {
            valid_uuid: 95,
            "invalid-uuid": 90,  # This would cause 22P02 error if passed to DB
            "candidate_1": 85     # This would also cause 22P02 error
        }

        # Act
        matches = await service.find_duplicates(new_data)

        # Assert - should only return the valid UUID
        assert len(matches) == 1
        assert matches[0]["id"] == valid_uuid
        assert matches[0]["confidence"] == 95
        # Invalid IDs should be filtered out

    @pytest.mark.asyncio
    async def test_handles_actual_uuids_from_llm(self):
        """Test that service still works when GPT-4o returns actual UUIDs (ideal case)"""
        from services.duplicate_detection_service import DuplicateDetectionService

        # Setup mocks
        mock_supabase = MagicMock()
        mock_openai_service = Mock()
        mock_openai_service.compare_individuals = AsyncMock()

        service = DuplicateDetectionService(mock_supabase, mock_openai_service)

        # Create test individuals with valid UUIDs
        candidate1_id = str(uuid.uuid4())
        candidate2_id = str(uuid.uuid4())

        candidates = [
            {"id": candidate1_id, "name": "John Doe", "data": {}},
            {"id": candidate2_id, "name": "John Smith", "data": {}}
        ]

        new_data = {"name": "John", "height": 72}

        # Mock database returns candidates
        result_mock = MagicMock()
        result_mock.data = candidates

        mock_supabase.table.return_value.select.return_value.ilike.return_value.limit.return_value.execute.return_value = result_mock
        mock_supabase.table.return_value.select.return_value.limit.return_value.execute.return_value.data = []

        # Mock OpenAI correctly returns actual UUIDs (ideal behavior)
        mock_openai_service.compare_individuals.return_value = {
            candidate1_id: 98,
            candidate2_id: 75
        }

        # Act
        matches = await service.find_duplicates(new_data)

        # Assert - should work normally with actual UUIDs
        assert len(matches) == 1
        assert matches[0]["id"] == candidate1_id
        assert matches[0]["confidence"] == 98

    @pytest.mark.asyncio
    async def test_fallback_validates_uuids(self):
        """Test that fallback simple matching also validates UUIDs"""
        from services.duplicate_detection_service import DuplicateDetectionService

        # Setup mocks
        mock_supabase = MagicMock()
        mock_openai_service = Mock()

        # Make OpenAI service fail to trigger fallback
        mock_openai_service.compare_individuals = AsyncMock(side_effect=Exception("API Error"))

        service = DuplicateDetectionService(mock_supabase, mock_openai_service)

        # Use invalid ID to test validation
        candidates = [{"id": "not-a-uuid", "name": "John Doe", "data": {}}]
        new_data = {"name": "John Doe", "height": 72}

        # Mock database returns candidate with invalid ID
        result_mock = MagicMock()
        result_mock.data = candidates

        mock_supabase.table.return_value.select.return_value.ilike.return_value.limit.return_value.execute.return_value = result_mock
        mock_supabase.table.return_value.select.return_value.limit.return_value.execute.return_value.data = []

        # Act
        matches = await service.find_duplicates(new_data)

        # Assert - fallback should not return invalid UUID
        assert len(matches) == 0  # Invalid UUID should be filtered out