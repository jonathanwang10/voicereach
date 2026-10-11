"""
Test cases for POST /api/categories endpoint
"""
import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import patch, MagicMock
from main import app
from datetime import datetime, timezone
from uuid import uuid4
from api.auth import get_current_user

@pytest.mark.asyncio
class TestCreateCategory:
    
    def setup_method(self):
        """Setup test dependencies"""
        async def mock_auth():
            return "test_user_id"
        app.dependency_overrides[get_current_user] = mock_auth
        
    def teardown_method(self):
        """Cleanup test dependencies"""
        app.dependency_overrides.clear()
    
    async def test_create_category_success(self):
        """Test successful category creation with proper validation"""
        
        # Mock Supabase client
        with patch("api.categories.create_client") as mock_create_client:
            mock_client = MagicMock()
            mock_create_client.return_value = mock_client
            
            # Mock no existing category with same name
            mock_table = MagicMock()
            mock_client.table.return_value = mock_table
            mock_select = MagicMock()
            mock_table.select.return_value = mock_select
            mock_select.execute.return_value.data = []  # no existing categories
            
            # Mock successful insert
            mock_insert = MagicMock()
            mock_table.insert.return_value = mock_insert
            mock_insert.execute.return_value.data = [{
                "id": str(uuid4()),
                "name": "test_category",  # the key
                "display_name": "test category",  # the user's text
                "type": "single_select",
                "priority": "high",
                "urgency_weight": 30,
                "auto_trigger": False,
                "is_required": False,
                "is_preset": False,
                "options": [
                    {"label": "Low", "value": 0.2},
                    {"label": "High", "value": 0.8}
                ],
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat()
            }]
            
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.post(
                    "/api/categories",
                    json={
                        "name": "test category",
                        "type": "single_select",
                        "priority": "high",
                        "urgency_weight": 30,
                        "options": [
                            {"label": "Low", "value": 0.2},
                            {"label": "High", "value": 0.8}
                        ]
                    },
                    headers={"Authorization": "Bearer test_token"}
                )
                
            assert response.status_code == 201
            data = response.json()
            assert data["name"] == "test_category"
            assert data["display_name"] == "test category"
            assert data["urgency_weight"] == 30
            
    async def test_reject_invalid_urgency_weight(self):
        """Test rejection when non-numeric/single-select has urgency_weight > 0"""
        
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/api/categories",
                json={
                    "name": "invalid category",
                    "type": "text",
                    "urgency_weight": 50  # Invalid for text type
                },
                headers={"Authorization": "Bearer test_token"}
            )
            
        assert response.status_code == 422  # FastAPI returns 422 for Pydantic validation errors
        assert "urgency_weight" in str(response.json())
            
    async def test_reject_duplicate_name(self):
        """A name whose key matches an existing category is a 409 (case/space/hyphen-insensitive)"""
        response, db = _post({"name": "existing category", "type": "text"},
                             _CategoryDB([{"name": "Existing category", "display_name": None}]))
        assert response.status_code == 409 and not db.inserted

    async def test_options_validation(self):
        """Test options format validation for different types"""
        
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            # Invalid options for single_select
            response = await client.post(
                "/api/categories",
                json={
                    "name": "bad options",
                    "type": "single_select",
                    "options": ["Just", "Strings"]  # Should be objects
                },
                headers={"Authorization": "Bearer test_token"}
            )
            
        assert response.status_code == 422  # FastAPI returns 422 for Pydantic validation errors
        assert "options" in str(response.json())
            
    async def test_auto_trigger_validation(self):
        """Test auto_trigger only allowed for number/single_select"""
        
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/api/categories",
                json={
                    "name": "invalid trigger",
                    "type": "multi_select",
                    "auto_trigger": True,  # Invalid for multi_select
                    "options": ["Option1", "Option2"]
                },
                headers={"Authorization": "Bearer test_token"}
            )
            
        assert response.status_code == 422  # FastAPI returns 422 for Pydantic validation errors
        assert "auto_trigger" in str(response.json())
            
    @pytest.mark.real_auth
    async def test_missing_auth(self):
        """Test authentication required"""
        # Clear auth override for this test
        app.dependency_overrides.clear()
        
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/api/categories",
                json={"name": "test", "type": "text"}
            )
        assert response.status_code in [401, 422]
        
        # Restore auth override for other tests
        async def mock_auth():
            return "test_user_id"
        app.dependency_overrides[get_current_user] = mock_auth

# --- C-53: category-name handling -------------------------------------------------------
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

PRESETS = [
    {"name": "name", "display_name": "Name"},
    {"name": "veteran_status", "display_name": "Veteran Status"},
    {"name": "age", "display_name": "Age"},
    {"name": "Housing status", "display_name": None},   # a legacy, pre-key custom name
]


class _CategoryDB:
    """table("categories"): select()/order()/execute() lists `existing`; insert() records the row."""

    def __init__(self, existing=PRESETS, insert_error=None):
        self.existing, self.insert_error, self.inserted, self.ilike_calls = list(existing), insert_error, [], []

    def table(self, name):
        assert name == "categories"
        return _CategoryQuery(self)


