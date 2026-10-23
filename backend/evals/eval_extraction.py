"""
The extraction eval (H2-3.7): 30 synthetic transcripts with expected fields.

Offline (the default) replays the cached replies in fixtures/extraction_responses.json
through the real code: parse_extraction (the evidence drop rule), then the normaliser.
Live (`--live`, needs EVAL_LIVE=1 and OPENAI_API_KEY) asks the model for each case.

    cd backend && python -m evals.eval_extraction [--live] [--record] [--update-baseline] [--tolerance X]

Metrics: per-field precision and recall, micro precision/recall, and the hallucination
rate (values present that the transcript doesn't state), before and after the drop rule.
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
from services.category_schema import parse_extraction
from services.validation_helper import validate_categorized_data

FIXTURES = Path(__file__).resolve().parent / "fixtures"
RESPONSES = FIXTURES / "extraction_responses.json"


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def _present(value: Any) -> bool:
    return value is not None and value != "" and value != []


def _equal(a: Any, b: Any) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return abs(a - b) <= 0.5
    if isinstance(a, list) and isinstance(b, list):
        return {str(x).casefold().strip() for x in a} == {str(x).casefold().strip() for x in b}
    return str(a).casefold().strip() == str(b).casefold().strip()


def _ratio(num: int, den: int) -> Optional[float]:
    return round(num / den, 4) if den else None


async def _live_replies(cases: List[dict], categories: List[dict]) -> Dict[str, dict]:
    from services.openai_service import OpenAIService
    service = OpenAIService()
    return {c["id"]: await service._extraction_reply(c["transcript"], categories) for c in cases}


def run(live: bool = False, replies: Optional[Dict[str, dict]] = None) -> dict:
    """The metrics over every case, from the cached replies (or live ones)."""
    categories = _load("categories.json")["categories"]
    cases = _load("extraction_cases.json")["cases"]
    if replies is None:
        replies = asyncio.run(_live_replies(cases, categories)) if live else _load(RESPONSES.name)["responses"]
    keys = [c["name"] for c in categories]
    counts = {k: {"tp": 0, "fp": 0, "fn": 0, "support": 0} for k in keys}
    present = hallucinated = raw_present = raw_hallucinated = dropped = 0

    for case in cases:
        reply = replies.get(case["id"]) or {}
        extraction = parse_extraction(reply, categories, case["transcript"])
        dropped += len(extraction.dropped)
        predicted = validate_categorized_data(extraction.data, categories).normalized_data
        expected = validate_categorized_data(case["expected"], categories).normalized_data
        for k in keys:
            p, e = predicted.get(k), expected.get(k)
            if _present(e):
                counts[k]["support"] += 1
            if _present(p):
                present += 1
                hallucinated += not _present(e)
                if _present(e) and _equal(p, e):
                    counts[k]["tp"] += 1
                else:
                    counts[k]["fp"] += 1
            if _present(e) and not (_present(p) and _equal(p, e)):
                counts[k]["fn"] += 1
            raw = (reply.get(k) or {}).get("value") if isinstance(reply.get(k), dict) else None
            if _present(raw):
                raw_present += 1
                raw_hallucinated += not _present(e)

    tp = sum(c["tp"] for c in counts.values())
    fp = sum(c["fp"] for c in counts.values())
    fn = sum(c["fn"] for c in counts.values())
    return {
        "cases": len(cases),
        "per_field": {k: {"precision": _ratio(c["tp"], c["tp"] + c["fp"]),
                          "recall": _ratio(c["tp"], c["tp"] + c["fn"]),
                          "support": c["support"]} for k, c in counts.items()},
        "micro_precision": _ratio(tp, tp + fp),
        "micro_recall": _ratio(tp, tp + fn),
        "hallucination_rate": _ratio(hallucinated, present) or 0.0,
        "hallucination_rate_before_drop": _ratio(raw_hallucinated, raw_present) or 0.0,
        "dropped_values": dropped,
    }


def record() -> None:
    """Ask the model for every case and cache its replies (live only)."""
    categories = _load("categories.json")["categories"]
    cases = _load("extraction_cases.json")["cases"]
    replies = asyncio.run(_live_replies(cases, categories))
    RESPONSES.write_text(json.dumps({
        "synthetic": True, "source": "live", "model": model_config.CHAT_MODEL,
        "recorded_at": date.today().isoformat(), "responses": replies}, indent=2) + "\n")


def _live_allowed() -> bool:
    return os.getenv("EVAL_LIVE") == "1" and bool(os.getenv("OPENAI_API_KEY"))


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m evals.eval_extraction")
    parser.add_argument("--live", action="store_true", help="ask the model (EVAL_LIVE=1 and OPENAI_API_KEY)")
    parser.add_argument("--record", action="store_true", help="with --live: cache the replies")
    parser.add_argument("--update-baseline", action="store_true", help="store the offline metrics as the baseline")
    parser.add_argument("--tolerance", type=float, default=None)
    args = parser.parse_args(argv)
    if (args.live or args.record) and not (args.live and _live_allowed()):
        print("Live mode needs --live, EVAL_LIVE=1 and OPENAI_API_KEY.", file=sys.stderr)
        return 2
    if args.record:
        record()
    metrics = run(live=args.live and not args.record)
    if args.update_baseline:
        write_baseline("extraction", run(live=False))
    print(json.dumps(metrics, indent=2))
    tolerance = args.tolerance if args.tolerance is not None else (0.05 if args.live else 0.0)
    problems = compare_to_baseline("extraction", metrics, tolerance)
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
