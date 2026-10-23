import asyncio
import csv
import io
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


EXPORT_CATS = [
    {"name": "name", "display_name": "Name", "type": "text", "is_preset": True, "is_required": True},
    {"name": "height", "display_name": "Height", "type": "number", "is_preset": True, "is_required": True},
    {"name": "hiv_status", "display_name": "HIV status", "type": "text"},
    {"name": "medical_conditions", "display_name": "Medical Conditions", "type": "multi_select"},
]


class _ExportDB:
    """table(name) -> rows for that table; records the in_() filters on interactions."""

    def __init__(self, individuals, interactions=(), categories=EXPORT_CATS):
        self.rows = {"individuals": list(individuals), "interactions": list(interactions),
                     "categories": list(categories)}
        self.queries = []

    def table(self, name):
        db, q = self, MagicMock()
        for method in ("select", "order", "eq", "limit", "range"):
            getattr(q, method).return_value = q

        def in_(col, ids):
            db.queries.append((name, col, list(ids)))
            return q
        q.in_.side_effect = in_
        rows = db.rows[name]
        if name == "interactions":  # newest first, like .order("created_at", desc=True)
            rows = sorted(rows, key=lambda r: r["created_at"], reverse=True)
        q.execute.return_value = MagicMock(data=rows)
        return q


def _export(db):
    from main import app
    with patch("api.categories.get_supabase", return_value=db):
        r = TestClient(app).get("/api/export")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    return list(csv.reader(io.StringIO(r.text)))


def _person(**kw):
    base = {"id": "p1", "name": "Ann", "data": {"height": 60}, "urgency_score": 80, "urgency_override": None,
            "created_at": "2025-01-01T00:00:00Z", "updated_at": "2025-06-01T00:00:00Z"}
    base.update(kw)
    return base


def test_export_uses_override_zero():
    rows = _export(_ExportDB([_person(urgency_override=0)]))
    record = dict(zip(rows[0], rows[1]))
    assert record["Urgency Score"] == "0"


def test_export_uses_get_display_urgency_score():
    with patch("api.categories.get_display_urgency_score", return_value=42) as display:
        rows = _export(_ExportDB([_person()]))
    display.assert_called_once()
    assert dict(zip(rows[0], rows[1]))["Urgency Score"] == "42"


def test_empty_database_gives_header_only_csv_not_404():
    rows = _export(_ExportDB([]))
    assert rows == [["Name", "Height", "HIV status", "Medical Conditions", "Urgency Score", "Last Seen"]]


def test_columns_come_from_categories_including_custom_fields():
    rows = _export(_ExportDB([_person(data={"height": 60, "hiv_status": "Negative",
                                             "medical_conditions": ["Diabetes", "Asthma"]})]))
    record = dict(zip(rows[0], rows[1]))
    assert record["HIV status"] == "Negative"
    assert record["Medical Conditions"] == "Diabetes, Asthma"
    assert record["Name"] == "Ann" and record["Height"] == "60"


def test_last_seen_is_latest_interaction_else_created_at_never_updated_at():
    interactions = [
        {"individual_id": "p1", "created_at": "2025-03-01T00:00:00Z", "location": None},
        {"individual_id": "p1", "created_at": "2025-04-01T00:00:00Z", "location": None},
    ]
    db = _ExportDB([_person(), _person(id="p2", name="Bo", created_at="2025-02-02T00:00:00Z")], interactions)
    rows = _export(db)
    seen = {r[0]: dict(zip(rows[0], r))["Last Seen"] for r in rows[1:]}
    assert seen == {"Ann": "2025-04-01T00:00:00Z", "Bo": "2025-02-02T00:00:00Z"}
    assert [q for q in db.queries if q[0] == "interactions"] == [("interactions", "individual_id", ["p1", "p2"])]


@pytest.mark.parametrize("evil", ["=HYPERLINK(\"http://x\",\"click\")", "+1+1", "-2+3", "@SUM(A1)",
                                  "\t=1", "\r=1"])
