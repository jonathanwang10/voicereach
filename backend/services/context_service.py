"""
Context Service for the voice assistant: find the people a question names and
format their records as reference data.

- Names (C-18): runs of consecutive capitalised words that aren't on a stoplist
  of sentence starters and common words ("Any advice before I approach John Doe?"
  gives ["John Doe"]). Lower-case questions find no names.
- Matching (C-18): an exact, case-insensitive full-name match wins. Otherwise a
  person matches when a name token is a WHOLE word of their name ("John" finds
  "John Smith", not "Robert Johnson"), ranked by tokens matched, then urgency.
- Caps (C-31): the message is cut to MAX_MESSAGE_CHARS, at most MAX_NAMES names
  are looked up, and each yields at most MAX_RESULTS_PER_NAME people. Database
  calls run in a worker thread so they never block the event loop.
- Format (C-28): one JSON record per person, every string value cut to
  MAX_VALUE_CHARS. main.py wraps it as delimited reference data in a user item.
- Fields (C-34): every category, labelled with field_registry.display_label
  (cut to MAX_LABEL_CHARS), so custom fields reach the assistant. If the
  categories can't be read, a fixed list of the presets is used.
"""
import hashlib
import json
import logging
import re
import time
from typing import Any, Dict, List, Optional

from supabase import Client

from db.client import run_db

from services.field_registry import category_key, clip_value, display_label
from services.urgency_calculator import get_display_urgency_score

logger = logging.getLogger(__name__)

MAX_NAMES = 3
MAX_RESULTS_PER_NAME = 3
MAX_MESSAGE_CHARS = 2000
MAX_VALUE_CHARS = 100
MAX_LABEL_CHARS = 50
MAX_WORDS_PER_NAME = 4
_TOKEN_CANDIDATE_LIMIT = 50

# Lower-case words that start sentences or are common in questions, never names.
STOPWORDS = frozenset("""
a about after again all also am an and any anyone anything are around as ask assist at
be been before being but by call can could did do does doing don't done each else
emergency every everyone for from get give good had has have he hello help her here hey
hi him his how i i'd i'll i'm i've if in is it it's its just know let let's like may me
might more most must my need no nobody not now of ok okay on or our out person people
please really right say see she should so some someone something still tell than thank
thanks that that's the their them then there these they this those to today tomorrow
tonight up us very want was we well were what what's when where which who why will
with would yes yesterday you your
crisis medical health housing shelter homeless substance abuse mental safety protocol
individual advice approach safe danger dangerous urgent
""".split())

_WORD = re.compile(r"[A-Za-z][A-Za-z'\-]*")
_RELEVANT_FIELDS = [
    ("substance_abuse_history", "Substance Abuse"),
    ("medical_conditions", "Medical Conditions"),
    ("behavior", "Behavior"),
    ("housing_priority", "Housing Priority"),
    ("veteran_status", "Veteran Status"),
    ("age", "Age"),
    ("gender", "Gender"),
    ("height", "Height"),
    ("weight", "Weight"),
    ("additional_information", "Additional Information"),
]


def _name_tokens(name: str) -> List[str]:
    """Lower-case letter/digit runs, 2+ characters: safe inside a PostgREST filter."""
    return list(dict.fromkeys(w for w in re.split(r"[\W_]+", name.casefold()) if len(w) >= 2))


def _clip(value: Any) -> Any:
    """Numbers/bools as-is; lists joined; everything else a string cut to MAX_VALUE_CHARS
    (field_registry.clip_value, shared with services/retrieval.py)."""
    return clip_value(value, MAX_VALUE_CHARS)


