"""The offline assistant eval (H2-5.10): tool routing and delimiting on synthetic cases."""
import asyncio

from evals.eval_assistant import load_cases, main, run_case, run_offline


def test_assistant_eval_covers_the_roadmap_cases():
    assert {c["name"] for c in load_cases()} == {
        "person_present", "person_absent", "same_first_name", "injection_in_record", "most_urgent_near_mission"}


def test_assistant_eval_offline_cases_all_pass():
    results = run_offline()
    failures = {r.name: r.problems for r in results if not r.passed}
    assert results and not failures, failures


def test_assistant_eval_detects_a_broken_delimiter(monkeypatch):
    # function_call_output_event looks delimit_reference_data up in realtime_guard at call time
    monkeypatch.setattr("services.realtime_guard.delimit_reference_data", lambda text: text)
    case = next(c for c in load_cases() if c["name"] == "injection_in_record")
    assert asyncio.run(run_case(case)).passed is False


def test_assistant_eval_detects_a_wrong_tool_call():
    case = next(c for c in load_cases() if c["name"] == "most_urgent_near_mission")
    case = {**case, "expect": {**case["expect"], "calls": [["most_urgent", {"near": "Tenderloin", "limit": 5}]]}}
    result = asyncio.run(run_case(case))
    assert result.passed is False and any("calls" in p for p in result.problems)


def test_assistant_eval_restores_retrieval():
    from services import retrieval
    before = retrieval.search_people
    run_offline()
    assert retrieval.search_people is before


def test_main_prints_one_line_per_case_and_exits_0(capsys, monkeypatch):
    monkeypatch.delenv("EVAL_LIVE", raising=False)
    assert main() == 0
    lines = capsys.readouterr().out.strip().splitlines()
    assert len(lines) == 5 and all(line.startswith("PASS ") for line in lines)
