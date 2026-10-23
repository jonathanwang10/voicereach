"""One refresh path for backfill --stale, the full backfill and generate-all (H2-4.4)."""
import asyncio
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from services import embedding_refresh, model_config
from services.embedding_refresh import RefreshReport, refresh_embeddings
from services.embedding_service import EmbeddingService, embedding_text_hash
from services.field_registry import build_embedding_text
from tests.helpers import FakeSupabase, paged

CATEGORIES = [{"name": "name", "display_name": "Name", "type": "text"},
              {"name": "hiv_status", "display_name": "HIV status", "type": "text"}]
T = "2026-09-09T00:00:00+00:00"


def run(coro):
    return asyncio.run(coro)


def _id(n):
    return str(uuid.UUID(int=n))


def _person(n, **data):
    return {"id": _id(n), "name": f"P{n}", "data": {"name": f"P{n}", **data}, "updated_at": T}


def _fresh(person, categories=CATEGORIES, model=None):
    return {"individual_id": person["id"], "model": model or model_config.EMBEDDING_MODEL,
            "text_hash": embedding_text_hash(build_embedding_text(person, categories))}


@pytest.fixture
def svc():
    s = EmbeddingService.__new__(EmbeddingService)
    s.dimensions = 3072
    s.generate_embeddings = AsyncMock(side_effect=lambda texts: [[0.0] * 3072 for _ in texts])
    return s


def _db(people=(), embedded=(), visits=(), visit_rows=(), categories=CATEGORIES):
    return (FakeSupabase()
            .on("categories", "select", data=paged(list(categories)))
            .on("individuals", "select", data=paged(list(people)))
            .on("individual_embeddings", "select", data=paged(list(embedded)))
            .on("interactions", "select", data=paged(list(visits)))
            .on("interaction_embeddings", "select", data=paged(list(visit_rows)))
            .on("individual_embeddings", "upsert", data=lambda c: c.payload)
            .on("interaction_embeddings", "upsert", data=lambda c: c.payload))


def test_stale_only_embeds_missing_changed_and_other_model_rows(svc):
    a, b, c, d = _person(1), _person(2), _person(3), _person(4)
    changed = {**_fresh(c), "text_hash": "old"}
    sb = _db([a, b, c, d], [_fresh(b), changed, _fresh(d, model="text-embedding-ada-002")])
    report = run(refresh_embeddings(sb, service=svc))
    assert [len(call.args[0]) for call in svc.generate_embeddings.await_args_list] == [3]
    assert {r["individual_id"] for r in sb.payloads("individual_embeddings", "upsert")[0]} == {a["id"], c["id"], d["id"]}
    assert (report.individuals_embedded, report.individuals_fresh) == (3, 1)
    row = sb.payloads("individual_embeddings", "upsert")[0][0]
    assert set(row) == {"individual_id", "embedding", "embedding_text", "model", "text_hash", "source_updated_at"}
    assert sb.calls_to("individual_embeddings", "upsert")[0].kwargs == {"on_conflict": "individual_id"}


def test_without_stale_everyone_is_re_embedded(svc):
    people = [_person(n) for n in range(1, 5)]
    report = run(refresh_embeddings(_db(people, [_fresh(p) for p in people]), stale_only=False, service=svc))
    assert (report.individuals_embedded, report.individuals_fresh) == (4, 0)


def test_batches_hold_at_most_100_texts(svc):
    sb = _db([_person(n) for n in range(1, 251)])
    run(refresh_embeddings(sb, service=svc))
    assert [len(call.args[0]) for call in svc.generate_embeddings.await_args_list] == [100, 100, 50]
    assert len(sb.calls_to("individual_embeddings", "upsert")) == 3


def test_batches_also_close_at_200k_characters(svc):
    # each transcript is clipped to MAX_CHUNK_CHARS (20,000), so 10 fit in 200,000 characters
    visits = [{"id": _id(100 + n), "individual_id": _id(1), "transcription": "x" * 25_000} for n in range(11)]
    sb = _db([_person(1)], [_fresh(_person(1))], visits)
    report = run(refresh_embeddings(sb, service=svc))
    assert [len(call.args[0]) for call in svc.generate_embeddings.await_args_list] == [10, 1]
    assert report.interactions_embedded == 11