class ContextService:
    """Service for retrieving individual context for voice assistant with caching"""

    def __init__(self, supabase_client: Client, cache_ttl_seconds: int = 300):
        self.supabase = supabase_client
        self.cache_ttl = cache_ttl_seconds
        self.cache: Dict[str, Dict[str, Any]] = {}

    def clear_cache(self):
        """Drop every cached lookup (called after a save so the assistant sees fresh data)."""
        self.cache.clear()

    def _get_cache_key(self, names: List[str]) -> str:
        return hashlib.md5("|".join(sorted(n.casefold() for n in names)).encode()).hexdigest()

    def _clean_expired_cache_entries(self):
        now = time.time()
        for key in [k for k, e in self.cache.items() if now - e["timestamp"] >= self.cache_ttl]:
            del self.cache[key]

    def extract_names_from_message(self, message: str) -> List[str]:
        """Up to MAX_NAMES candidate names: runs of capitalised, non-stoplist words."""
        text = (message or "")[:MAX_MESSAGE_CHARS]
        runs: List[List[str]] = []
        current: List[str] = []
        last_end = 0
        for match in _WORD.finditer(text):
            word = re.sub(r"'s$", "", match.group()).strip("'-")
            is_name = len(word) >= 2 and word[0].isupper() and word.casefold() not in STOPWORDS
            joins = (is_name and current and len(current) < MAX_WORDS_PER_NAME
                     and not text[last_end:match.start()].strip())
            if joins:
                current.append(word)
            else:
                if current:
                    runs.append(current)
                current = [word] if is_name else []
            last_end = match.end()
        if current:
            runs.append(current)

        names: List[str] = []
        for run in runs:
            name = " ".join(run)
            if name.casefold() not in (n.casefold() for n in names):
                names.append(name)
            if len(names) == MAX_NAMES:
                break
        return names

    def _lookup_name(self, name: str) -> List[Dict[str, Any]]:
        """People for one detected name, best first, at most MAX_RESULTS_PER_NAME (sync)."""
        # 1. Exact full name. `name` holds only letters, spaces, ' and - (see _WORD),
        #    so it carries no LIKE wildcard: ILIKE here is case-insensitive equality.
        exact = self.supabase.table("individuals").select("*") \
            .ilike("name", name).limit(MAX_RESULTS_PER_NAME).execute()
        if exact.data:
            return exact.data[:MAX_RESULTS_PER_NAME]

        # 2. Whole-word token matches. The filter uses letter/digit tokens only (as
        #    duplicate detection does), so no filter syntax or wildcard gets in.
        tokens = _name_tokens(name)
        if not tokens:
            return []
        rows = self.supabase.table("individuals").select("*") \
            .or_(",".join(f"name.ilike.*{t}*" for t in tokens)) \
            .order("updated_at", desc=True).limit(_TOKEN_CANDIDATE_LIMIT).execute().data or []
        scored = []
        for row in rows:
            words = set(_name_tokens(row.get("name") or ""))
            hits = sum(1 for t in tokens if t in words)
            if hits:
                scored.append((hits, get_display_urgency_score(row), row))
        scored.sort(key=lambda s: (s[0], s[1]), reverse=True)
        return [row for _, _, row in scored[:MAX_RESULTS_PER_NAME]]

    def _lookup_names(self, names: List[str]) -> List[Dict[str, Any]]:
        found: List[Dict[str, Any]] = []
        seen = set()
        for name in names[:MAX_NAMES]:
            for row in self._lookup_name(name):
                if row.get("id") not in seen:
                    seen.add(row.get("id"))
                    found.append(row)
        return found

    async def search_individuals_by_names(self, names: List[str]) -> List[Dict[str, Any]]:
        """Matching people for the detected names (cached; DB work in a worker thread).

        A database error propagates (and is not cached), so an outage isn't
        remembered as "nobody by that name" for the cache TTL.
        """
        if not names:
            return []
        self._clean_expired_cache_entries()
        key = self._get_cache_key(names)
        entry = self.cache.get(key)
        if entry and time.time() - entry["timestamp"] < self.cache_ttl:
            return entry["data"]
        found = await run_db(lambda: self._lookup_names(names))
        self.cache[key] = {"data": found, "timestamp": time.time()}
        return found

    def format_individual_context(self, individuals: List[Dict[str, Any]],
                                  categories: Optional[List[Dict[str, Any]]] = None) -> str:
        """One JSON record per line; every string value cut to MAX_VALUE_CHARS.

        Fields come from `categories` (all of them, labelled with display_label,
        each label cut to MAX_LABEL_CHARS) when given, else a fixed list. A label
        never replaces the fixed "Name", "Urgency Score" or "Last Updated" keys.
        `<` and `>` are \\u-escaped, which is still valid JSON, so no value or
        label can contain the `>>>` that ends the reference block.
        """
        if categories:
            fields = [(c["name"], display_label(c)[:MAX_LABEL_CHARS])
                      for c in categories if c.get("name") and category_key(c["name"]) != "name"]
        else:
            fields = _RELEVANT_FIELDS
        reserved = {"Name", "Urgency Score", "Last Updated"}

        lines = []
        for individual in individuals or []:
            data = individual.get("data") or {}
            record: Dict[str, Any] = {
                "Name": _clip(individual.get("name") or "Unknown"),
                "Urgency Score": get_display_urgency_score(individual),
            }
            for key, label in fields:
                value = data.get(key)
                if label in reserved or label in record:
                    continue
                if value is not None and value != "" and value != []:
                    record[label] = _clip(value)
            if individual.get("updated_at"):
                record["Last Updated"] = _clip(individual["updated_at"])
            line = json.dumps(record, ensure_ascii=False)
            lines.append(line.replace("<", "\\u003c").replace(">", "\\u003e"))
        return "\n".join(lines)

    async def _categories(self) -> Optional[List[Dict[str, Any]]]:
        """Category rows (in a worker thread), or None if they can't be read."""
        def fetch():
            return self.supabase.table("categories").select("*").order("created_at").execute().data
        try:
            return await run_db(fetch) or None
        except Exception as e:
            logger.warning("Context categories unavailable: %s", type(e).__name__)
            return None

    async def get_context_for_message(self, message: str) -> Dict[str, Any]:
        """{"context": str, "individuals_found": list, "names_detected": list}."""
        try:
            names = self.extract_names_from_message(message)
            if not names:
                return {"context": "", "individuals_found": [], "names_detected": []}
            individuals = await self.search_individuals_by_names(names)
            categories = await self._categories() if individuals else None
            return {
                "context": self.format_individual_context(individuals, categories),
                "individuals_found": individuals,
                "names_detected": names,
            }
        except Exception as e:
            logger.warning("Context extraction failed: %s", type(e).__name__)
            return {"context": "", "individuals_found": [], "names_detected": []}


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