class _CategoryQuery:
    def __init__(self, db):
        self.db, self.row = db, None

    def select(self, *a, **k):
        return self

    def order(self, *a, **k):
        return self

    def ilike(self, col, pattern):
        self.db.ilike_calls.append(pattern)
        return self

    def insert(self, row):
        self.row = row
        return self

    def execute(self):
        if self.row is not None:
            if self.db.insert_error:
                raise self.db.insert_error
            self.db.inserted.append(self.row)
            return MagicMock(data=[self.row])
        return MagicMock(data=list(self.db.existing))


def _post(body, db=None):
    db = db or _CategoryDB()
    with patch("api.categories.create_client", return_value=db):
        return TestClient(app).post("/api/categories", json=body), db


@pytest.mark.parametrize("name", ["", "   ", "\t", "---", "_"])
def test_blank_names_are_rejected(name):
    r, db = _post({"name": name, "type": "text"})
    assert r.status_code == 422 and not db.inserted


def test_name_length_is_bounded():
    assert _post({"name": "x" * 51, "type": "text"})[0].status_code == 422
    assert _post({"name": "  " + "x" * 50 + "  ", "type": "text"})[0].status_code == 201


def test_name_is_stored_as_key_and_display_name_keeps_casing():
    r, db = _post({"name": "  HIV status ", "type": "text"})
    assert r.status_code == 201
    assert db.inserted[0]["name"] == "hiv_status"
    assert db.inserted[0]["display_name"] == "HIV status"
    assert r.json()["name"] == "hiv_status" and r.json()["display_name"] == "HIV status"


@pytest.mark.parametrize("name", ["Veteran status", "veteran-status", "VETERAN_STATUS", "housing-status",
                                  "Housing  status", "NAME"])
def test_key_collisions_with_existing_categories_are_409(name):
    r, db = _post({"name": name, "type": "text"})
    assert r.status_code == 409 and not db.inserted
    assert "already exists" in r.json()["detail"]


@pytest.mark.parametrize("name", ["A_e", "a%e", "50%", "ag_"])
def test_like_wildcards_do_not_cause_false_409s(name):
    r, db = _post({"name": name, "type": "text"})
    assert r.status_code == 201, r.json()
    assert db.ilike_calls == []


def test_concurrent_duplicate_23505_is_409_not_500():
    err = APIError({"code": "23505", "message": "duplicate key value violates unique constraint",
                    "details": None, "hint": None})
    r, _ = _post({"name": "Shoes", "type": "text"}, _CategoryDB(existing=[], insert_error=err))
    assert r.status_code == 409


def test_other_insert_errors_stay_500():
    err = APIError({"code": "42P01", "message": "relation does not exist", "details": None, "hint": None})
    r, _ = _post({"name": "Shoes", "type": "text"}, _CategoryDB(existing=[], insert_error=err))
    assert r.status_code == 500 and r.json() == {"detail": "Create category failed"}


@pytest.mark.parametrize("body", [
    {"name": "Mood", "type": "single_select"},
    {"name": "Mood", "type": "single_select", "options": []},
    {"name": "Pets", "type": "multi_select"},
    {"name": "Pets", "type": "multi_select", "options": []},
])
def test_select_types_require_options(body):
    r, db = _post(body)
    assert r.status_code == 422 and not db.inserted


@pytest.mark.parametrize("options", [
    [{"label": "  ", "value": 0}],                                   # blank label
    [{"label": "Low", "value": 0}, {"label": "low", "value": 1}],     # duplicate label
    [{"label": "Low", "value": 1.5}],                                 # value above 1
    [{"label": "Low", "value": -0.1}],                                # negative value
    [{"label": "Low", "value": True}],                                # bool is not a number
])
def test_single_select_options_are_validated(options):
    r, _ = _post({"name": "Mood", "type": "single_select", "options": options})
    assert r.status_code == 422


@pytest.mark.parametrize("options", [["Dog", " "], ["Dog", "dog"], ["Dog, Cat"]])
def test_multi_select_options_are_validated(options):
    r, _ = _post({"name": "Pets", "type": "multi_select", "options": options})
    assert r.status_code == 422


def test_options_are_stripped():
    r, db = _post({"name": "Mood", "type": "single_select", "urgency_weight": 30,
                   "options": [{"label": " Calm ", "value": 0}, {"label": "Agitated", "value": 0.5}]})
    assert r.status_code == 201
    assert db.inserted[0]["options"] == [{"label": "Calm", "value": 0}, {"label": "Agitated", "value": 0.5}]
    assert db.inserted[0]["urgency_weight"] == 30


def test_get_categories_returns_display_name():
    db = _CategoryDB([{"id": str(uuid4()), "name": "hiv_status", "display_name": "HIV status", "type": "text",
                       "is_required": False, "is_preset": False}])
    with patch("api.categories.create_client", return_value=db):
        cats = TestClient(app).get("/api/categories").json()["categories"]
    assert cats[0]["display_name"] == "HIV status"