def test_a_failed_batch_is_reported_by_id_and_error_type_and_the_rest_continue(svc):
    calls = []

    async def generate(texts):
        calls.append(len(texts))
        if len(calls) == 1:
            raise RuntimeError("SENTINEL Ann Lee")
        return [[0.0] * 3072 for _ in texts]
    svc.generate_embeddings = generate
    people = [_person(n) for n in range(1, 151)]
    sb = _db(people)
    report = run(refresh_embeddings(sb, service=svc))
    assert len(report.errors) == 100 and report.errors[0] == f"{people[0]['id']}: RuntimeError"
    assert not any("Ann Lee" in e for e in report.errors)
    assert report.individuals_embedded == 50 and len(sb.calls_to("individual_embeddings", "upsert")) == 1


def test_visits_are_refreshed_too(svc):
    p = _person(1)
    visits = [{"id": _id(201), "individual_id": p["id"], "transcription": "Seen at 16th"},
              {"id": _id(202), "individual_id": p["id"], "transcription": ""},
              {"id": _id(203), "individual_id": p["id"], "transcription": None},
              {"id": _id(204), "individual_id": p["id"], "transcription": "Fresh one"}]
    fresh_chunk = {"interaction_id": _id(204), "model": model_config.EMBEDDING_MODEL,
                   "text_hash": embedding_text_hash("Fresh one")}
    sb = _db([p], [_fresh(p)], visits, [fresh_chunk])
    report = run(refresh_embeddings(sb, service=svc))
    assert (report.interactions_embedded, report.interactions_fresh) == (1, 1)
    [rows] = sb.payloads("interaction_embeddings", "upsert")
    assert [r["interaction_id"] for r in rows] == [_id(201)]
    assert set(rows[0]) == {"interaction_id", "individual_id", "embedding", "model", "text_hash"}


def test_flipping_a_category_to_sensitive_makes_its_people_stale(svc):          # Review Focus 5
    p = _person(1, hiv_status="Negative")
    sensitive = [CATEGORIES[0], {**CATEGORIES[1], "is_sensitive": True}]
    sb = _db([p], [_fresh(p, CATEGORIES)], categories=sensitive)
    report = run(refresh_embeddings(sb, service=svc))
    assert report.individuals_embedded == 1
    assert "Negative" not in sb.payloads("individual_embeddings", "upsert")[0][0]["embedding_text"]


def test_every_read_is_paginated(svc, monkeypatch):
    seen = []
    real = embedding_refresh.fetch_all

    def spy(build, page_size=1000):
        rows = real(build, page_size)
        seen.append(build()._table)
        return rows
    monkeypatch.setattr(embedding_refresh, "fetch_all", spy)
    run(refresh_embeddings(_db([_person(1)]), service=svc))
    assert set(seen) == {"categories", "individuals", "individual_embeddings", "interactions", "interaction_embeddings"}


def test_backfill_stale_flag_selects_the_stale_refresh(monkeypatch):
    from scripts import backfill_embeddings as bf
    refresh = AsyncMock(return_value=RefreshReport())
    monkeypatch.setattr(bf, "refresh_embeddings", refresh)
    monkeypatch.setattr(bf, "get_supabase", lambda: object())
    monkeypatch.setattr(bf, "load_dotenv", lambda: None)
    assert run(bf.main(["--stale"])) == 0
    assert refresh.await_args.kwargs["stale_only"] is True
    assert run(bf.main([])) == 0
    assert refresh.await_args.kwargs["stale_only"] is False


def test_backfill_reports_errors_by_id_only(monkeypatch, capsys):
    from scripts import backfill_embeddings as bf
    report = RefreshReport(errors=[f"{_id(n)}: RuntimeError" for n in range(7)])
    monkeypatch.setattr(bf, "refresh_embeddings", AsyncMock(return_value=report))
    monkeypatch.setattr(bf, "get_supabase", lambda: object())
    monkeypatch.setattr(bf, "load_dotenv", lambda: None)
    assert run(bf.main(["--stale"])) == 1
    out = capsys.readouterr().out
    assert out.count("RuntimeError") == 5


def test_generate_all_uses_the_stale_refresh():
    from main import app
    refresh = AsyncMock(return_value=RefreshReport(individuals_embedded=2, individuals_fresh=1, interactions_embedded=3))
    with patch("api.embeddings.refresh_embeddings", refresh), patch("api.embeddings.get_supabase"):
        r = TestClient(app).post("/api/embeddings/generate-all")
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["generated_count"], body["fresh_count"], body["interactions_embedded"]) == (2, 1, 3)
    assert refresh.await_args.kwargs["stale_only"] is True
