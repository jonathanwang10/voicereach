"""
The assistant eval (H2-5.10): five synthetic cases for the realtime tools.

Offline (the default, and in CI through pytest) each case's upstream events go through
the real ToolCallRouter with `services.retrieval` patched to the fixture values. It
checks the retrieval calls, that every tool output is delimited REFERENCE DATA with
exactly one `<<<` and one `>>>`, that the router ends by asking for a response, and
that nothing goes as a system message.

Live (`EVAL_LIVE=1` and `OPENAI_API_KEY`) asks the realtime model itself, text only,
with the same session config and fixture retrieval values, and checks its answer.

    cd backend && python -m evals.eval_assistant
"""
import asyncio
import inspect
import json
import os
import sys
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch

from services import model_config, retrieval
from services.assistant_tools import TOOL_NAMES, ToolCallRouter
from services.realtime_guard import REFERENCE_DATA_HEADER

FIXTURES = Path(__file__).resolve().parent / "fixtures"
LIVE_TIMEOUT_SECONDS = 60


@dataclass
class CaseResult:
    name: str
    passed: bool
    problems: list[str] = field(default_factory=list)


def load_cases(path: Path = FIXTURES / "assistant_cases.json") -> list[dict]:
    return json.loads(path.read_text())["cases"]


@contextmanager
def _fixture_retrieval(case: dict):
    """Every tool's retrieval function patched: the case's value, else nothing found.
    Yields the calls made, in order, each as [tool, {parameter: value}]."""
    calls: list = []

    def fake(name: str):
        value = case["retrieval"].get(name, None if name == "get_person" else [])
        signature = inspect.signature(getattr(retrieval, name))

        async def tool(*args, **kwargs):
            calls.append([name, dict(signature.bind(*args, **kwargs).arguments)])
            if isinstance(value, dict) and set(value) == {"raise"}:
                raise RuntimeError(f"fixture {value['raise']}")
            return value
        return tool

    with patch.multiple(retrieval, **{name: fake(name) for name in TOOL_NAMES}):
        yield calls


def _check_outputs(case: dict, emitted: list[dict]) -> list[str]:
    problems = []
    call_ids = [e["call_id"] for e in case["upstream_events"]
                if e.get("type") == "response.function_call_arguments.done"]
    outputs = [e["item"] for e in emitted
               if e.get("type") == "conversation.item.create" and e.get("item", {}).get("type") == "function_call_output"]
    if [o.get("call_id") for o in outputs] != call_ids:
        problems.append(f"outputs for {[o.get('call_id') for o in outputs]}, expected {call_ids}")
    for out in outputs:
        text = out.get("output", "")
        if not text.startswith(REFERENCE_DATA_HEADER + "\n<<<\n") or not text.endswith("\n>>>"):
            problems.append(f"output for {out.get('call_id')} is not delimited reference data")
        if text.count("<<<") != 1 or text.count(">>>") != 1:
            problems.append(f"output for {out.get('call_id')} has {text.count('<<<')} '<<<' and {text.count('>>>')} '>>>'")
        for needle in case["expect"].get("output_contains", []):
            if needle not in text:
                problems.append(f"output lacks {needle!r}")
        for needle in case["expect"].get("output_not_contains", []):
            if needle in text:
                problems.append(f"output contains {needle!r}")
    if not emitted or emitted[-1].get("type") != "response.create":
        problems.append("the router did not end with response.create")
    if any('"role": "system"' in json.dumps(e) for e in emitted):
        problems.append("a frame went as a system message")
    return problems


async def run_case(case: dict) -> CaseResult:
    router = ToolCallRouter()
    emitted: list[dict] = []
    with _fixture_retrieval(case) as calls:
        for event in case["upstream_events"]:
            emitted += await router.on_upstream_event(event)
    problems = []
    if calls != case["expect"]["calls"]:
        problems.append(f"calls {calls}, expected {case['expect']['calls']}")
    problems += _check_outputs(case, emitted)
    return CaseResult(case["name"], not problems, problems)


def run_offline() -> list[CaseResult]:
    return [asyncio.run(run_case(case)) for case in load_cases()]


async def run_live(case: dict) -> CaseResult:
    """Ask the realtime model (text only) with the fixture retrieval values."""
    import websockets
    from main import build_session_config

    session = {**build_session_config(), "output_modalities": ["text"]}
    url = f"wss://api.openai.com/v1/realtime?model={model_config.REALTIME_MODEL}"
    headers = {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"}
    router = ToolCallRouter()
    answer: list[str] = []
    with _fixture_retrieval(case):
        async with websockets.connect(url, additional_headers=headers) as ws:
            await ws.send(json.dumps({"type": "session.update", "session": session}))
            await ws.send(json.dumps({"type": "conversation.item.create", "item": {
                "type": "message", "role": "user", "content": [{"type": "input_text", "text": case["question"]}]}}))
            await ws.send(json.dumps({"type": "response.create"}))
            async with asyncio.timeout(LIVE_TIMEOUT_SECONDS):
                while True:
                    event = json.loads(await ws.recv())
                    if event.get("type") == "response.output_text.delta":
                        answer.append(event.get("delta", ""))
                    replies = await router.on_upstream_event(event)
                    for reply in replies:
                        await ws.send(json.dumps(reply))
                    if event.get("type") == "response.done" and not replies:
                        break
    text = "".join(answer).casefold()
    problems = [f"answer lacks {needle!r}" for needle in case["expect"].get("live_answer_contains", [])
                if needle.casefold() not in text]
    return CaseResult(case["name"], not problems, problems)


def main() -> int:
    live = os.getenv("EVAL_LIVE") == "1"
    if live and not os.getenv("OPENAI_API_KEY"):
        print("EVAL_LIVE=1 needs OPENAI_API_KEY")
        return 2
    results = [asyncio.run(run_live(case)) for case in load_cases()] if live else run_offline()
    for result in results:
        print(f"PASS {result.name}" if result.passed else f"FAIL {result.name}: {'; '.join(result.problems)}")
    return 0 if all(r.passed for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
