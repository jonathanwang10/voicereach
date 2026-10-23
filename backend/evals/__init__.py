"""Offline-by-default evals for extraction and duplicate detection (H2-3.7).

Run from backend/: `python -m evals.eval_extraction` (add `--live` with EVAL_LIVE=1 and an
OpenAI key to call the model). backend/tests/test_evals.py runs the offline mode in CI and
fails when a metric drops below backend/evals/baseline.json.
"""
