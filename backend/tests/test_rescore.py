"""I-1: re-scoring every individual when the urgency maths changes.

OD-1 puts every weighted category in the denominator, so creating one weighted
category changes everyone's correct score. `rescore_all_individuals` recomputes
and writes only the rows whose stored score changed; `create_category` calls it
for a weighted or auto-trigger category, and a re-score failure never fails the create.
"""
import importlib.util
import logging
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from main import app
from services.individual_service import rescore_all_individuals
from tests.helpers import FakeSupabase, paged

VETERAN = {"name": "veteran_status", "display_name": "Veteran Status", "type": "single_select",
           "urgency_weight": 20, "auto_trigger": False,
           "options": [{"label": "Yes", "value": 1}, {"label": "No", "value": 0}]}
HOUSING = {"name": "housing_priority", "display_name": "Housing Priority", "type": "single_select",
           "urgency_weight": 30, "auto_trigger": False,
           "options": [{"label": "Low", "value": 0.1}, {"label": "High", "value": 0.7}]}
CATEGORIES = [VETERAN, HOUSING]

# Before: (20 + 21) / 50 -> 82. After a number category of weight 50: 41 / 100 -> 41.
JAMES = {"id": "id-james", "name": "James", "urgency_score": 82, "urgency_override": None, "version": 1,
         "data": {"veteran_status": "Yes", "housing_priority": "High"}}
# Overridden: the stored score is re-computed, the override is never touched.
ANA = {"id": "id-ana", "name": "Ana", "urgency_score": 82, "urgency_override": 70, "version": 1,
       "data": {"veteran_status": "yes", "housing_priority": "high"}}  # legacy casing
# Nothing scored: 0 before and after, so it is not written.
SAM = {"id": "id-sam", "name": "Sam", "urgency_score": 0, "urgency_override": None, "version": 1, "data": {}}

NEW_NUMBER = {"name": "Days without food", "type": "number", "urgency_weight": 50}


def _db(existing_categories=CATEGORIES, individuals=(JAMES, ANA, SAM)):
    """categories: the first select is the route's conflict check, later ones see the new row."""
    sb = FakeSupabase()
    sb.on("categories", "select", data=[{"name": c["name"], "display_name": c["display_name"]}
                                        for c in existing_categories], times=1)
    sb.on("categories", "insert", data=lambda call: [call.payload])
    sb.on("categories", "select",
          data=lambda call: list(existing_categories) + sb.payloads("categories", "insert"))
    sb.on("individuals", "select", data=list(individuals))
    sb.on_rpc("rescore_batch", data=lambda call: len(call.payload["p_rows"]))
    return sb


def _post(body, sb):
    with patch("api.categories.get_supabase", return_value=sb):
        return TestClient(app).post("/api/categories", json=body)


def _updates(sb):
    """{id: {"urgency_score": n}} for every row sent to rescore_batch (H2-2.9)."""
    return {row["id"]: {"urgency_score": row["urgency_score"]}
            for params in sb.rpc_params("rescore_batch") for row in params["p_rows"]}


def test_rescore_service_updates_only_changed_rows_and_never_the_override():
    from services.individual_service import rescore_all_individuals
    new_cat = {"name": "days_without_food", "display_name": "Days without food", "type": "number",
               "urgency_weight": 50, "auto_trigger": False, "options": None}
    sb = FakeSupabase()
    sb.on("individuals", "select", data=[JAMES, ANA, SAM])
    sb.on("categories", "select", data=CATEGORIES + [new_cat])
    sb.on_rpc("rescore_batch", data=lambda call: len(call.payload["p_rows"]))

    assert rescore_all_individuals(sb) == 2
    assert _updates(sb) == {"id-james": {"urgency_score": 41}, "id-ana": {"urgency_score": 41}}


def test_rescore_service_invalidates_the_context_cache_only_when_something_changed():
    from services import individual_service
    sb = FakeSupabase()
    sb.on("individuals", "select", data=[SAM])
    sb.on("categories", "select", data=CATEGORIES)
    with patch("services.context_service.invalidate_context_cache") as inv:
        assert individual_service.rescore_all_individuals(sb) == 0
    inv.assert_not_called()
    assert not sb.rpc_params("rescore_batch")

    sb = FakeSupabase()
    sb.on("individuals", "select", data=[{**JAMES, "urgency_score": 10}])
    sb.on("categories", "select", data=CATEGORIES)
    sb.on_rpc("rescore_batch", data=lambda call: len(call.payload["p_rows"]))
    with patch("services.context_service.invalidate_context_cache") as inv:
        assert individual_service.rescore_all_individuals(sb) == 1
    inv.assert_called_once()


def test_creating_a_weighted_category_rescores_existing_people():
    sb = _db()
    r = _post(NEW_NUMBER, sb)
    assert r.status_code == 201, r.text
    updates = _updates(sb)
    assert updates == {"id-james": {"urgency_score": 41}, "id-ana": {"urgency_score": 41}}
    assert "id-sam" not in updates                                   # unchanged: not written
    sent = [row for params in sb.rpc_params("rescore_batch") for row in params["p_rows"]]
    assert all(set(row) == {"id", "urgency_score", "version"} for row in sent)  # override untouched


