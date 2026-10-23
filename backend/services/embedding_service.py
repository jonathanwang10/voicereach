"""
Embedding service for semantic search using OpenAI's text-embedding-3-large model
"""
import os
import numpy as np
from typing import List, Dict, Any, Tuple
from openai import AsyncOpenAI
from sklearn.metrics.pairwise import cosine_similarity
from dotenv import load_dotenv

from db.client import run_db
from services.field_registry import build_embedding_text

# Load environment variables
load_dotenv()

# Cosine-similarity cut-off for semantic search; the one value every caller defaults to.
DEFAULT_SIMILARITY_THRESHOLD = 0.15


class EmbeddingService:
    def __init__(self):
        # Fail fast instead of the SDK defaults (600 s read, 2 retries)
        self.client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"), timeout=30, max_retries=1)
        self.model = "text-embedding-3-large"
        self.dimensions = 3072  # text-embedding-3-large dimensions
        
    async def generate_embedding(self, text: str) -> List[float]:
        """
        Generate embedding for a given text using OpenAI's text-embedding-3-large
        
        Args:
            text: Text to embed
            
        Returns:
            List of 3072 float values representing the embedding
        """
        try:
            response = await self.client.embeddings.create(
                model=self.model,
                input=text
            )
            return response.data[0].embedding
        except Exception as e:
            raise Exception(f"Failed to generate embedding: {str(e)}")
    
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
        self, supabase: Any, individual: Dict[str, Any], categories: List[Dict[str, Any]]
    ) -> int:
        """Embed one person and upsert the vector with the text it was built from.
        Used by the save path, /generate, /generate-all and the backfill script.
        Returns the vector length."""
        embedding, text = await self.generate_individual_embedding(individual, categories)
        await run_db(lambda: supabase.table("individual_embeddings").upsert({
            "individual_id": individual["id"],
            "embedding_data": embedding,
            "embedding_text": text,
        }, on_conflict="individual_id").execute())
        return len(embedding)

    async def search_similar_individuals(
        self, 
        query_embedding: List[float], 
        individual_embeddings: List[Tuple[str, List[float]]], 
        top_k: int = 10,
        similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD
    ) -> List[Dict[str, Any]]:
        """
        Find similar individuals using cosine similarity
        
        Args:
            query_embedding: Embedding of the search query
            individual_embeddings: List of (individual_id, embedding) tuples
            top_k: Number of top results to return
            similarity_threshold: Minimum similarity score to include
            
        Returns:
            List of similar individuals with similarity scores
        """
        if not individual_embeddings:
            return []
        
        # Convert embeddings to numpy arrays
        query_array = np.array(query_embedding).reshape(1, -1)
        individual_arrays = np.array([emb for _, emb in individual_embeddings])
        
        # Calculate cosine similarities
        similarities = cosine_similarity(query_array, individual_arrays).flatten()
        
        # Create results with individual IDs and similarity scores
        results = []
        for i, (individual_id, _) in enumerate(individual_embeddings):
            similarity = float(similarities[i])
            if similarity >= similarity_threshold:
                results.append({
                    'individual_id': individual_id,
                    'similarity_score': similarity
                })
        
        # Sort by similarity score (highest first) and take top_k
        results.sort(key=lambda x: x['similarity_score'], reverse=True)
        return results[:top_k]
    
    async def semantic_search(
        self, 
        query: str, 
        individual_embeddings: List[Tuple[str, List[float]]], 
        top_k: int = 10,
        similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD
    ) -> List[Dict[str, Any]]:
        """
        Perform semantic search using query text and individual embeddings
        
        Args:
            query: Search query text
            individual_embeddings: List of (individual_id, embedding) tuples
            top_k: Number of top results to return
            similarity_threshold: Minimum similarity score to include
            
        Returns:
            List of similar individuals with similarity scores
        """
        # Generate embedding for the search query
        query_embedding = await self.generate_embedding(query)
        
        # Search for similar individuals
        return await self.search_similar_individuals(
            query_embedding, 
            individual_embeddings, 
            top_k,
            similarity_threshold
        )
