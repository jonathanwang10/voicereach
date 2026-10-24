"""
Embedding service for semantic search using OpenAI's text-embedding-3-large model
"""
import hashlib
import os
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional, Tuple
from openai import AsyncOpenAI
from dotenv import load_dotenv

from db.client import run_db
from services.request_log import record_usage
from services import model_config
from services.field_registry import build_embedding_text

# Load environment variables
load_dotenv()

# Cosine-similarity cut-off for semantic search; the one value every caller defaults to.
DEFAULT_SIMILARITY_THRESHOLD = 0.15

# Query embeddings (H2-4.5): one process cache keyed on the normalised query, and no
# semantic leg for a query under SEMANTIC_MIN_CHARS (a fragment embeds to noise). The
# cache holds query text in memory only and is never logged.
# A visit's transcript is embedded up to this many characters (H2-4.3)
MAX_CHUNK_CHARS = 20000

QUERY_CACHE_SIZE = 256
QUERY_CACHE_TTL_S = 600
SEMANTIC_MIN_CHARS = 3
_now = time.monotonic
_query_cache: "OrderedDict[str, Tuple[float, List[float]]]" = OrderedDict()


def normalize_query(query: str) -> str:
    """Casefolded, whitespace runs collapsed to one space, stripped."""
    return " ".join(str(query or "").casefold().split())


def clear_query_cache() -> None:
    _query_cache.clear()


def embedding_text_hash(text: str) -> str:
    """sha256 hex of the embedding text; equal to Postgres
    encode(sha256(convert_to(t, 'UTF8')), 'hex'). A row whose stored hash differs
    from the hash of the text built now is stale (H2-4.1)."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class EmbeddingService:
    def __init__(self):
        # Fail fast instead of the SDK defaults (600 s read, 2 retries)
        self.client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"), timeout=30, max_retries=1)
        self.dimensions = 3072  # text-embedding-3-large dimensions

    @property
    def model(self) -> str:
        return model_config.EMBEDDING_MODEL
        
    async def generate_embeddings(self, texts: List[str]) -> List[List[float]]:
        """One embeddings call for several texts, results in input order.

        Raises:
            ValueError: a vector is not `self.dimensions` long (a model mismatch would
            otherwise leave rows the halfvec(3072) column can't take)
        """
        response = await self.client.embeddings.create(model=self.model, input=texts)
        record_usage("embedding", response)   # H2-8.1
        vectors = [item.embedding for item in sorted(response.data, key=lambda item: item.index)]
        for vector in vectors:
            if len(vector) != self.dimensions:
                raise ValueError(f"Embedding has {len(vector)} dimensions, expected {self.dimensions}")
        return vectors

    async def generate_embedding(self, text: str) -> List[float]:
        """The 3072-float embedding of one text."""
        return (await self.generate_embeddings([text]))[0]

    async def embed_query(self, query: str) -> Optional[List[float]]:
        """The search query's vector, or None for a query too short for a semantic leg.
        Cached per normalised query (LRU, QUERY_CACHE_SIZE entries, QUERY_CACHE_TTL_S);
        a failure raises and is never cached."""
        q = normalize_query(query)
        if len(q) < SEMANTIC_MIN_CHARS:
            return None
        hit = _query_cache.get(q)
        if hit is not None and _now() - hit[0] <= QUERY_CACHE_TTL_S:
            _query_cache.move_to_end(q)
            return hit[1]
        vector = (await self.generate_embeddings([q]))[0]
        _query_cache[q] = (_now(), vector)
        _query_cache.move_to_end(q)
        while len(_query_cache) > QUERY_CACHE_SIZE:
            _query_cache.popitem(last=False)
        return vector
    
    async def generate_individual_embedding(
        self, individual: Dict[str, Any], categories: List[Dict[str, Any]]
    ) -> Tuple[List[float], str]:
        """
        Embed one person. The text comes from field_registry.build_embedding_text
        (every category, in category order, no urgency), so all four callers embed
        the same text for the same person.

        Returns:
            (embedding, text): the vector and the exact text that was embedded

        Raises:
            ValueError: the vector is not `self.dimensions` long (a model mismatch
            would otherwise leave rows that search can't compare)
        """
        text = build_embedding_text(individual, categories)
        embedding = await self.generate_embedding(text)
        if len(embedding) != self.dimensions:
            raise ValueError(f"Embedding has {len(embedding)} dimensions, expected {self.dimensions}")
        return embedding, text

    async def store_individual_embedding(
        self, supabase: Any, individual: Dict[str, Any], categories: List[Dict[str, Any]],
        *, force: bool = False,
    ) -> bool:
        """Embed one person and upsert the vector with its text, model and text hash.

        A stored row whose model and text hash match the text built now is fresh:
        no OpenAI call and no write, unless `force` (H2-4.1). Returns True when it
        embedded. Used by the save path, /generate, /generate-all and the backfill.
        """
        text = build_embedding_text(individual, categories)
        text_hash = embedding_text_hash(text)
        if not force:
            existing = (await run_db(lambda: supabase.table("individual_embeddings")
                                     .select("model, text_hash").eq("individual_id", individual["id"])
                                     .limit(1).execute())).data or []
            if existing and existing[0].get("model") == self.model and existing[0].get("text_hash") == text_hash:
                return False
        embedding = await self.generate_embedding(text)
        if len(embedding) != self.dimensions:
            raise ValueError(f"Embedding has {len(embedding)} dimensions, expected {self.dimensions}")
        source_updated_at = individual.get("updated_at") or datetime.now(timezone.utc).isoformat()
        await run_db(lambda: supabase.table("individual_embeddings").upsert({
            "individual_id": individual["id"],
            "embedding": embedding,
            "embedding_text": text,
            "model": self.model,
            "text_hash": text_hash,
            "source_updated_at": source_updated_at,
        }, on_conflict="individual_id").execute())
        return True

    async def store_interaction_embedding(self, supabase: Any, interaction: Dict[str, Any], *,
                                          force: bool = False) -> bool:
        """Embed one visit's transcript (H2-4.3); `interaction` is {id, individual_id,
        transcription}. A blank transcript is skipped; a fresh row (same model and text
        hash) is left alone unless `force`. Returns True when it embedded."""
        text = (interaction.get("transcription") or "").strip()[:MAX_CHUNK_CHARS]
        if not text:
            return False
        text_hash = embedding_text_hash(text)
        if not force:
            existing = (await run_db(lambda: supabase.table("interaction_embeddings")
                                     .select("model, text_hash").eq("interaction_id", interaction["id"])
                                     .limit(1).execute())).data or []
            if existing and existing[0].get("model") == self.model and existing[0].get("text_hash") == text_hash:
                return False
        embedding = await self.generate_embedding(text)
        await run_db(lambda: supabase.table("interaction_embeddings").upsert({
            "interaction_id": interaction["id"],
            "individual_id": interaction["individual_id"],
            "embedding": embedding,
            "model": self.model,
            "text_hash": text_hash,
        }, on_conflict="interaction_id").execute())
        return True


_service: Optional[EmbeddingService] = None


def get_embedding_service() -> EmbeddingService:
    """The process's one EmbeddingService (one AsyncOpenAI client), built on first use."""
    global _service
    if _service is None:
        _service = EmbeddingService()
    return _service
