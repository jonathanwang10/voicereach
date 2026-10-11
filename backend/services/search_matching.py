"""
The one text matcher for every search path (C-01, R-2).

Used by GET /api/individuals (list search), POST /api/embeddings/search (the
exact/value leg of the hybrid search) and duplicate detection (candidate step 3).

It matches the person's name as a case-insensitive substring, or any string
value / list item inside `data` at the START of a word (case-insensitive), so
"male" matches "Male" but not "Female", while "diab" still matches "Diabetes".
It never looks at dict keys or at Python's
str(dict) repr, so words like "veteran", "age" or "none" no longer match every
person through keys such as `veteran_status` or a `None` literal.

Runs in Python over the whole table: fine for a demo, to about 1-5k people.
"""
import re
from typing import Any, Iterator, Literal, Optional

# Ranking: a name match beats a value match, which beats a semantic match.
MATCH_TIER = {"name": 0, "value": 1, "semantic": 2}


def iter_value_strings(data: Any) -> Iterator[str]:
    """Yield every string leaf in `data`: dict VALUES and list items, recursively. Never keys."""
    if isinstance(data, str):
        yield data
    elif isinstance(data, dict):
        for value in data.values():
            yield from iter_value_strings(value)
    elif isinstance(data, (list, tuple)):
        for item in data:
            yield from iter_value_strings(item)


def match_individual(query: str, individual: dict) -> Optional[Literal["name", "value"]]:
    """'name' if the query is in the name, 'value' if it is in any data value, else None.

    Name: case-insensitive substring ("ann" matches "Joanne").
    Value: case-insensitive, starting at a word start (not preceded by a letter,
    digit or underscore). A blank query matches nothing.
    """
    needle = (query or "").strip().casefold()
    if not needle:
        return None
    name = individual.get("name")
    if isinstance(name, str) and needle in name.casefold():
        return "name"
    at_word_start = re.compile(r"(?<!\w)" + re.escape(query.strip()), re.IGNORECASE)
    if any(at_word_start.search(s) for s in iter_value_strings(individual.get("data"))):
        return "value"
    return None
