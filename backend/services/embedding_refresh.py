"""
One refresh path for every bulk embedding job (H2-4.4): `backfill_embeddings.py --stale`,
the full backfill, and `POST /api/embeddings/generate-all`.

A person (or a visit with a transcript) is stale when it has no row, its row came from
another model, or its stored text hash differs from the hash of the text built now. The
last test also catches a category label change and an is_sensitive flip, so nothing
needs to "mark" rows. Stale texts go out in batches (EMBED_BATCH_SIZE texts or
EMBED_BATCH_MAX_CHARS characters, whichever comes first): one embeddings call and one
upsert per batch. A failed batch is reported by id and error type, and the run goes on.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, List, Optional, Tuple

from db.client import fetch_all, run_db
from services.embedding_service import (MAX_CHUNK_CHARS, EmbeddingService, embedding_text_hash,
                                        get_embedding_service)
from services.field_registry import build_embedding_text

EMBED_BATCH_SIZE = 100
# The embeddings endpoint has a per-request token limit; long visit transcripts add up
EMBED_BATCH_MAX_CHARS = 200_000


@dataclass
class RefreshReport:
    individuals_embedded: int = 0
    individuals_fresh: int = 0
    interactions_embedded: int = 0
    interactions_fresh: int = 0
    errors: List[str] = field(default_factory=list)   # "<id>: <ErrorType>", never names


def _batches(items: List[Tuple[str, str, dict]]) -> List[List[Tuple[str, str, dict]]]:
    """(id, text, row) items in batches closed at EMBED_BATCH_SIZE or EMBED_BATCH_MAX_CHARS."""
    batches, current, chars = [], [], 0
    for item in items:
        if current and (len(current) >= EMBED_BATCH_SIZE or chars + len(item[1]) > EMBED_BATCH_MAX_CHARS):
            batches.append(current)
            current, chars = [], 0
        current.append(item)
        chars += len(item[1])
    if current:
        batches.append(current)
    return batches


async def _embed_and_store(supabase: Any, service: EmbeddingService, table: str, conflict: str,
                           items: List[Tuple[str, str, dict]], report: RefreshReport) -> int:
    stored = 0
    for batch in _batches(items):
        try:
            vectors = await service.generate_embeddings([text for _, text, _ in batch])
            rows = [{**row, "embedding": vector} for (_, _, row), vector in zip(batch, vectors)]
            await run_db(lambda: supabase.table(table).upsert(rows, on_conflict=conflict).execute())
            stored += len(batch)
        except Exception as e:
            report.errors.extend(f"{item_id}: {type(e).__name__}" for item_id, _, _ in batch)
    return stored


async def _read(supabase: Any, build: Callable[[], Any]) -> List[dict]:
    return await run_db(lambda: fetch_all(build))


async def refresh_embeddings(supabase: Any, *, stale_only: bool = True,
                             service: Optional[EmbeddingService] = None) -> RefreshReport:
    """Embed every stale person and visit (or all of them, with stale_only=False).
    Database read errors propagate; embedding failures are counted in the report."""
    service = service or get_embedding_service()
    report = RefreshReport()
    categories = await _read(supabase, lambda: supabase.table("categories").select("*").order("created_at").order("id"))
    people = await _read(supabase, lambda: supabase.table("individuals")
                         .select("id, name, data, updated_at").order("id"))
    stored_people = {r["individual_id"]: r for r in await _read(
        supabase, lambda: supabase.table("individual_embeddings")
        .select("individual_id, model, text_hash").order("individual_id"))}
    visits = await _read(supabase, lambda: supabase.table("interactions")
                         .select("id, individual_id, transcription").order("id"))
    stored_visits = {r["interaction_id"]: r for r in await _read(
        supabase, lambda: supabase.table("interaction_embeddings")
        .select("interaction_id, model, text_hash").order("interaction_id"))}

    def is_fresh(row: Optional[dict], text_hash: str) -> bool:
        return (stale_only and row is not None and row.get("model") == service.model
                and row.get("text_hash") == text_hash)

    now = datetime.now(timezone.utc).isoformat()
    person_items = []
    for person in people:
        text = build_embedding_text(person, categories)
        text_hash = embedding_text_hash(text)
        if is_fresh(stored_people.get(person["id"]), text_hash):
            report.individuals_fresh += 1
            continue
        person_items.append((person["id"], text, {
            "individual_id": person["id"], "embedding_text": text, "model": service.model,
            "text_hash": text_hash, "source_updated_at": person.get("updated_at") or now}))

    visit_items = []
    for visit in visits:
        text = (visit.get("transcription") or "").strip()[:MAX_CHUNK_CHARS]
        if not text:
            continue
        text_hash = embedding_text_hash(text)
        if is_fresh(stored_visits.get(visit["id"]), text_hash):
            report.interactions_fresh += 1
            continue
        visit_items.append((visit["id"], text, {
            "interaction_id": visit["id"], "individual_id": visit["individual_id"],
            "model": service.model, "text_hash": text_hash}))

    report.individuals_embedded = await _embed_and_store(
        supabase, service, "individual_embeddings", "individual_id", person_items, report)
    report.interactions_embedded = await _embed_and_store(
        supabase, service, "interaction_embeddings", "interaction_id", visit_items, report)
    return report


