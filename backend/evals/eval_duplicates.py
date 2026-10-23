"""
The duplicate eval (H2-3.7): 40 synthetic pairs, 20 the same person and 20 not.

Each pair's compare prompt is built by the real DuplicateDetectionService (minimal,
non-sensitive fields), and the reply (cached offline, `--live` asks DUPLICATE_MODEL) is
read by the real `_scores_by_candidate`. Reports precision and recall at confidence
thresholds 50/60/70/80 (production cuts at 60), and how many prompts carried a
sensitive value (must be 0).

    cd backend && python -m evals.eval_duplicates [--live] [--record] [--update-baseline] [--tolerance X]
"""
import argparse
import asyncio
import json
import os
import sys
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional

from evals.baseline import compare_to_baseline, write_baseline
from services import model_config
from services.duplicate_detection_service import DuplicateDetectionService
from services.field_registry import sensitive_keys

FIXTURES = Path(__file__).resolve().parent / "fixtures"
RESPONSES = FIXTURES / "duplicate_responses.json"
THRESHOLDS = (50, 60, 70, 80)


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def _categories() -> List[dict]:
    """The preset categories plus a sensitive hiv_status text field."""
    return _load("categories.json")["categories"] + [
        {"name": "hiv_status", "display_name": "HIV status", "type": "text", "is_sensitive": True}]


def _prompts() -> List[tuple]:
    sensitive = frozenset(sensitive_keys(_categories()))
    service = DuplicateDetectionService(None, None)
    out = []
    for pair in _load("duplicate_pairs.json")["pairs"]:
        prompt = service._build_comparison_prompt(pair["new"], [pair["existing"]], sensitive=sensitive,
                                                  new_location=pair.get("new_location"))
        out.append((pair, prompt, sensitive))
    return out


def _sensitive_values(data: Any, sensitive: frozenset) -> List[str]:
    values = []
    for key, value in (data or {}).items():
        if key in sensitive:
            values += [str(v) for v in (value if isinstance(value, list) else [value]) if isinstance(v, str) and v]
    return values


async def _live_replies(prompts: List[tuple]) -> Dict[str, Any]:
    from services.openai_service import OpenAIService
    service = OpenAIService()
    return {pair["id"]: await service.compare_individuals(prompt) for pair, prompt, _ in prompts}


def _ratio(num: int, den: int) -> Optional[float]:
    return round(num / den, 4) if den else None


def run(live: bool = False, replies: Optional[Dict[str, Any]] = None) -> dict:
    prompts = _prompts()
    if replies is None:
        replies = asyncio.run(_live_replies(prompts)) if live else _load(RESPONSES.name)["responses"]
    service = DuplicateDetectionService(None, None)
    scored, leaks = [], 0
    for pair, prompt, sensitive in prompts:
        existing = pair["existing"]
        confidence = service._scores_by_candidate(replies.get(pair["id"]), [existing]).get(existing["id"], 0)
        scored.append((pair["same_person"], confidence))
        said = prompt.casefold()
        values = _sensitive_values(pair["new"], sensitive) + _sensitive_values(existing.get("data"), sensitive)
        leaks += any(v.casefold() in said for v in values)
    metrics: Dict[str, Any] = {"pairs": len(scored), "sensitive_leaks": leaks}
    for t in THRESHOLDS:
        tp = sum(1 for same, c in scored if same and c >= t)
        fp = sum(1 for same, c in scored if not same and c >= t)
        fn = sum(1 for same, c in scored if same and c < t)
        metrics[f"at_{t}"] = {"precision": _ratio(tp, tp + fp), "recall": _ratio(tp, tp + fn)}
    return metrics


def record() -> None:
    """Ask DUPLICATE_MODEL for every pair and cache its replies (live only)."""
    replies = asyncio.run(_live_replies(_prompts()))
    RESPONSES.write_text(json.dumps({
        "synthetic": True, "source": "live", "model": model_config.DUPLICATE_MODEL,
        "recorded_at": date.today().isoformat(), "responses": replies}, indent=2) + "\n")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m evals.eval_duplicates")
    parser.add_argument("--live", action="store_true", help="ask the model (EVAL_LIVE=1 and OPENAI_API_KEY)")
    parser.add_argument("--record", action="store_true", help="with --live: cache the replies")
    parser.add_argument("--update-baseline", action="store_true", help="store the offline metrics as the baseline")
    parser.add_argument("--tolerance", type=float, default=None)
    args = parser.parse_args(argv)
    live_ok = os.getenv("EVAL_LIVE") == "1" and bool(os.getenv("OPENAI_API_KEY"))
    if (args.live or args.record) and not (args.live and live_ok):
        print("Live mode needs --live, EVAL_LIVE=1 and OPENAI_API_KEY.", file=sys.stderr)
        return 2
    if args.record:
        record()
    metrics = run(live=args.live and not args.record)
    if args.update_baseline:
        write_baseline("duplicates", run(live=False))
    print(json.dumps(metrics, indent=2))
    tolerance = args.tolerance if args.tolerance is not None else (0.05 if args.live else 0.0)
    problems = compare_to_baseline("duplicates", metrics, tolerance)
    if metrics["sensitive_leaks"]:
        problems.append(f"duplicates.sensitive_leaks: {metrics['sensitive_leaks']} prompt(s) carried a sensitive value")
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
