"""
Embedding service for semantic search using OpenAI's text-embedding-3-large model
"""
import os
import numpy as np
from typing import List, Dict, Any, Tuple
from openai import AsyncOpenAI
from sklearn.metrics.pairwise import cosine_similarity
from dotenv import load_dotenv

# Load environment variables
load_dotenv()


class EmbeddingService:
    def __init__(self):
        self.client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))
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
    
    async def generate_individual_embedding(self, individual_data: Dict[str, Any]) -> List[float]:
        """
        Generate embedding for an individual by combining all their data
        
        Args:
            individual_data: Dictionary containing individual's profile data
            
        Returns:
            List of 3072 float values representing the embedding
        """
        # Create a comprehensive text representation of the individual
        text_parts = []
        
        # Basic info
        if individual_data.get('name'):
            text_parts.append(f"Name: {individual_data['name']}")
        
        # Physical attributes
        if individual_data.get('data'):
            data = individual_data['data']
            if data.get('age'):
                text_parts.append(f"Age: {data['age']} years old")
            if data.get('height'):
                text_parts.append(f"Height: {data['height']} inches")
            if data.get('weight'):
                text_parts.append(f"Weight: {data['weight']} pounds")
            if data.get('gender'):
                text_parts.append(f"Gender: {data['gender']}")
            
            # Medical and behavioral info
            if data.get('substance_abuse_history'):
                text_parts.append(f"Substance abuse: {', '.join(data['substance_abuse_history'])}")
            if data.get('medical_conditions'):
                text_parts.append(f"Medical conditions: {', '.join(data['medical_conditions'])}")
            if data.get('mental_health_issues'):
                text_parts.append(f"Mental health: {', '.join(data['mental_health_issues'])}")
            if data.get('veteran_status'):
                text_parts.append(f"Veteran status: {data['veteran_status']}")
            if data.get('housing_status'):
                text_parts.append(f"Housing status: {data['housing_status']}")
            if data.get('behavior'):
                text_parts.append(f"Behavior: {data['behavior']}")
        
        # Urgency score info
        if individual_data.get('urgency_score'):
            text_parts.append(f"Urgency score: {individual_data['urgency_score']}")
        if individual_data.get('urgency_override'):
            text_parts.append(f"Urgency override: {individual_data['urgency_override']}")
        
        # Combine all text parts
        combined_text = " ".join(text_parts)
        
        # Generate embedding
        return await self.generate_embedding(combined_text)
    
    async def search_similar_individuals(
        self, 
        query_embedding: List[float], 
        individual_embeddings: List[Tuple[str, List[float]]], 
        top_k: int = 10,
        similarity_threshold: float = 0.7
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
        similarity_threshold: float = 0.7
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
