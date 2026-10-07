"""
Context Service for Voice Assistant Database Integration
Handles name extraction, individual lookup, and context formatting with caching
"""
import re
import time
import hashlib
from typing import List, Dict, Any
from supabase import Client

from services.individual_service import IndividualService


class ContextService:
    """Service for retrieving individual context for voice assistant with caching"""

    def __init__(self, supabase_client: Client, cache_ttl_seconds: int = 300):
        self.supabase = supabase_client
        self.individual_service = IndividualService(supabase_client)

        # Cache configuration
        self.cache_ttl = cache_ttl_seconds  # 5 minutes default
        self.cache: Dict[str, Dict[str, Any]] = {}

        print(f"🏃 ContextService initialized with {cache_ttl_seconds}s cache TTL")

    def clear_cache(self):
        """Drop every cached lookup (called after a save so the assistant sees fresh data)."""
        self.cache.clear()

    def _get_cache_key(self, names: List[str]) -> str:
        """Generate cache key for names list"""
        names_str = "|".join(sorted(names))  # Sort for consistent keys
        return hashlib.md5(names_str.encode()).hexdigest()

    def _is_cache_valid(self, cache_entry: Dict[str, Any]) -> bool:
        """Check if cache entry is still valid based on TTL"""
        return time.time() - cache_entry["timestamp"] < self.cache_ttl

    def _clean_expired_cache_entries(self):
        """Remove expired cache entries to prevent memory leaks"""
        current_time = time.time()
        expired_keys = [
            key for key, entry in self.cache.items()
            if current_time - entry["timestamp"] >= self.cache_ttl
        ]
        for key in expired_keys:
            del self.cache[key]

        if expired_keys:
            print(f"🧹 Cleaned {len(expired_keys)} expired cache entries")

    def extract_names_from_message(self, message: str) -> List[str]:
        """
        Extract potential names from user message with improved accuracy

        Args:
            message: User's text message

        Returns:
            List of potential names found in the message
        """
        print(f"🔍 Extracting names from: '{message}'")

        # Enhanced patterns for name detection
        name_patterns = [
            r'\b[A-Z][a-z]{2,}\b',  # Standard capitalized words (min 3 chars)
            r'\b[A-Z][a-z]+\s+[A-Z][a-z]+\b',  # Full names (John Smith)
            r"(?:named|called|person)\s+([A-Z][a-z]+)",  # "named John", "called Sarah"
            r"(?:help|assist|about)\s+([A-Z][a-z]+)",  # "help John", "assist Sarah"
        ]

        potential_names = set()
        for pattern in name_patterns:
            matches = re.findall(pattern, message)
            if isinstance(matches[0] if matches else None, tuple):
                # Handle grouped captures
                for match in matches:
                    potential_names.add(match[0] if isinstance(match, tuple) else match)
            else:
                potential_names.update(matches)

        # Enhanced filter for common words that aren't names
        common_words = {
            # Question words
            'What', 'Should', 'Can', 'How', 'When', 'Where', 'Why', 'Who',
            # Action words
            'Do', 'Help', 'Tell', 'Give', 'Show', 'Find', 'Get', 'Make',
            'Take', 'Need', 'Want', 'Call', 'Ask', 'Say', 'Know',
            # Prepositions and articles
            'About', 'With', 'For', 'From', 'The', 'And', 'But', 'Or',
            # Pronouns and determiners
            'This', 'That', 'They', 'Them', 'Their', 'These', 'Those',
            'Someone', 'Anyone', 'Everyone', 'Nobody', 'Something',
            # Common context words
            'Person', 'Individual', 'People', 'Crisis', 'Emergency',
            'Medical', 'Health', 'Housing', 'Shelter', 'Homeless',
            'Substance', 'Abuse', 'Mental', 'Safety', 'Protocol'
        }

        # Split full names and add individual parts
        all_names = set()
        for name in potential_names:
            name_parts = name.split()
            for part in name_parts:
                if len(part) >= 2:  # Minimum 2 characters
                    all_names.add(part)

        # Filter out common words and short names
        filtered_names = [
            name for name in all_names
            if name not in common_words and len(name) >= 2
        ]

        # Remove duplicates while preserving order
        unique_names = []
        for name in filtered_names:
            if name not in unique_names:
                unique_names.append(name)

        print(f"🏷️ Detected names: {unique_names}")
        return unique_names

    async def search_individuals_by_names(self, names: List[str]) -> List[Dict[str, Any]]:
        """
        Search for individuals by names with caching and comprehensive logging

        Args:
            names: List of names to search for

        Returns:
            List of individual records with full data
        """
        if not names:
            print("📝 No names provided for search")
            return []

        # Clean expired cache entries periodically
        self._clean_expired_cache_entries()

        # Check cache first
        cache_key = self._get_cache_key(names)
        if cache_key in self.cache and self._is_cache_valid(self.cache[cache_key]):
            cached_result = self.cache[cache_key]["data"]
            print(f"💾 Cache HIT for names {names} - returning {len(cached_result)} individuals")
            return cached_result

        print(f"🔍 Cache MISS for names {names} - querying database")
        start_time = time.time()
        all_matches = []
        query_count = 0

        for name in names:
            # Search using case-insensitive ILIKE query
            search_term = f"%{name}%"
            print(f"📊 Searching database for: '{name}' (pattern: '{search_term}')")

            try:
                query_count += 1
                # Query individuals table directly to get full data
                response = self.supabase.table("individuals").select("*").ilike("name", search_term).execute()

                if response.data:
                    matches_found = len(response.data)
                    print(f"✅ Found {matches_found} matches for '{name}'")
                    all_matches.extend(response.data)

                    # Log individual names found
                    for individual in response.data:
                        individual_name = individual.get("name", "Unknown")
                        urgency = individual["urgency_override"] if individual.get("urgency_override") is not None else individual.get("urgency_score", 0)
                        print(f"   👤 {individual_name} (Urgency: {urgency})")
                else:
                    print(f"❌ No matches found for '{name}'")

            except Exception as e:
                print(f"❌ Database error searching for '{name}': {str(e)}")
                print(f"🔧 Query details - Table: individuals, Pattern: {search_term}")
                continue

        # Remove duplicates based on ID
        seen_ids = set()
        unique_matches = []

        for individual in all_matches:
            individual_id = individual.get("id")
            if individual_id and individual_id not in seen_ids:
                seen_ids.add(individual_id)
                unique_matches.append(individual)

        duplicates_removed = len(all_matches) - len(unique_matches)
        if duplicates_removed > 0:
            print(f"🔄 Removed {duplicates_removed} duplicate individuals")

        # Sort by urgency score (highest first), then by updated_at (most recent first)
        unique_matches.sort(
            key=lambda x: (
                x["urgency_override"] if x.get("urgency_override") is not None else x.get("urgency_score", 0),
                x.get("updated_at", "")
            ),
            reverse=True
        )

        # Limit to top 3 most relevant matches
        final_matches = unique_matches[:3]

        # Performance logging
        query_time = time.time() - start_time
        print(f"⏱️ Database search completed in {query_time:.3f}s ({query_count} queries)")
        print(f"📊 Results: {len(all_matches)} total → {len(unique_matches)} unique → {len(final_matches)} final")

        # Cache the result
        self.cache[cache_key] = {
            "data": final_matches,
            "timestamp": time.time(),
            "names": names,  # Store for debugging
            "query_count": query_count,
            "query_time": query_time
        }
        print(f"💾 Cached result for {names} (TTL: {self.cache_ttl}s)")

        return final_matches

    def format_individual_context(self, individuals: List[Dict[str, Any]]) -> str:
        """
        Format individual data into context string for AI assistant

        Args:
            individuals: List of individual database records

        Returns:
            Formatted context string
        """
        if not individuals:
            return ""

        context_parts = []

        for individual in individuals:
            name = individual.get("name", "Unknown")
            urgency_score = individual.get("urgency_score", 0)
            urgency_override = individual.get("urgency_override")
            data = individual.get("data", {})

            # Start with basic info
            context = f"Individual: {name}\n"

            # Add urgency information
            display_urgency = urgency_override if urgency_override is not None else urgency_score
            context += f"- Urgency Score: {display_urgency}"
            if urgency_override is not None:
                context += f" (Override: {urgency_override}, Calculated: {urgency_score})"
            context += "\n"

            # Add relevant data fields if they exist
            relevant_fields = [
                ('substance_abuse_history', 'Substance Abuse'),
                ('medical_conditions', 'Medical Conditions'),
                ('behavior', 'Behavior'),
                ('housing_priority', 'Housing Priority'),
                ('veteran_status', 'Veteran Status'),
                ('age', 'Age'),
                ('gender', 'Gender'),
                ('height', 'Height'),
                ('weight', 'Weight')
            ]

            for field_key, field_label in relevant_fields:
                field_value = data.get(field_key)
                if field_value is not None and field_value != "" and field_value != []:
                    # Format list values
                    if isinstance(field_value, list):
                        field_value = ", ".join(str(v) for v in field_value)
                    context += f"- {field_label}: {field_value}\n"

            # Add last interaction info if available
            updated_at = individual.get("updated_at")
            if updated_at:
                context += f"- Last Updated: {updated_at}\n"

            context_parts.append(context.strip())

        # Join all individuals with double line breaks
        return "\n\n".join(context_parts)

    async def get_context_for_message(self, message: str) -> Dict[str, Any]:
        """
        Main method to extract context for a user message with comprehensive logging

        Args:
            message: User's message text

        Returns:
            Dict with context string and individuals found
        """
        print(f"🚀 Starting context extraction for message: '{message}'")
        start_time = time.time()

        try:
            # Extract names from the message
            print("🔍 Step 1: Extracting names from message...")
            names = self.extract_names_from_message(message)

            if not names:
                print("📝 No names detected - returning empty context")
                processing_time = time.time() - start_time
                print(f"⏱️ Total processing time: {processing_time:.3f}s")
                return {
                    "context": "",
                    "individuals_found": [],
                    "names_detected": []
                }

            print(f"🏷️ Step 2: Found {len(names)} names: {names}")

            # Search for individuals
            print("📊 Step 3: Searching database for individuals...")
            individuals = await self.search_individuals_by_names(names)

            if not individuals:
                print("❌ No individuals found in database")
                processing_time = time.time() - start_time
                print(f"⏱️ Total processing time: {processing_time:.3f}s")
                return {
                    "context": "",
                    "individuals_found": [],
                    "names_detected": names
                }

            print(f"✅ Step 4: Found {len(individuals)} individuals")

            # Format context
            print("📄 Step 5: Formatting context for AI assistant...")
            context = self.format_individual_context(individuals)

            context_length = len(context)
            context_lines = context.count('\n') + 1 if context else 0
            print(f"📝 Context formatted: {context_length} chars, {context_lines} lines")

            processing_time = time.time() - start_time
            print(f"⏱️ Total processing time: {processing_time:.3f}s")

            # Summary log
            individual_names = [ind.get("name", "Unknown") for ind in individuals]
            print(f"✅ Context extraction complete - Names: {names} → Individuals: {individual_names}")

            return {
                "context": context,
                "individuals_found": individuals,
                "names_detected": names
            }

        except Exception as e:
            processing_time = time.time() - start_time
            print(f"❌ CRITICAL ERROR in get_context_for_message: {str(e)}")
            print(f"🔧 Error details:")
            print(f"   - Message: '{message}'")
            print(f"   - Processing time before error: {processing_time:.3f}s")
            print(f"   - Error type: {type(e).__name__}")
            print(f"   - Cache entries: {len(self.cache)}")

            # Fallback with detailed error info
            return {
                "context": "",
                "individuals_found": [],
                "names_detected": [],
                "error": str(e),
                "error_type": type(e).__name__,
                "processing_time": processing_time
            }


_context_service = None


def get_context_service(supabase):
    """Return one shared ContextService so its cache persists across calls."""
    global _context_service
    if _context_service is None:
        _context_service = ContextService(supabase)
    return _context_service


def invalidate_context_cache():
    """Clear the shared ContextService cache, if one has been created."""
    if _context_service is not None:
        _context_service.clear_cache()
