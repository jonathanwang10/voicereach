"""
Unit tests for individual service (Task 2.15.2)
Tests service layer business logic
"""
import pytest
from uuid import uuid4
from datetime import datetime
from unittest.mock import Mock
from services.individual_service import IndividualService
from db.models import LocationData, SaveIndividualResponse


class TestIndividualService:
    """Test individual service methods"""
    
    @pytest.fixture
    def mock_supabase(self):
        """Create mock Supabase client"""
        return Mock()
    
    @pytest.fixture
    def service(self, mock_supabase):
        """Create service instance with mock"""
        return IndividualService(mock_supabase)
    
    def test_get_changed_fields(self, service):
        """Test change detection logic"""
        old_data = {
            "name": "John Doe",
            "height": 72,
            "weight": 180,
            "age": "Light"
        }
        
        new_data = {
            "name": "John Doe",  # Same
            "height": 73,        # Changed
            "weight": 180,       # Same
            "age": "Medium",  # Changed
            "gender": "Male"     # New field
        }
        
        changes = service.get_changed_fields(old_data, new_data)
        assert changes == {
            "height": 73,
            "age": "Medium",
            "gender": "Male"
        }
        assert "name" not in changes  # Unchanged
        assert "weight" not in changes  # Unchanged
    
    def test_get_changed_fields_empty(self, service):
        """Test when no changes"""
        data = {"name": "Test", "height": 70}
        changes = service.get_changed_fields(data, data)
        assert changes == {}
    
    def test_abbreviate_address_cross_street(self, service):
        """Test address abbreviation with cross-street format"""
        addr = "Market Street & 5th Street, San Francisco, CA"
        result = service.abbreviate_address(addr)
        assert result == "Market & 5th"
    
    def test_abbreviate_address_regular_street(self, service):
        """Test address abbreviation with regular street"""
        addr = "123 Golden Gate Avenue, San Francisco, CA 94102"
        result = service.abbreviate_address(addr)
        assert result == "Golden Gate Avenue"
    
    def test_abbreviate_address_landmark(self, service):
        """Test address abbreviation with landmark"""
        addr = "Golden Gate Park, San Francisco"
        result = service.abbreviate_address(addr)
        assert result == "Golden Gate Park"
    
    def test_abbreviate_address_long(self, service):
        """Test address abbreviation with long address"""
        addr = "This is a very long address that exceeds the thirty character limit and should be truncated"
        result = service.abbreviate_address(addr)
        assert result.endswith("...")
        assert len(result) <= 33  # 30 chars + "..."
    
    def test_abbreviate_address_empty(self, service):
        """Test address abbreviation with empty string"""
        assert service.abbreviate_address("") == ""
        assert service.abbreviate_address(None) == ""
    
    @pytest.mark.asyncio
    async def test_save_new_individual(self, service, mock_supabase):
        """Test creating new individual with transaction"""
        # Mock categories response
        categories_mock = Mock()
        categories_mock.data = [
            {"name": "height", "type": "number", "urgency_weight": 10},
            {"name": "weight", "type": "number", "urgency_weight": 5}
        ]
        
        # Mock individual insert
        individual_id = str(uuid4())
        individual_mock = Mock()
        individual_mock.data = [{
            "id": individual_id,
            "name": "Jane Smith",
            "urgency_score": 25,
            "urgency_override": None,
            "data": {
                "name": "Jane Smith",
                "height": 65,
                "weight": 140,
                "age": "Dark"
            },
            "created_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat()
        }]
        
        # Mock interaction insert
        interaction_id = str(uuid4())
        interaction_mock = Mock()
        interaction_mock.data = [{
            "id": interaction_id,
            "individual_id": individual_id,
            "user_id": "test-user",
            "user_name": "Demo User",
            "created_at": datetime.utcnow().isoformat(),
            "location": {"latitude": 37.80808794862037, "longitude": -122.43016054168524, "address": "123 Market St"},
            "changes": {
                "name": "Jane Smith",
                "height": 65,
                "weight": 140,
                "age": "Dark"
            },
            "transcription": None
        }]
        
        # Set up mock chain
        table_mock = Mock()
        mock_supabase.table.return_value = table_mock
        
        # Categories call
        select_mock = Mock()
        table_mock.select.return_value = select_mock
        select_mock.execute.return_value = categories_mock
        
        # Individual insert call
        insert_mock = Mock()
        table_mock.insert.return_value = insert_mock
        insert_mock.execute.side_effect = [individual_mock, interaction_mock]
        
        # Test save
        result = await service.save_individual(
            user_id="test-user",
            user_name="Demo User",
            data={
                "name": "Jane Smith",
                "height": 65,
                "weight": 140,
                "age": "Dark"
            },
            location=LocationData(
                latitude=37.7749,
                longitude=-122.4194,
                address="123 Market Street, SF"
            )
        )
        
        # Verify result
        assert isinstance(result, SaveIndividualResponse)
        assert result.individual.name == "Jane Smith"
        assert result.individual.urgency_score >= 0
        assert result.interaction.has_transcription is False
        
        # Verify Supabase calls
        assert mock_supabase.table.call_count >= 3  # categories, individual, interaction
    
    @pytest.mark.asyncio
    async def test_save_with_merge(self, service, mock_supabase):
        """Test merging individuals"""
        merge_id = str(uuid4())
        
        # Mock categories
        mock_supabase.table.return_value.select.return_value.execute.return_value.data = []
        
        # Mock existing individual
        mock_supabase.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data = {
            "id": merge_id,
            "name": "John Doe",
            "data": {
                "name": "John Doe",
                "height": 72,
                "weight": 180,
                "age": "Light"
            }
        }
        
        # Mock update
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value.data = [{
            "id": merge_id,
            "name": "John Doe",
            "urgency_score": 0,
            "urgency_override": None,
            "data": {
                "name": "John Doe",
                "height": 73,
                "weight": 185,
                "age": "Light",
                "veteran_status": "Yes"
            },
            "created_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat()
        }]
        
        # Mock interaction with changes only
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [{
            "id": str(uuid4()),
            "individual_id": merge_id,
            "changes": {
                "height": 73,
                "weight": 185,
                "veteran_status": "Yes"
            },
            "user_name": "Demo User",
            "created_at": datetime.utcnow().isoformat()
        }]
        
        # Test merge
        result = await service.save_individual(
            user_id="test-user",
            user_name="Demo User",
            data={
                "name": "John Doe",
                "height": 73,  # Changed
                "weight": 185,  # Changed
                "age": "Light",  # Same
                "veteran_status": "Yes"  # New
            },
            merge_with_id=merge_id
        )
        
        # Verify same individual ID
        assert str(result.individual.id) == merge_id
    
    @pytest.mark.asyncio
    async def test_save_merge_not_found(self, service, mock_supabase):
        """Test merge with non-existent ID"""
        # Mock categories
        mock_supabase.table.return_value.select.return_value.execute.return_value.data = []
        
        # Mock individual not found
        mock_supabase.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data = None
        
        # Test merge should fail
        with pytest.raises(ValueError) as exc:
            await service.save_individual(
                user_id="test-user",
                user_name="Demo User",
                data={"name": "Test", "height": 70, "weight": 160, "age": "Light"},
                merge_with_id=uuid4()
            )
        assert "Individual not found" in str(exc.value)
    
    @pytest.mark.asyncio
    async def test_search_individuals_with_term(self, service, mock_supabase):
        """Test search functionality with search term"""
        # Mock search results
        mock_supabase.table.return_value.select.return_value.ilike.return_value.execute.return_value.data = [
            {
                "id": str(uuid4()),
                "name": "John Smith",
                            "urgency_score": 50,
            "urgency_override": None,
                "created_at": datetime.utcnow().isoformat()
            }
        ]
        
        # Service also scans all individuals for JSONB matches
        mock_supabase.table.return_value.select.return_value.execute.return_value.data = []

        # Mock last interaction
        mock_supabase.table.return_value.select.return_value.eq.return_value.order.return_value.limit.return_value.execute.return_value.data = [{
            "created_at": datetime.utcnow().isoformat(),
            "location": {"latitude": 37.80808794862037, "longitude": -122.43016054168524, "address": "123 Market Street"}
        }]
        
        # Test search
        results = await service.search_individuals(search="John", limit=10)
        
        assert len(results.individuals) > 0
        assert "John" in results.individuals[0].name
        # Address should be abbreviated
        assert len(results.individuals[0].last_location["address"]) < 50
    
    @pytest.mark.asyncio
    async def test_search_individuals_pagination(self, service, mock_supabase):
        """Test search pagination"""
        # Create 25 mock individuals
        mock_data = [
            {
                "id": str(uuid4()),
                "name": f"Person {i}",
                "urgency_score": i * 10,
                "urgency_override": None,
                "created_at": datetime.utcnow().isoformat()
            }
            for i in range(25)
        ]
        
        mock_supabase.table.return_value.select.return_value.execute.return_value.data = mock_data
        
        # Mock interactions (empty for simplicity)
        mock_supabase.table.return_value.select.return_value.eq.return_value.order.return_value.limit.return_value.execute.return_value.data = []
        
        # Test pagination
        results = await service.search_individuals(limit=10, offset=10)
        
        assert results.total == 25
        assert results.limit == 10
        assert results.offset == 10
        assert len(results.individuals) == 10
    
    @pytest.mark.asyncio
    async def test_get_individual_by_id(self, service, mock_supabase):
        """Test getting individual details"""
        individual_id = uuid4()
        
        # Mock individual
        mock_supabase.table.return_value.select.return_value.eq.return_value.maybe_single.return_value.execute.return_value.data = {
            "id": str(individual_id),
            "name": "Test Person",
            "urgency_score": 60,
            "urgency_override": 75,
            "data": {"name": "Test Person", "height": 70, "weight": 160, "age": "Light"},
            "created_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat()
        }
        
        # Mock interactions
        mock_supabase.table.return_value.select.return_value.eq.return_value.order.return_value.limit.return_value.execute.return_value.data = [
            {
                "id": str(uuid4()),
                "created_at": datetime.utcnow().isoformat(),
                "user_name": "Demo User",
                "location": None,
                "transcription": "Test transcription"
            }
        ]
        
        # Test get
        result = await service.get_individual_by_id(individual_id)
        
        assert result is not None
        assert result.individual.name == "Test Person"
        assert result.individual.display_score == 75  # Override value
        assert len(result.recent_interactions) == 1
        assert result.recent_interactions[0].has_transcription is True
    
    @pytest.mark.asyncio
    async def test_get_individual_not_found(self, service, mock_supabase):
        """Test getting non-existent individual"""
        # Mock not found
        mock_supabase.table.return_value.select.return_value.eq.return_value.maybe_single.return_value.execute.return_value.data = None
        
        result = await service.get_individual_by_id(uuid4())
        assert result is None
    
    @pytest.mark.asyncio
    async def test_update_urgency_override(self, service, mock_supabase):
        """Test updating danger override"""
        individual_id = uuid4()
        
        # Mock update response
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value.data = [{
            "id": str(individual_id),
            "urgency_score": 50,
            "urgency_override": 80
        }]
        
        # Test update
        result = await service.update_urgency_override(individual_id, 80)
        
        assert result.urgency_score == 50
        assert result.urgency_override == 80
        assert result.display_score == 80
    
    @pytest.mark.asyncio
    async def test_update_urgency_override_remove(self, service, mock_supabase):
        """Test removing danger override"""
        individual_id = uuid4()
        
        # Mock update response
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value.data = [{
            "id": str(individual_id),
            "urgency_score": 50,
            "urgency_override": None
        }]
        
        # Test remove override
        result = await service.update_urgency_override(individual_id, None)
        
        assert result.urgency_score == 50
        assert result.urgency_override is None
        assert result.display_score == 50  # Back to calculated
    
    @pytest.mark.asyncio
    async def test_get_interactions(self, service, mock_supabase):
        """Test getting interaction history"""
        individual_id = uuid4()
        
        # Mock interactions
        mock_supabase.table.return_value.select.return_value.eq.return_value.order.return_value.range.return_value.execute.return_value.data = [
            {
                "id": str(uuid4()),
                "created_at": datetime.utcnow().isoformat(),
                "user_name": "Demo User",
                "transcription": "Initial meeting transcript",
                "location": {
                    "latitude": 37.7749,
                    "longitude": -122.4194,
                    "address": "123 Market Street, San Francisco, CA 94105"  # Full address
                },
                "changes": {"height": 71, "weight": 165}
            }
        ]
        
        # Test get interactions
        result = await service.get_interactions(individual_id)
        
        assert len(result.interactions) == 1
        interaction = result.interactions[0]
        assert interaction.transcription == "Initial meeting transcript"
        assert interaction.location["address"] == "123 Market Street, San Francisco, CA 94105"  # Full address preserved
        assert "height" in interaction.changes


if __name__ == "__main__":
    pytest.main([__file__, "-v"])