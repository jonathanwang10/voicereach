"""
The extraction schema built from the categories, and the evidence rule (H2-3.1, H2-3.3).

`build_extraction_schema` gives a Structured Outputs schema in strict mode: the root
is an object with no `anyOf`, every object sets `additionalProperties: false` and
lists every property in `required`, an optional value is a union with "null", and
the whole schema stays under OpenAI's 1,000 enum values (MAX_ENUM_VALUES). Each
category is one `{value, evidence}` object: `evidence` is the exact transcript words
the value came from.

`parse_extraction` keeps a value only when its evidence is really in the transcript
(`has_evidence`), so a guess with nothing behind it is dropped and counted. The
normaliser (`field_registry.normalize_individual_data`) still runs afterwards.
"""
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from services.field_registry import _option_labels, display_label

MAX_ENUM_VALUES = 1000

_TYPE_HINTS = {"height": " Total inches: 5 ft 10 = 70.", "weight": " Pounds."}


@dataclass
class Extraction:
    data: Dict[str, Any] = field(default_factory=dict)       # the values that have evidence
    evidence: Dict[str, Any] = field(default_factory=dict)   # their quotes (a list for multi-select)
    dropped: List[str] = field(default_factory=list)         # keys whose value (or some items) had none


def _strict(properties: Dict[str, Any], **extra) -> Dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "required": list(properties),
            "properties": properties, **extra}


def build_extraction_schema(categories: List[dict]) -> dict:
    """A strict JSON Schema with one {value, evidence} object per category, keyed by its `name`."""
    properties: Dict[str, Any] = {}
    enum_budget = MAX_ENUM_VALUES
    enums_on = True
    for category in categories:
        key = category.get("name")
        if not key:
            continue
        kind = category.get("type")
        labels = _option_labels(category) if kind in ("single_select", "multi_select") else []
        if labels and enums_on:
            cost = len(labels) + (1 if kind == "single_select" else 0)   # a single-select's null counts
            if cost > enum_budget:
                enums_on = False      # this category and every later one: no enum (Review Focus 2)
            else:
                enum_budget -= cost
        use_enum = bool(labels) and enums_on

        if kind == "multi_select":
            items: Dict[str, Any] = {"type": "string"}
            if use_enum:
                items["enum"] = list(labels)
            value: Dict[str, Any] = {"type": "array", "items": items}
            evidence: Dict[str, Any] = {"type": "array", "items": {"type": "string"}}
        else:
            if kind == "number":
                value = {"type": ["number", "null"]}
            else:
                value = {"type": ["string", "null"]}
                if kind == "single_select" and use_enum:
                    value["enum"] = list(labels) + [None]
            evidence = {"type": ["string", "null"]}
        description = f"{display_label(category)} ({kind}).{_TYPE_HINTS.get(key, '')}"
        properties[key] = _strict({"value": value, "evidence": evidence}, description=description)
    return _strict(properties)


_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
         "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]


def number_words(n: int) -> Optional[str]:
    """0-999 in words, without "and" or hyphens ("one hundred eighty", "seventy two"); else None."""
    if not isinstance(n, int) or n < 0 or n > 999:
        return None
    if n < 20:
        return _ONES[n]
    if n < 100:
        tens, ones = divmod(n, 10)
        return _TENS[tens] + (f" {_ONES[ones]}" if ones else "")
    hundreds, rest = divmod(n, 100)
    return f"{_ONES[hundreds]} hundred" + (f" {number_words(rest)}" if rest else "")


def _norm(text: str) -> str:
    """Straight quotes, casefolded, whitespace collapsed."""
    text = str(text).replace("‘", "'").replace("’", "'").replace("“", '"').replace("”", '"')
    return " ".join(text.casefold().split())


def _number_text(text: str) -> str:
    """For number words: lowered, hyphens to spaces, " and " reduced to " "."""
    return " " + " ".join(_norm(text).replace("-", " ").replace(" and ", " ").split()) + " "


def has_evidence(value: Any, evidence: Optional[str], transcript: str, field_type: str) -> bool:
    """True when the value is supported by the transcript (H2-3.3).

    Any value: its evidence is a non-empty substring of the transcript, ignoring case,
    curly quotes and whitespace. A number also passes when its digits appear (not part
    of a longer number or a decimal) or its number words do.
    """
    said = _norm(transcript)
    if isinstance(evidence, str) and _norm(evidence) and _norm(evidence) in said:
        return True
    if field_type != "number" or isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    digits = str(int(value)) if float(value).is_integer() else str(value)
    if re.search(rf"(?<![\d.]){re.escape(digits)}(?!\d|\.\d)", said):
        return True
    words = number_words(int(value)) if float(value).is_integer() else None
    return words is not None and f" {words} " in _number_text(transcript)


def parse_extraction(reply: dict, categories: List[dict], transcript: str) -> Extraction:
    """The model's {key: {value, evidence}} reply as data, keeping only supported values."""
    out = Extraction()
    reply = reply if isinstance(reply, dict) else {}
    for category in categories:
        key = category.get("name")
        wrapper = reply.get(key)
        if not key or not isinstance(wrapper, dict):
            continue
        value, evidence = wrapper.get("value"), wrapper.get("evidence")
        if value is None or value == [] or value == "":
            continue
        kind = category.get("type")
        if kind == "multi_select":
            items = value if isinstance(value, list) else [value]
            quotes = evidence if isinstance(evidence, list) else [evidence]
            kept = [(item, quotes[i] if i < len(quotes) else None) for i, item in enumerate(items)
                    if has_evidence(item, quotes[i] if i < len(quotes) else None, transcript, kind)]
            if len(kept) < len(items):
                out.dropped.append(key)
            if kept:
                out.data[key] = [item for item, _ in kept]
                out.evidence[key] = [quote for _, quote in kept]
            continue
        if not has_evidence(value, evidence, transcript, kind):
            out.dropped.append(key)
            continue
        # "six feet" comes back as 6: a schema can't stop that, so 1-9 means feet
        if key == "height" and isinstance(value, (int, float)) and not isinstance(value, bool) and 1 <= value < 10:
            value = value * 12
        out.data[key] = value
        out.evidence[key] = evidence
    return out
