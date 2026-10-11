"""
Field registry: one place that knows how category keys and field values are
normalised, so voice extraction, manual entry and the save path agree.

`normalize_individual_data` is applied to GPT output in /api/transcribe and to
every POST /api/individuals before the diff and the urgency calculation, so
`None`, `""` and whitespace-only values never reach the stored `data`.
"""
import math
import re
from typing import Any, Dict, List, Optional, Tuple

# Number categories whose values must stay within 0-300 (inches / pounds).
BOUNDED_FIELDS = {"height": 300, "weight": 300}

_CM_PER_INCH = 2.54


def category_key(name: str) -> str:
    """Canonical key for a category name: strip, lower, runs of whitespace/hyphens -> "_".

    "HIV status" -> "hiv_status", "Housing_status" -> "housing_status".
    """
    return re.sub(r"[\s\-]+", "_", str(name).strip().lower())


def _number(value: Any) -> Optional[float]:
    """A finite float from an int/float/numeric string, else None. Booleans are not numbers."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        num = float(value)
    elif isinstance(value, str):
        try:
            num = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    return num if math.isfinite(num) else None


def _bare_height(num: float) -> float:
    """A bare height number: 1-9 means feet, anything else is inches."""
    return num * 12 if 1 <= num < 10 else num


# Unicode primes and curly quotes are read as ' (feet) and " (inches).
_QUOTE_TRANSLATION = str.maketrans({"\u2032": "'", "\u2019": "'", "\u2018": "'",
                                    "\u2033": '"', "\u201d": '"', "\u201c": '"'})


def parse_height_inches(value: Any) -> Optional[float]:
    """Parse a height into inches.

    An int/float is already inches and is returned unchanged (rounded to 0.1),
    so normalising twice never turns 9 inches into 9 feet. Only a bare numeric
    STRING with no unit ("6", "5.5") applies the 1-9-means-feet rule. "5'10",
    "5′10″", "5 ft 10", "5.5 feet", "5, 10", "178 cm" and "1.78 m" are
    understood; any other number is inches. Returns None if unparseable.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        num = _number(value)
        return None if num is None else round(num, 1)
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().translate(_QUOTE_TRANSLATION)

    num = _number(text)
    if num is not None:
        return round(_bare_height(num), 1)

    # Metric: "178 cm", "180 centimeters", "1.78 m", "1.78 metres"
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:cm|centimet(?:er|re)s?)\b", text, re.I)
    if match:
        return round(float(match.group(1)) / _CM_PER_INCH, 1)
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:m|met(?:er|re)s?)\b", text, re.I)
    if match:
        return round(float(match.group(1)) * 100 / _CM_PER_INCH, 1)

    # Feet with optional inches: "5'10", "5 ft 10", "5 feet, 10 inches", "5.5 feet".
    # The inches part must not run into further digits ("6 ft 180 lbs" is 72).
    match = re.search(
        r"(\d+(?:\.\d+)?)\s*(?:feet|foot|ft|')\s*,?\s*"
        r"(?:(\d{1,2}(?:\.\d+)?)(?![\d.])\s*(?:inches|inch|in|\")?)?",
        text, re.I,
    )
    if match:
        feet = float(match.group(1))
        inches = float(match.group(2)) if match.group(2) else 0.0
        if inches >= 12:
            inches = 0.0
        return round(feet * 12 + inches, 1)

    # "5, 10" (feet, inches)
    match = re.fullmatch(r"(\d)\s*,\s*(\d{1,2}(?:\.\d+)?)", text)
    if match and float(match.group(2)) < 12:
        return round(int(match.group(1)) * 12 + float(match.group(2)), 1)

    # "70 inches", "70 in"
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:inches|inch|in)\b", text, re.I)
    if match:
        return round(float(match.group(1)), 1)

    # Any other single number, e.g. "about 70" (inches; only a bare string is feet)
    match = re.search(r"\d+(?:\.\d+)?", text)
    if match:
        return round(float(match.group(0)), 1)
    return None


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str) and not value.strip():
        return True
    if isinstance(value, (list, dict)) and not value:
        return True
    return False


def _clean_generic(value: Any) -> Any:
    """Type-agnostic cleaning: strip strings, drop empty list items. Returns None if empty."""
    if isinstance(value, str):
        value = value.strip()
    elif isinstance(value, list):
        value = [v.strip() if isinstance(v, str) else v for v in value if not _is_empty(v)]
    return None if _is_empty(value) else value


def _int_if_integral(num: float) -> Any:
    return int(num) if float(num).is_integer() else num


def _option_labels(category: dict) -> List[str]:
    labels = []
    for option in category.get("options") or []:
        label = option.get("label") if isinstance(option, dict) else option
        if isinstance(label, str):
            labels.append(label)
    return labels


def _match_label(value: Any, labels: List[str]) -> Optional[str]:
    wanted = str(value).strip().lower()
    for label in labels:
        if label.lower() == wanted:
            return label
    return None


