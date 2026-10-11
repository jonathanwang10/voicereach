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
    assert text.index("Height") < text.index("Housing Priority") < text.index("HIV status")
    assert text.count("Ann Lee") == 1                # the name is not repeated as a field
    assert "Old Field: kept" in text                 # data with no category still counts


def test_embedding_text_has_no_urgency():
    text = build_embedding_text(PERSON, CATEGORIES)
    assert "rgency" not in text and "77" not in text and "90" not in text


def test_embedding_text_skips_empty_values_and_handles_no_data():
    assert build_embedding_text({"name": "Bo", "data": {"height": None, "hiv_status": "  ", "x": []}},
                                CATEGORIES) == "Name: Bo."
    assert build_embedding_text({"name": "Bo"}, []) == "Name: Bo."


# --- export_columns ---------------------------------------------------------------------

def test_export_columns_cover_every_category_name_first_then_presets():
    cols = export_columns(CATEGORIES)
    assert [k for k, _ in cols] == ["name", "height", "additional_information",
                                    "housing_priority", "hiv_status", "medical_conditions", "last_spot"]
    assert dict(cols)["hiv_status"] == "HIV status"


# --- one builder for all four embedding paths -------------------------------------------

def _service(vector):
    from services.embedding_service import EmbeddingService
    svc = EmbeddingService.__new__(EmbeddingService)
    svc.dimensions = 3072
    svc.generate_embedding = AsyncMock(return_value=vector)
    return svc


def test_stored_text_is_the_embedded_text():
    svc = _service([0.1] * 3072)
    sb = MagicMock()
    asyncio.run(svc.store_individual_embedding(sb, PERSON, CATEGORIES))
    embedded = svc.generate_embedding.await_args.args[0]
    row = sb.table.return_value.upsert.call_args.args[0]
    assert row["embedding_text"] == embedded == build_embedding_text(PERSON, CATEGORIES)
    assert row["individual_id"] == "i-1"
    assert sb.table.return_value.upsert.call_args.kwargs["on_conflict"] == "individual_id"


def test_wrong_dimension_vector_is_not_stored():
    svc = _service([0.1] * 1536)
    sb = MagicMock()
    with pytest.raises(ValueError):
        asyncio.run(svc.store_individual_embedding(sb, PERSON, CATEGORIES))
    sb.table.return_value.upsert.assert_not_called()


class _Tables:
    """table(name) -> a query whose execute() returns rows[name]; records upserts."""

    def __init__(self, rows):
        self.rows, self.upserts = rows, []

    def table(self, name):
        db = self
        q = MagicMock()
        for method in ("select", "eq", "order", "in_", "limit"):
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
    db = _Tables({"categories": CATEGORIES})
    with patch("api.individuals.get_supabase_client", return_value=db), \
         patch("services.embedding_service.EmbeddingService", return_value=svc):
        asyncio.run(individuals.generate_embedding_background("i-1", PERSON, CATEGORIES))
    assert db.upserts[0]["embedding_text"] == build_embedding_text(PERSON, CATEGORIES)


def test_generate_route_uses_categories():
    from main import app
    import api.embeddings as emb
    svc = _service([0.0] * 3072)
    db = _Tables({"individuals": [PERSON], "categories": CATEGORIES})
    with patch.object(emb, "get_supabase_client", return_value=db), patch.object(emb, "embedding_service", svc):
        r = TestClient(app).post("/api/embeddings/generate",
                                 json={"individual_id": "00000000-0000-0000-0000-000000000001"})
    assert r.status_code == 200, r.text
    assert db.upserts[0]["embedding_text"] == build_embedding_text(PERSON, CATEGORIES)
    assert "rgency" not in db.upserts[0]["embedding_text"]


def test_generate_all_route_uses_categories():
    from main import app
    import api.embeddings as emb
    svc = _service([0.0] * 3072)
    db = _Tables({"individuals": [PERSON, dict(PERSON, id="i-2", name="Bo")], "categories": CATEGORIES})
    with patch.object(emb, "get_supabase_client", return_value=db), patch.object(emb, "embedding_service", svc):
        r = TestClient(app).post("/api/embeddings/generate-all")
    assert r.json()["generated_count"] == 2
    assert all(u["embedding_text"].startswith("Name: ") and "HIV status" in u["embedding_text"]
               for u in db.upserts)


def test_backfill_script_uses_categories():
    from scripts import backfill_embeddings as bf
    svc = _service([0.0] * 3072)
    db = _Tables({"individuals": [PERSON], "categories": CATEGORIES})
    with patch.object(bf, "get_supabase_client", return_value=db), \
         patch.object(bf, "EmbeddingService", return_value=svc), \
         patch.object(bf, "load_dotenv"), patch.dict("os.environ", {"OPENAI_API_KEY": "x"}), \
         patch("asyncio.sleep", new=AsyncMock()):
        asyncio.run(bf.setup_embeddings())
    assert db.upserts[0]["embedding_text"] == build_embedding_text(PERSON, CATEGORIES)


def test_search_skips_vectors_of_another_dimension():
    """A leftover 1536-d row must not make the whole semantic leg return nothing."""
    from main import app
    import api.embeddings as emb
    good = dict(PERSON, id="good")
    rows = [
        {"individual_id": "old", "embedding_data": [1.0] * 1536, "individuals": dict(PERSON, id="old")},
        {"individual_id": "good", "embedding_data": [1.0] * 3072, "individuals": good},
    ]
    svc = _service([1.0] * 3072)
    from services.embedding_service import EmbeddingService
    svc.semantic_search = lambda *a, **k: EmbeddingService.semantic_search(svc, *a, **k)
    svc.search_similar_individuals = lambda *a, **k: EmbeddingService.search_similar_individuals(svc, *a, **k)
    db = _Tables({"individuals": [], "individual_embeddings": rows, "interactions": []})
    with patch.object(emb, "get_supabase_client", return_value=db), patch.object(emb, "embedding_service", svc):
        r = TestClient(app).post("/api/embeddings/search", json={"query": "zzzz"})
    assert [x["id"] for x in r.json()["results"]] == ["good"]
