"""The stored eval baseline (backend/evals/baseline.json) and the comparison against it."""
import json
from pathlib import Path
from typing import Any, Dict, List

BASELINE_PATH = Path(__file__).resolve().parent / "baseline.json"
# Counts and diagnostics: reported, never compared
INFORMATIONAL = {"cases", "pairs", "dropped_values", "hallucination_rate_before_drop", "sensitive_leaks"}
LOWER_IS_BETTER = {"hallucination_rate"}
_EPSILON = 1e-9


def load_baseline() -> dict:
    return json.loads(BASELINE_PATH.read_text()) if BASELINE_PATH.exists() else {}


def write_baseline(section: str, metrics: dict) -> None:
    data = load_baseline()
    data[section] = metrics
    BASELINE_PATH.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def _flatten(node: Any, prefix: str = "") -> Dict[str, float]:
    """Numeric leaves as dotted keys ({"per_field": {"age": {"recall": 1}}} -> "per_field.age.recall")."""
    out: Dict[str, float] = {}
    if isinstance(node, dict):
        for key, value in node.items():
            out.update(_flatten(value, f"{prefix}{key}."))
    elif isinstance(node, (int, float)) and not isinstance(node, bool):
        out[prefix[:-1]] = node
    return out


def compare_to_baseline(section: str, metrics: dict, tolerance: float = 0.0) -> List[str]:
    """One message per baseline metric that got worse (or went missing)."""
    then = _flatten(load_baseline().get(section) or {})
    now = _flatten(metrics)
    problems = []
    for key, old in sorted(then.items()):
        last = key.rsplit(".", 1)[-1]
        if last in INFORMATIONAL:
            continue
        new = now.get(key)
        if new is None:
            problems.append(f"{section}.{key}: None vs baseline {old}")
        elif last in LOWER_IS_BETTER and new > old + tolerance + _EPSILON:
            problems.append(f"{section}.{key}: {new} vs baseline {old}")
        elif last not in LOWER_IS_BETTER and new < old - tolerance - _EPSILON:
            problems.append(f"{section}.{key}: {new} vs baseline {old}")
    return problems
