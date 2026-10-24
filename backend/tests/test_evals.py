"""The offline evals (H2-3.7): the cached replies run through the real parsing code and
must not fall below the stored baseline. Live mode is the owner's (EVAL_LIVE=1)."""
import json
from pathlib import Path

from evals import baseline, eval_duplicates, eval_extraction
from services.transcribe_vocab import build_transcribe_prompt

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
    names |= {p[side]["name"] for p in _load("duplicate_pairs.json")["pairs"] for side in ("new", "existing")}
    for case in _load("assistant_cases.json")["cases"]:
        for value in case["retrieval"].values():
            names |= {person["name"] for person in (value if isinstance(value, list) else [value])}
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


# --- duplicates ---

def test_duplicate_eval_meets_baseline():
    m = eval_duplicates.run(live=False)
    assert m["pairs"] == 40 and baseline.compare_to_baseline("duplicates", m) == []


def test_duplicate_prompts_leak_no_sensitive_values():
    assert eval_duplicates.run(live=False)["sensitive_leaks"] == 0


def test_the_leak_check_would_catch_a_leak(monkeypatch):
    from services import duplicate_detection_service as dds
    # Break both guards (field list and sensitive filter): the check must notice
    monkeypatch.setattr(dds, "COMPARE_FIELDS", dds.COMPARE_FIELDS + ("medical_conditions", "hiv_status"))
    real_view = dds.compare_view
    monkeypatch.setattr(dds, "compare_view", lambda data, **kw: real_view(data, **{**kw, "sensitive": frozenset()}))
    assert eval_duplicates.run(live=False)["sensitive_leaks"] > 0


def test_duplicate_fixtures_are_balanced_and_cached():
    pairs = _load("duplicate_pairs.json")["pairs"]
    assert sum(p["same_person"] for p in pairs) == 20 and len(pairs) == 40
    assert set(_load("duplicate_responses.json")["responses"]) == {p["id"] for p in pairs}
    assert sum(1 for p in pairs if {"medical_conditions", "hiv_status", "substance_abuse_history"}
               & set(p["existing"]["data"])) >= 10


def test_no_fixture_name_is_in_the_transcription_prompt():
    prompt = build_transcribe_prompt().lower()
    names = {p[s]["name"] for p in _load("duplicate_pairs.json")["pairs"] for s in ("new", "existing")}
    assert not any(n.lower() in prompt for n in names)