def test_formula_like_cells_are_neutralised(evil):
    rows = _export(_ExportDB([_person(name=evil, data={"height": 60, "hiv_status": evil})]))
    record = dict(zip(rows[0], rows[1]))
    for cell in (record["Name"], record["HIV status"]):  # values are stripped, then prefixed
        assert cell == "'" + evil.strip()


def test_category_labels_cannot_collide_with_fixed_or_other_headers():
    cats = EXPORT_CATS + [
        {"name": "urgency_score", "display_name": "Urgency Score", "type": "number"},
        {"name": "last_seen", "display_name": "last seen", "type": "text"},
        {"name": "hiv", "display_name": "HIV status", "type": "text"},
    ]
    rows = _export(_ExportDB([_person(data={"height": 60, "urgency_score": 3, "last_seen": "Pier 39",
                                             "hiv_status": "Negative", "hiv": "Unknown"})], categories=cats))
    header = rows[0]
    assert len(header) == len({h.lower() for h in header})
    record = dict(zip(header, rows[1]))
    assert record["Urgency Score"] == "80" and record["Urgency Score (urgency_score)"] == "3"
    assert record["Last Seen"] == "2025-01-01T00:00:00Z" and record["last seen (last_seen)"] == "Pier 39"
    # same label twice: the later column (by creation, then key) gets its key appended
    assert record["HIV status"] == "Unknown" and record["HIV status (hiv_status)"] == "Negative"


def test_numbers_and_plain_text_are_not_prefixed():
    rows = _export(_ExportDB([_person(name="Ann-Marie", data={"height": 60, "hiv_status": "a=b"})]))
    record = dict(zip(rows[0], rows[1]))
    assert record["Name"] == "Ann-Marie" and record["Height"] == "60" and record["HIV status"] == "a=b"


def test_export_route_registered_once():
    from main import app
    from tests.helpers import all_route_paths
    paths = [p for p in all_route_paths(app) if p == "/api/export"]
    assert len(paths) == 1


@pytest.mark.real_embedding_task
def test_embedding_upsert_conflicts_on_individual_id():
    from api import individuals
    sb = MagicMock()
    with patch("api.individuals.get_supabase", return_value=sb), \
         patch("services.embedding_service.EmbeddingService.generate_embedding",
               new=AsyncMock(return_value=[0.0] * 3072)):
        asyncio.run(individuals.generate_embedding_background("i-1", {"name": "Ann", "data": {}}, []))
    _, kwargs = sb.table.return_value.upsert.call_args
    assert kwargs.get("on_conflict") == "individual_id"


def test_export_includes_people_past_the_first_1000():
    from main import app
    from tests.helpers import FakeSupabase, paged
    people = [{"id": f"id-{i:05d}", "name": f"P{i}", "urgency_score": 0, "urgency_override": None,
               "data": {}, "created_at": "2026-01-01T00:00:00+00:00"} for i in range(1001)]
    sb = (FakeSupabase().on("categories", "select", data=[])
          .on("individuals", "select", data=paged(people)).on("interactions", "select", data=[]))
    with patch("api.categories.get_supabase", return_value=sb):
        r = TestClient(app).get("/api/export")
    assert r.status_code == 200, r.text
    assert len(r.text.strip().splitlines()) == 1 + 1001


def test_export_csv_is_audited_with_user_and_device():          # H2-2.7
    from main import app
    from tests.helpers import FakeSupabase, paged
    people = [{"id": f"id-{i}", "name": f"P{i}", "urgency_score": 0, "urgency_override": None,
               "data": {}, "created_at": "2026-01-01T00:00:00+00:00"} for i in range(3)]
    sb = (FakeSupabase().on("categories", "select", data=[]).on("individuals", "select", data=paged(people))
          .on("interactions", "select", data=[]).on("audit_log", "insert", data=lambda c: [c.payload]))
    with patch("api.categories.get_supabase", return_value=sb):
        r = TestClient(app).get("/api/export", headers={"X-Device-Id": "device-1234"})
    assert r.status_code == 200
    assert sb.payloads("audit_log", "insert") == [{"user_id": "test-user-123", "device_id": "device-1234",
        "action": "export_csv", "entity_type": "export", "entity_id": None, "detail": {"rows": 3}}]
