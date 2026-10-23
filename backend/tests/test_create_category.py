"""POST /api/categories and GET /api/categories, with a small in-memory categories table.

Every create test asserts on the row the route inserted (or that it inserted nothing).
Auth is covered for every route by test_security_routes.py.
"""
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from main import app

# --- C-53: category-name handling -------------------------------------------------------

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
    with patch("api.categories.get_supabase", return_value=db):
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


def test_reject_duplicate_name_is_case_insensitive():
    r, db = _post({"name": "existing category", "type": "text"},
                  _CategoryDB([{"name": "Existing category", "display_name": None}]))
    assert r.status_code == 409 and not db.inserted


def test_get_categories_returns_display_name():
    db = _CategoryDB([{"id": str(uuid4()), "name": "hiv_status", "display_name": "HIV status", "type": "text",
                       "is_required": False, "is_preset": False}])
    with patch("api.categories.get_supabase", return_value=db):
        cats = TestClient(app).get("/api/categories").json()["categories"]
    assert cats[0]["display_name"] == "HIV status"


# --- type rules (CreateCategoryRequest) are a 422 before anything is written ----------------

@pytest.mark.parametrize("body,field", [
    ({"name": "Invalid category", "type": "text", "urgency_weight": 50}, "urgency_weight"),
    ({"name": "Bad options", "type": "single_select", "options": ["Just", "Strings"]}, "options"),
    ({"name": "Invalid trigger", "type": "multi_select", "auto_trigger": True, "options": ["A", "B"]}, "auto_trigger"),
])
def test_type_rules_are_422_and_insert_nothing(body, field):
    r, db = _post(body)
    assert r.status_code == 422 and not db.inserted
    assert field in str(r.json())


def test_get_categories_maps_rows_and_fills_defaults():
    db = _CategoryDB([
        {"id": "c1", "name": "name", "display_name": "Name", "type": "text", "is_required": True,
         "is_preset": True, "priority": "high", "urgency_weight": 0, "auto_trigger": False, "options": None},
        {"id": "c2", "name": "mood", "type": "single_select", "is_required": False, "is_preset": False,
         "options": [{"label": "Calm", "value": 0}]},  # an old row without priority/weight/trigger
    ])
    with patch("api.categories.get_supabase", return_value=db):
        r = TestClient(app).get("/api/categories")
    assert r.status_code == 200
    assert r.json()["categories"][1] == {
        "id": "c2", "name": "mood", "display_name": None, "type": "single_select", "is_required": False,
        "is_preset": False, "priority": "medium", "urgency_weight": 0, "auto_trigger": False,
        "options": [{"label": "Calm", "value": 0}],
    }


def test_a_category_named_removed_is_reserved():          # H2-2.5
    r, db = _post({"name": "_removed", "type": "text"})
    assert r.status_code == 422 and "That name is reserved" in r.text
    assert not db.inserted
