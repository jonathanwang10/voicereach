"""The offline evals (H2-3.7): the cached replies run through the real parsing code and
must not fall below the stored baseline. Live mode is the owner's (EVAL_LIVE=1)."""
import json
from pathlib import Path

from evals import baseline, eval_extraction

FIXTURES = Path(__file__).resolve().parents[1] / "evals" / "fixtures"
DEMO_NAMES = {"Sarah Smith", "Michael Chen", "John Doe", "Maria Garcia", "Robert Johnson", "James Brown"}


def _load(name):
    return json.loads((FIXTURES / name).read_text())


def test_extraction_eval_meets_baseline():
    metrics = eval_extraction.run(live=False)
    assert metrics["cases"] == 30
    assert baseline.compare_to_baseline("extraction", metrics) == []


def test_the_drop_rule_removes_the_planted_guesses():
    m = eval_extraction.run(live=False)
    assert m["dropped_values"] >= 4 and m["hallucination_rate"] < m["hallucination_rate_before_drop"]


def test_cached_replies_cover_every_case():
    assert set(_load("extraction_responses.json")["responses"]) == {c["id"] for c in _load("extraction_cases.json")["cases"]}


def test_eval_fixtures_are_synthetic():
    for f in FIXTURES.glob("*.json"):
        assert _load(f.name)["synthetic"] is True
    names = {c["expected"].get("name") for c in _load("extraction_cases.json")["cases"]} - {None}
    assert not names & DEMO_NAMES   # the six seed people


def test_compare_to_baseline_flags_drops_and_rises(monkeypatch):
    monkeypatch.setattr(baseline, "load_baseline", lambda: {"x": {"micro_recall": 0.8, "hallucination_rate": 0.1,
                                                                   "cases": 30}})
    assert len(baseline.compare_to_baseline("x", {"micro_recall": 0.7, "hallucination_rate": 0.1})) == 1
    assert len(baseline.compare_to_baseline("x", {"micro_recall": 0.8, "hallucination_rate": 0.2})) == 1
    assert baseline.compare_to_baseline("x", {"micro_recall": 0.8, "hallucination_rate": 0.1, "cases": 1}) == []
    assert baseline.compare_to_baseline("x", {"hallucination_rate": 0.1}) == ["x.micro_recall: None vs baseline 0.8"]
    assert baseline.compare_to_baseline("x", {"micro_recall": 0.75, "hallucination_rate": 0.1}, tolerance=0.05) == []


def test_live_mode_needs_eval_live_and_a_key(monkeypatch, capsys):
    monkeypatch.delenv("EVAL_LIVE", raising=False)
    assert eval_extraction.main(["--live"]) == 2
