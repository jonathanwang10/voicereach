"""C-34: one category-driven field registry for embeddings, export and the assistant.

build_embedding_text / export_columns / display_label come from the categories,
so custom fields and every preset reach search, export and the assistant; all
four embedding paths store the exact text they embedded; urgency never enters
the text; a vector of the wrong size is rejected and skipped in search.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from services.field_registry import build_embedding_text, display_label, export_columns
from tests.helpers import FakeSupabase

CATEGORIES = [
    {"name": "name", "display_name": "Name", "type": "text", "is_preset": True, "is_required": True},
    {"name": "height", "display_name": "Height", "type": "number", "is_preset": True, "is_required": True},
    {"name": "housing_priority", "display_name": "Housing Priority", "type": "single_select", "is_preset": False},
    {"name": "hiv_status", "display_name": "HIV status", "type": "text", "is_preset": False},
    {"name": "additional_information", "display_name": None, "type": "text", "is_preset": True},
    {"name": "medical_conditions", "type": "multi_select", "is_preset": False},
    {"name": "last_spot", "display_name": "Last spot", "type": "location", "is_preset": False},
]

PERSON = {
    "id": "i-1", "name": "Ann Lee", "urgency_score": 77, "urgency_override": 90,
    "updated_at": "2026-09-09T00:00:00+00:00",
    "data": {
        "name": "Ann Lee", "height": 64, "housing_priority": "High", "hiv_status": "Negative",
        "additional_information": "Sleeps by the library", "medical_conditions": ["Diabetes", "Asthma"],
        "last_spot": {"latitude": 37.7, "longitude": -122.4, "address": "Civic Center"},
        "old_field": "kept",
    },
}


# --- display_label ----------------------------------------------------------------------

def test_display_label_prefers_display_name_then_title_cases_the_key():
    assert display_label({"name": "hiv_status", "display_name": "HIV status"}) == "HIV status"
    assert display_label({"name": "additional_information", "display_name": None}) == "Additional Information"
    assert display_label({"name": "age", "display_name": "  "}) == "Age"


# --- build_embedding_text ---------------------------------------------------------------

def test_embedding_text_covers_custom_and_preset_fields_in_category_order():
    text = build_embedding_text(PERSON, CATEGORIES)
    assert text.startswith("Name: Ann Lee.")
    assert "Housing Priority: High" in text          # a preset the old builders skipped
    assert "HIV status: Negative" in text            # a custom field, with its own label
    assert "Additional Information: Sleeps by the library" in text
    assert "Medical Conditions: Diabetes, Asthma" in text
    assert "Last spot: Civic Center" in text         # a location reads as its address
    assert text.index("Height") < text.index("HIV status") < text.index("Housing Priority")
    assert text.count("Ann Lee") == 1                # the name is not repeated as a field
    assert "Old Field: kept" in text                 # data with no category still counts


def test_embedding_text_has_no_urgency():
    text = build_embedding_text(PERSON, CATEGORIES)
    assert "rgency" not in text and "77" not in text and "90" not in text


def test_embedding_text_skips_empty_values_and_handles_no_data():
    assert build_embedding_text({"name": "Bo", "data": {"height": None, "hiv_status": "  ", "x": []}},
                                CATEGORIES) == "Name: Bo."
    assert build_embedding_text({"name": "Bo"}, []) == "Name: Bo."


def test_embedding_text_is_the_same_whatever_order_categories_arrive_in():
    """The save path, /generate, /generate-all and the backfill each fetch categories
    themselves; the text must not depend on the order they come back in."""
    import random
    stamped = [dict(c, created_at="2025-01-01T00:00:00Z") for c in CATEGORIES]   # seed rows share one
    expected = build_embedding_text(PERSON, stamped)
    for seed in range(5):
        shuffled = stamped[:]
        random.Random(seed).shuffle(shuffled)
        assert build_embedding_text(PERSON, shuffled) == expected
        assert export_columns(shuffled) == export_columns(stamped)
    newer = [dict(c, created_at="2026-01-01T00:00:00Z") if c["name"] == "hiv_status" else c for c in stamped]
    assert build_embedding_text(PERSON, newer).index("HIV status") > build_embedding_text(PERSON, newer).index("Medical")


def test_save_path_loads_categories_in_creation_order():
    from fastapi.testclient import TestClient
    from main import app
    from tests.helpers import save_response
    calls = []
    sb = MagicMock()
    sb.table.return_value.select.return_value.order.side_effect = lambda *a, **k: calls.append(a) or MagicMock(
        execute=MagicMock(return_value=MagicMock(data=CATEGORIES)))
    saved = save_response({"individual": {"id": "00000000-0000-0000-0000-000000000009", "name": "Ann",
                                          "data": {"name": "Ann", "height": 60, "weight": 120},
                                          "urgency_score": 0, "urgency_override": None, "display_score": 0,
                                          "created_at": "2025-01-01T00:00:00Z", "updated_at": "2025-01-01T00:00:00Z"},
                           "interaction": {"id": "00000000-0000-0000-0000-00000000000a",
                                           "individual_id": "00000000-0000-0000-0000-000000000009",
                                           "user_name": "Demo User", "location": None,
                                           "has_transcription": False, "created_at": "2025-01-01T00:00:00Z"}})
    with patch("api.individuals.get_supabase", return_value=sb), \
         patch("services.individual_service.IndividualService.save_individual", new=AsyncMock(return_value=saved)):
        r = TestClient(app).post("/api/individuals", json={"data": {"name": "Ann", "height": 60, "weight": 120}})
    assert r.status_code == 200, r.text
    assert ("created_at",) in calls


# --- export_columns ---------------------------------------------------------------------

def test_export_columns_cover_every_category_name_first_then_presets():
    cols = export_columns(CATEGORIES)
    # no created_at here, so each group falls back to key order
    assert [k for k, _ in cols] == ["name", "height", "additional_information",
                                    "hiv_status", "housing_priority", "last_spot", "medical_conditions"]
    assert dict(cols)["hiv_status"] == "HIV status"


# --- one builder for all four embedding paths -------------------------------------------

def _service(vector):
    from services.embedding_service import EmbeddingService
    svc = EmbeddingService.__new__(EmbeddingService)
    svc.dimensions = 3072
    svc.generate_embedding = AsyncMock(return_value=vector)
    return svc


def _store_db(existing=()):
    """individual_embeddings: the existing-row read, and an upsert that echoes."""
    return (FakeSupabase().on("individual_embeddings", "select", data=list(existing))
            .on("individual_embeddings", "upsert", data=lambda c: [c.payload]))


def test_stored_text_is_the_embedded_text():
    svc = _service([0.1] * 3072)
    sb = _store_db()
    asyncio.run(svc.store_individual_embedding(sb, PERSON, CATEGORIES))
    embedded = svc.generate_embedding.await_args.args[0]
    [call] = sb.calls_to("individual_embeddings", "upsert")
    assert call.payload["embedding_text"] == embedded == build_embedding_text(PERSON, CATEGORIES)
    assert call.payload["individual_id"] == "i-1"
    assert call.kwargs["on_conflict"] == "individual_id"


def test_wrong_dimension_vector_is_not_stored():
    svc = _service([0.1] * 1536)
    sb = _store_db()
    with pytest.raises(ValueError):
        asyncio.run(svc.store_individual_embedding(sb, PERSON, CATEGORIES))
    assert sb.calls_to("individual_embeddings", "upsert") == []


class _Tables:
    """table(name) -> a query whose execute() returns rows[name]; records upserts."""

    def __init__(self, rows):
        self.rows, self.upserts = rows, []

    def table(self, name):
        db = self
        q = MagicMock()
        for method in ("select", "eq", "order", "in_", "limit", "range"):
            getattr(q, method).return_value = q
        q.execute.return_value = MagicMock(data=list(db.rows.get(name, [])))

        def upsert(row, **kwargs):
            db.upserts.append(row)
            return q
        q.upsert.side_effect = upsert
        return q


@pytest.mark.real_embedding_task
def test_background_task_uses_categories():
    from api import individuals
    svc = _service([0.0] * 3072)
    db = _store_db()
    with patch("api.individuals.get_supabase", return_value=db), \
         patch("api.individuals.get_embedding_service", return_value=svc):
        asyncio.run(individuals.generate_embedding_background("i-1", PERSON, CATEGORIES))
    assert db.payloads("individual_embeddings", "upsert")[0]["embedding_text"] == build_embedding_text(PERSON, CATEGORIES)


def test_the_save_passes_updated_at_to_the_background_task():
    from main import app
    from tests.helpers import save_rpc
    db = (FakeSupabase().on("categories", "select", data=CATEGORIES)
          .on_rpc("save_individual", data=save_rpc(None, at="2026-02-01T00:00:00+00:00")))
    with patch("api.individuals.get_supabase", return_value=db), \
         patch("api.individuals.generate_embedding_background", new=AsyncMock()) as task:
        r = TestClient(app).post("/api/individuals", json={"data": {"name": "Ann", "height": 60, "weight": 120}})
    assert r.status_code == 200, r.text
    assert task.await_args.args[1]["updated_at"].startswith("2026-02-01T00:00:00")


def test_generate_route_uses_categories():
    from main import app
    import api.embeddings as emb
    svc = _service([0.0] * 3072)
    db = (_store_db().on("individuals", "select", data=[PERSON]).on("categories", "select", data=CATEGORIES))
    with patch.object(emb, "get_supabase", return_value=db), patch.object(emb, "embedding_service", svc):
        r = TestClient(app).post("/api/embeddings/generate",
                                 json={"individual_id": "00000000-0000-0000-0000-000000000001"})
    assert r.status_code == 200, r.text
    row = db.payloads("individual_embeddings", "upsert")[0]
    assert row["embedding_text"] == build_embedding_text(PERSON, CATEGORIES)
    assert "rgency" not in row["embedding_text"]
    assert r.json()["embedding_dimensions"] == 3072


# generate-all and the backfill script share services/embedding_refresh.py, whose text is
# build_embedding_text with the categories: see test_embedding_refresh.py (H2-4.4).


# --- halfvec storage, model, hash and source time (H2-4.1) -------------------------------

from services import model_config  # noqa: E402
from services.embedding_service import EmbeddingService, embedding_text_hash  # noqa: E402

A, B = [0.1] * 3072, [0.2] * 3072


def _real_service(*vectors):
    """An EmbeddingService whose generate_embeddings really runs against a fake client."""
    svc = EmbeddingService.__new__(EmbeddingService)
    svc.dimensions = 3072
    data = [MagicMock(index=i, embedding=v) for i, v in enumerate(vectors)]
    svc.client = MagicMock(embeddings=MagicMock(create=AsyncMock(return_value=MagicMock(data=data))))
    return svc


def test_embedding_text_hash_is_sha256_hex():
    assert embedding_text_hash("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"


def test_store_writes_vector_model_hash_and_source_time():
    svc, sb = _real_service(A), _store_db()
    assert asyncio.run(svc.store_individual_embedding(sb, PERSON, CATEGORIES)) is True
    row = sb.payloads("individual_embeddings", "upsert")[0]
    text = build_embedding_text(PERSON, CATEGORIES)
    assert set(row) == {"individual_id", "embedding", "embedding_text", "model", "text_hash", "source_updated_at"}
    assert (row["model"], row["text_hash"], row["source_updated_at"]) == (
        model_config.EMBEDDING_MODEL, embedding_text_hash(text), PERSON["updated_at"])
    assert len(row["embedding"]) == 3072 and "embedding_data" not in row


def _fresh_row(model=None):
    return {"model": model or model_config.EMBEDDING_MODEL,
            "text_hash": embedding_text_hash(build_embedding_text(PERSON, CATEGORIES))}


def test_store_skips_the_call_when_hash_and_model_match():
    svc, sb = _real_service(A), _store_db([_fresh_row()])
    assert asyncio.run(svc.store_individual_embedding(sb, PERSON, CATEGORIES)) is False
    svc.client.embeddings.create.assert_not_awaited()
    assert sb.calls_to("individual_embeddings", "upsert") == []


def test_store_re_embeds_when_the_model_differs():
    svc, sb = _real_service(A), _store_db([_fresh_row("text-embedding-ada-002")])
    assert asyncio.run(svc.store_individual_embedding(sb, PERSON, CATEGORIES)) is True
    assert len(sb.calls_to("individual_embeddings", "upsert")) == 1


def test_store_force_ignores_a_fresh_row():
    svc, sb = _real_service(A), _store_db([_fresh_row()])
    assert asyncio.run(svc.store_individual_embedding(sb, PERSON, CATEGORIES, force=True)) is True
    assert len(sb.calls_to("individual_embeddings", "upsert")) == 1


def test_store_without_updated_at_uses_now():
    svc, sb = _real_service(A), _store_db()
    person = {k: v for k, v in PERSON.items() if k != "updated_at"}
    asyncio.run(svc.store_individual_embedding(sb, person, CATEGORIES))
    assert sb.payloads("individual_embeddings", "upsert")[0]["source_updated_at"].startswith("20")


def test_generate_embeddings_sends_one_array_call_in_input_order():
    svc = EmbeddingService.__new__(EmbeddingService)
    svc.dimensions = 3072
    data = [MagicMock(index=1, embedding=B), MagicMock(index=0, embedding=A)]
    svc.client = MagicMock(embeddings=MagicMock(create=AsyncMock(return_value=MagicMock(data=data))))
    assert asyncio.run(svc.generate_embeddings(["t0", "t1"])) == [A, B]
    svc.client.embeddings.create.assert_awaited_once_with(model=model_config.EMBEDDING_MODEL, input=["t0", "t1"])


def test_generate_embeddings_rejects_a_wrong_dimension_vector():
    svc = _real_service([0.1] * 1536)
    with pytest.raises(ValueError):
        asyncio.run(svc.generate_embeddings(["t0"]))


# --- sensitive fields stay out of the embedding text (H2-4.6) ---------------------------

SENSITIVE = [dict(c, is_sensitive=True) if c["name"] in ("hiv_status", "medical_conditions") else c
             for c in CATEGORIES]


def test_embedding_text_leaves_out_sensitive_fields():
    text = build_embedding_text(PERSON, SENSITIVE)
    assert "HIV status" not in text and "Negative" not in text
    assert "Diabetes" not in text and "Medical Conditions" not in text
    assert "Housing Priority: High" in text          # non-sensitive fields stay


def test_marking_a_category_sensitive_changes_the_hash():
    assert embedding_text_hash(build_embedding_text(PERSON, CATEGORIES)) != \
           embedding_text_hash(build_embedding_text(PERSON, SENSITIVE))


# --- visit-level chunks (H2-4.3) -------------------------------------------------------------

IID, PID = "00000000-0000-0000-0000-0000000000a1", "00000000-0000-0000-0000-0000000000b1"


def _visit_db():
    return (FakeSupabase().on("interaction_embeddings", "select", data=[])
            .on("interaction_embeddings", "upsert", data=lambda c: [c.payload]))


def test_store_interaction_embedding_writes_the_chunk():
    svc, sb = _real_service(A), _visit_db()
    assert asyncio.run(svc.store_interaction_embedding(
        sb, {"id": IID, "individual_id": PID, "transcription": "  Lost his ID.  "})) is True
    row = sb.payloads("interaction_embeddings", "upsert")[0]
    assert set(row) == {"interaction_id", "individual_id", "embedding", "model", "text_hash"}
    assert row["text_hash"] == embedding_text_hash("Lost his ID.")
    assert sb.calls_to("interaction_embeddings", "upsert")[0].kwargs == {"on_conflict": "interaction_id"}


@pytest.mark.parametrize("t", [None, "", "   "])
def test_blank_transcripts_are_not_embedded(t):
    svc, sb = _real_service(A), _visit_db()
    assert asyncio.run(svc.store_interaction_embedding(sb, {"id": IID, "individual_id": PID, "transcription": t})) is False
    svc.client.embeddings.create.assert_not_awaited()
    assert sb.calls == []


def test_long_transcripts_are_clipped_before_embedding():
    svc, sb = _real_service(A), _visit_db()
    asyncio.run(svc.store_interaction_embedding(sb, {"id": IID, "individual_id": PID, "transcription": "x" * 25000}))
    assert len(svc.client.embeddings.create.await_args.kwargs["input"][0]) == 20000


def test_a_fresh_visit_chunk_is_not_re_embedded():
    svc = _real_service(A)
    sb = (FakeSupabase().on("interaction_embeddings", "select", data=[
        {"model": model_config.EMBEDDING_MODEL, "text_hash": embedding_text_hash("Lost his ID.")}]))
    assert asyncio.run(svc.store_interaction_embedding(
        sb, {"id": IID, "individual_id": PID, "transcription": "Lost his ID."})) is False


@pytest.mark.real_embedding_task
def test_background_task_embeds_the_person_and_the_visit():
    from api import individuals
    svc = _real_service(A)
    db = _store_db().on("interaction_embeddings", "select", data=[]).on(
        "interaction_embeddings", "upsert", data=lambda c: [c.payload])
    with patch("api.individuals.get_supabase", return_value=db), \
         patch("api.individuals.get_embedding_service", return_value=svc):
        asyncio.run(individuals.generate_embedding_background(
            "i-1", PERSON, CATEGORIES, interaction={"id": IID, "individual_id": "i-1", "transcription": "Seen at 16th"}))
    assert len(db.calls_to("individual_embeddings", "upsert")) == 1
    assert len(db.calls_to("interaction_embeddings", "upsert")) == 1


@pytest.mark.real_embedding_task
def test_a_failed_person_embedding_still_embeds_the_visit(caplog):
    from api import individuals
    svc = _real_service(A)
    svc.generate_embeddings = AsyncMock(side_effect=[RuntimeError("down"), [A]])
    db = _store_db().on("interaction_embeddings", "select", data=[]).on(
        "interaction_embeddings", "upsert", data=lambda c: [c.payload])
    with patch("api.individuals.get_supabase", return_value=db), \
         patch("api.individuals.get_embedding_service", return_value=svc):
        asyncio.run(individuals.generate_embedding_background(
            "i-1", PERSON, CATEGORIES, interaction={"id": IID, "individual_id": "i-1", "transcription": "Seen at 16th"}))
    assert db.calls_to("individual_embeddings", "upsert") == []
    assert len(db.calls_to("interaction_embeddings", "upsert")) == 1
    assert "RuntimeError" in caplog.text and "16th" not in caplog.text


@pytest.mark.parametrize("transcription,visit", [("Seen at 16th", True), ("  ", False), (None, False)])
def test_save_route_passes_the_visit_to_the_background_task(transcription, visit):
    from main import app
    from tests.helpers import save_rpc
    db = (FakeSupabase().on("categories", "select", data=CATEGORIES)
          .on_rpc("save_individual", data=save_rpc(None)))
    body = {"data": {"name": "Ann", "height": 60, "weight": 120}}
    if transcription is not None:
        body["transcription"] = transcription
    with patch("api.individuals.get_supabase", return_value=db), \
         patch("api.individuals.generate_embedding_background", new=AsyncMock()) as task:
        r = TestClient(app).post("/api/individuals", json=body)
    assert r.status_code == 200, r.text
    interaction = task.await_args.kwargs.get("interaction")
    if visit:
        assert interaction == {"id": r.json()["interaction"]["id"], "individual_id": r.json()["individual"]["id"],
                               "transcription": "Seen at 16th"}
    else:
        assert interaction is None
