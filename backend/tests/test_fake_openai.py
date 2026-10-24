"""Fake-OpenAI mode for load tests (H2-8.5): never in production, every client built
through services.openai_client, and the fake answers the shapes the services read."""
import ast
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from openai import AsyncOpenAI

from services import fake_openai
from services.fake_openai import FAKE_TRANSCRIPT, FakeAsyncOpenAI, minimal_instance
from services.openai_client import fake_openai_enabled, make_async_openai
from tests.helpers import FIXTURES

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setattr(fake_openai, "FAKE_DELAYS", {k: 0 for k in fake_openai.FAKE_DELAYS})
    monkeypatch.setenv("VOICEREACH_FAKE_OPENAI", "1")
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    return make_async_openai(api_key="k")


def test_fake_is_refused_in_production(monkeypatch):
    monkeypatch.setenv("VOICEREACH_FAKE_OPENAI", "1")
    monkeypatch.setenv("ENVIRONMENT", "Production")
    with pytest.raises(RuntimeError, match="not allowed"):
        make_async_openai(api_key="k")


def test_app_import_fails_fast_when_fake_in_production():
    env = {**os.environ, "VOICEREACH_FAKE_OPENAI": "1", "ENVIRONMENT": "production", "SENTRY_DSN": ""}
    result = subprocess.run([sys.executable, "-c", "import main"], cwd=BACKEND, env=env,
                            capture_output=True, text=True, timeout=60)
    assert result.returncode != 0
    assert "VOICEREACH_FAKE_OPENAI" in result.stderr


def test_off_by_default_returns_the_real_client(monkeypatch):
    monkeypatch.delenv("VOICEREACH_FAKE_OPENAI", raising=False)
    assert fake_openai_enabled() is False
    assert isinstance(make_async_openai(api_key="k"), AsyncOpenAI)


def test_only_the_exact_value_1_turns_it_on(monkeypatch):
    monkeypatch.setenv("VOICEREACH_FAKE_OPENAI", "true")
    assert fake_openai_enabled() is False


def test_fake_returns_itself_for_with_options(fake):
    assert isinstance(fake, FakeAsyncOpenAI)
    assert fake.with_options(timeout=1, max_retries=0) is fake


async def test_fake_transcription_returns_the_fixed_text(fake):
    assert await fake.audio.transcriptions.create(model="m", file=b"", response_format="text") == FAKE_TRANSCRIPT
    response = await fake.audio.transcriptions.create(model="m", file=b"", response_format="json")
    assert response.text == FAKE_TRANSCRIPT


async def test_fake_chat_fills_a_strict_schema_with_empty_values(fake):
    schema = {"type": "object", "properties": {
        "name": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "conditions": {"type": "array", "items": {"enum": ["Diabetes"]}},
        "evidence": {"$ref": "#/$defs/ev"}}, "$defs": {"ev": {"type": ["string", "null"]}}}
    r = await fake.chat.completions.create(model="m", messages=[], response_format={
        "type": "json_schema", "json_schema": {"name": "extraction", "strict": True, "schema": schema}})
    assert json.loads(r.choices[0].message.content) == {"name": None, "conditions": [], "evidence": None}
    assert r.choices[0].message.refusal is None
    assert r.usage.total_tokens > 0


async def test_fake_chat_json_object_returns_empty_object(fake):
    r = await fake.chat.completions.create(model="m", messages=[{"role": "user", "content": "x"}],
                                           response_format={"type": "json_object"})
    assert json.loads(r.choices[0].message.content) == {}


async def test_fake_embeddings_are_deterministic_3072_floats(fake):
    a = await fake.embeddings.create(model="m", input=["one", "two"])
    b = await fake.embeddings.create(model="m", input="one")
    assert [len(item.embedding) for item in a.data] == [3072, 3072]
    assert [item.index for item in a.data] == [0, 1]
    assert b.data[0].embedding == a.data[0].embedding != a.data[1].embedding
    assert a.usage.total_tokens > 0


def test_anything_else_is_not_faked(fake):
    with pytest.raises(NotImplementedError, match="images is not faked"):
        fake.images


@pytest.mark.parametrize("schema,expected", [
    ({"enum": ["a", "b"]}, "a"),
    ({"type": "string"}, ""),
    ({"type": "integer"}, 0),
    ({"type": "number"}, 0),
    ({"type": "boolean"}, False),
    ({"type": "object", "properties": {"n": {"type": "number"}}}, {"n": 0}),
])
def test_minimal_instance(schema, expected):
    assert minimal_instance(schema) == expected


def test_no_direct_asyncopenai_construction():
    offenders = []
    for path in BACKEND.rglob("*.py"):
        rel = path.relative_to(BACKEND)
        if rel.parts[0] in ("tests", ".venv") or rel.as_posix() == "services/openai_client.py":
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call):
                fn = node.func
                name = fn.id if isinstance(fn, ast.Name) else fn.attr if isinstance(fn, ast.Attribute) else None
                if name == "AsyncOpenAI":
                    offenders.append(f"{rel}:{node.lineno}")
    assert offenders == []


async def test_transcribe_path_runs_on_the_fake(fake):
    from services.openai_service import get_openai_service
    from services.recording_pipeline import extract_stage, transcribe_stage
    service = get_openai_service()
    assert isinstance(service.client, FakeAsyncOpenAI)
    transcription = await transcribe_stage(str(FIXTURES / "audio_6s.m4a"), service)
    assert transcription == FAKE_TRANSCRIPT
    categories = [{"name": "name", "display_name": "Name", "type": "text", "is_required": True},
                  {"name": "height", "display_name": "Height", "type": "number", "is_required": True}]
    validation = await extract_stage(transcription, categories, service)
    assert validation.normalized_data == {}