def _normalize_value(value: Any, category: Optional[dict]) -> Tuple[Any, Optional[str]]:
    """Return (clean_value, error_message). On error the cleaned raw value is kept so the
    worker can see and fix it; the caller reports the error."""
    value = _clean_generic(value)
    if value is None or category is None:
        return value, None

    field_type = category.get("type")
    key = category_key(category["name"])

    if field_type == "number":
        num = parse_height_inches(value) if key == "height" else _number(value)
        if num is None:
            return value, f"Invalid number: {value}"
        if num < 0:
            return value, f"Value {_int_if_integral(num)} is negative"
        limit = BOUNDED_FIELDS.get(key)
        if limit is not None and num > limit:
            return value, f"Value {_int_if_integral(num)} exceeds maximum of {limit}"
        return _int_if_integral(num), None

    if field_type == "single_select":
        labels = _option_labels(category)
        if not labels:
            return value, None
        label = _match_label(value, labels)
        if label is None:
            return value, f"Invalid option '{value}'. Must be one of: {', '.join(labels)}"
        return label, None

    if field_type == "multi_select":
        items = value.split(",") if isinstance(value, str) else value
        if not isinstance(items, list):
            items = [items]
        items = [i.strip() if isinstance(i, str) else i for i in items if not _is_empty(i)]
        labels = _option_labels(category)
        if not labels:
            return (items or None), None
        chosen = set()
        for item in items:
            label = _match_label(item, labels)
            if label is None:
                return items, f"Invalid option '{item}' in selection"
            chosen.add(label)
        # Emit in the category's option order so re-ordering is never a "change"
        result = [label for label in labels if label in chosen]
        return (result or None), None

    if field_type == "location":
        return value, None

    # text / date
    if isinstance(value, list):
        return ", ".join(str(v) for v in value), None
    if isinstance(value, dict):
        return value, "Expected text, got an object"
    return str(value).strip(), None


def normalize_individual_data(data: dict, categories: list) -> Tuple[Dict[str, Any], List[Dict[str, str]]]:
    """Normalise a field dict against the category definitions.

    Returns (clean_data, errors) with errors = [{"field": str, "message": str}].
    - Keys are matched via category_key to the category's `name`; unknown keys are
      kept as given (after the same generic cleaning).
    - None / "" / whitespace / [] are dropped; strings are stripped.
    - number: int if integral else float; < 0 is an error; height/weight > 300 is an
      error; height is parsed with parse_height_inches (a bare numeric string 1-9 is
      feet; an int/float is already inches, so normalising is idempotent).
    - single_select: case-insensitive label match -> canonical label, else an error.
    - multi_select: a string is split on ","; items matched case-insensitively to
      canonical labels, de-duplicated and emitted in the category's option order;
      an unknown item is an error.
    - text/date: stripped string; location: kept as-is.
    On an error the cleaned raw value is kept in clean_data so it can be shown and fixed.
    """
    by_key = {category_key(c["name"]): c for c in categories or [] if c.get("name")}
    clean: Dict[str, Any] = {}
    errors: List[Dict[str, str]] = []
    exact: set = set()

    for raw_key, raw_value in (data or {}).items():
        category = by_key.get(category_key(raw_key)) if isinstance(raw_key, str) else None
        out_key = category["name"] if category else raw_key
        # If both "Name" and "name" arrive, the exact spelling wins.
        if out_key in exact:
            continue
        value, error = _normalize_value(raw_value, category)
        if value is None:
            continue
        if raw_key == out_key:
            exact.add(out_key)
        errors = [e for e in errors if e["field"] != out_key]
        clean[out_key] = value
        if error:
            errors.append({"field": out_key, "message": error})

    return clean, errors


# --- Category-driven consumers: labels, embedding text, export columns ----------------

def display_label(category: dict) -> str:
    """The label people see: `display_name`, else the key title-cased ("hiv_status" -> "Hiv Status")."""
    label = str(category.get("display_name") or "").strip()
    return label or str(category.get("name") or "").replace("_", " ").title()


def format_field_value(value: Any) -> str:
    """One field value as plain text: lists joined with ", ", a location as its
    address (else "lat, lng"), everything else str(). Empty values give ""."""
    if _is_empty(value):
        return ""
    if isinstance(value, (list, tuple)):
        return ", ".join(str(v) for v in value if not _is_empty(v))
    if isinstance(value, dict):
        address = value.get("address")
        if isinstance(address, str) and address.strip():
            return address.strip()
        lat, lng = value.get("latitude"), value.get("longitude")
        return f"{lat}, {lng}" if lat is not None and lng is not None else ""
    return str(value).strip()


def build_embedding_text(individual: dict, categories: list) -> str:
    """The text embedded (and stored as `embedding_text`) for one person.

    "Name: Ann Lee. Height: 64; HIV status: Negative; ..." -- every non-empty
    `data` value, labelled with display_label, in category order; data keys with
    no category follow, labelled from the key. Urgency is never included (it is
    not something a search describes, and it changes on every override).
    """
    data = individual.get("data") or {}
    parts: List[str] = []
    used = {"name"}
    for category in categories or []:
        key = category.get("name")
        if not key or key in used:
            continue
        used.add(key)
        text = format_field_value(data.get(key))
        if text:
            parts.append(f"{display_label(category)}: {text}")
    for key, value in data.items():
        if key in used or not isinstance(key, str):
            continue
        text = format_field_value(value)
        if text:
            parts.append(f"{display_label({'name': key})}: {text}")
    name = str(individual.get("name") or data.get("name") or "Unknown").strip()
    return f"Name: {name}." + (" " + "; ".join(parts) if parts else "")


def export_columns(categories: list) -> List[Tuple[str, str]]:
    """[(key, header)] for every category: name first, then required, then other
    presets, then the rest, each group in the given (creation) order."""
    unique: Dict[str, dict] = {}
    for category in categories or []:
        if category.get("name") and category["name"] not in unique:
            unique[category["name"]] = category
    ordered = sorted(unique.values(), key=lambda c: (
        c["name"] != "name", not c.get("is_required"), not c.get("is_preset")))
    return [(c["name"], display_label(c)) for c in ordered]