def test_creating_an_auto_trigger_category_rescores_existing_people():
    sb = _db()
    body = {"name": "Medical emergency", "type": "single_select", "auto_trigger": True,
            "options": [{"label": "Yes", "value": 1}, {"label": "No", "value": 0}]}
    r = _post(body, sb)
    assert r.status_code == 201, r.text
    assert sb.calls_to("individuals", "select")  # re-scored (nobody has the field, so no writes)


def test_creating_an_unweighted_category_does_not_rescore():
    sb = _db()
    r = _post({"name": "Shoe size", "type": "text"}, sb)
    assert r.status_code == 201, r.text
    assert not sb.calls_to("individuals")


def test_a_rescore_failure_still_returns_the_created_category(caplog):
    sb = _db()
    sb.rules = [rule for rule in sb.rules if rule.table != "individuals"]
    sb.on("individuals", "select", error=RuntimeError("James Doe, db down"))
    with caplog.at_level(logging.WARNING):
        r = _post(NEW_NUMBER, sb)
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "days_without_food"
    assert "RuntimeError" in caplog.text
    assert "James" not in caplog.text and "db down" not in caplog.text


def test_rescore_script_runs_the_service_function(monkeypatch, capsys):
    path = Path(__file__).resolve().parents[1] / "scripts" / "rescore_urgency.py"
    spec = importlib.util.spec_from_file_location("rescore_urgency", path)
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)

    sb = object()
    monkeypatch.setattr(script, "load_dotenv", lambda: None)
    monkeypatch.setattr(script, "get_supabase_client", lambda: sb)
    seen = []
    monkeypatch.setattr(script, "rescore_all_individuals", lambda client: seen.append(client) or 3)
    script.main()
    assert seen == [sb]
    assert "3" in capsys.readouterr().out


def test_rescore_reads_every_page():
    rows = [{"id": str(uuid.UUID(int=i)), "urgency_score": 0, "data": {}} for i in range(1, 1501)]
    sb = FakeSupabase().on("individuals", "select", data=paged(rows)).on("categories", "select", data=[])
    assert rescore_all_individuals(sb) == 0
    assert len(sb.calls_to("individuals", "select")) == 2


# --- rescore_batch (H2-2.9) -------------------------------------------------------------

NEW_CAT = {"name": "days_without_food", "display_name": "Days without food", "type": "number",
           "urgency_weight": 50, "auto_trigger": False, "options": None}


def _service_db(individuals, batch=lambda call: len(call.payload["p_rows"])):
    sb = FakeSupabase().on("individuals", "select", data=paged(list(individuals)))
    sb.on("categories", "select", data=CATEGORIES + [NEW_CAT])
    return sb.on_rpc("rescore_batch", data=batch)


def test_rescore_sends_only_changed_rows_through_rescore_batch():
    sb = _service_db([JAMES, ANA, SAM])
    assert rescore_all_individuals(sb) == 2
    assert sb.rpc_params("rescore_batch") == [{"p_rows": [
        {"id": "id-james", "urgency_score": 41, "version": 1}, {"id": "id-ana", "urgency_score": 41, "version": 1}]}]
    assert not sb.calls_to("individuals", "update")


def test_rescore_writes_in_batches_of_500():
    people = [{**JAMES, "id": str(uuid.UUID(int=i))} for i in range(1, 1002)]
    sb = _service_db(people)
    assert rescore_all_individuals(sb) == 1001
    assert [len(p["p_rows"]) for p in sb.rpc_params("rescore_batch")] == [500, 500, 1]


def test_rescore_returns_what_the_database_updated():
    sb = _service_db([JAMES, ANA], batch=1)          # one of the two was saved meanwhile
    assert rescore_all_individuals(sb) == 1


def test_rescore_sends_nothing_when_no_score_changed():
    sb = _service_db([SAM])
    with patch("services.context_service.invalidate_context_cache") as inv:
        assert rescore_all_individuals(sb) == 0
    assert sb.rpc_params("rescore_batch") == []
    inv.assert_not_called()


def test_rescore_never_sends_the_override():
    sb = _service_db([JAMES, ANA, SAM])
    rescore_all_individuals(sb)
    rows = [row for p in sb.rpc_params("rescore_batch") for row in p["p_rows"]]
    assert rows and all(set(row) == {"id", "urgency_score", "version"} for row in rows)


def test_create_category_answers_before_rescoring():   # a sync route since Phase 1 (H2-1.1)
    from fastapi import BackgroundTasks
    import api.categories as cats
    from db.models import CreateCategoryRequest
    tasks = BackgroundTasks()
    with patch.object(cats, "rescore_all_individuals") as rescore, patch.object(cats, "get_supabase", return_value=_db()):
        cats.create_category(CreateCategoryRequest(**NEW_NUMBER), background_tasks=tasks, user_id="u", device_id=None)
    rescore.assert_not_called()
    assert [t.func for t in tasks.tasks] == [cats.rescore_in_background]
