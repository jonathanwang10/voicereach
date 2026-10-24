"""
A stand-in for AsyncOpenAI in load tests (H2-8.5): the three calls the services make,
each after a fixed delay, with answers in the shapes they read. Extraction gets the
schema's emptiest instance (every value null), so a recording reaches review with the
required fields missing; duplicates get {} (no match). Anything else raises.
Synthetic text only; nothing here is a real person.
"""
import asyncio
import hashlib
import json
import random
from types import SimpleNamespace
from typing import Any, Optional

FAKE_DELAYS = {"transcribe": 2.0, "chat": 1.5, "embedding": 0.3}
FAKE_TRANSCRIPT = "Met Loadtest Person by the library, about five foot ten, around 160 pounds."


def minimal_instance(schema: dict, root: Optional[dict] = None) -> Any:
    """The emptiest value `schema` allows: null where it may be null, else the first
    enum value, every property of an object, [] , "", 0 or False."""
    root = root if root is not None else schema
    ref = schema.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/$defs/"):
        return minimal_instance(root["$defs"][ref.removeprefix("#/$defs/")], root)
    branches = schema.get("anyOf") or []
    types = schema.get("type")
    if any(b.get("type") == "null" for b in branches) or (isinstance(types, list) and "null" in types):
        return None
    if "enum" in schema:
        return schema["enum"][0]
    if branches:
        return minimal_instance(branches[0], root)
    kind = types[0] if isinstance(types, list) else types
    if kind == "object" or "properties" in schema:
        return {key: minimal_instance(sub, root) for key, sub in (schema.get("properties") or {}).items()}
    return {"array": [], "string": "", "number": 0, "integer": 0, "boolean": False}.get(kind)


def _usage(prompt_tokens: int, completion_tokens: int) -> SimpleNamespace:
    return SimpleNamespace(prompt_tokens=prompt_tokens, completion_tokens=completion_tokens,
                           total_tokens=prompt_tokens + completion_tokens)


class _Transcriptions:
    async def create(self, *, response_format: str = "json", **kwargs):
        await asyncio.sleep(FAKE_DELAYS["transcribe"])
        if response_format == "text":
            return FAKE_TRANSCRIPT
        return SimpleNamespace(text=FAKE_TRANSCRIPT, usage=None)


class _Completions:
    async def create(self, *, messages: list, response_format: Optional[dict] = None, **kwargs):
        await asyncio.sleep(FAKE_DELAYS["chat"])
        response_format = response_format or {}
        if response_format.get("type") == "json_schema":
            schema = response_format["json_schema"]["schema"]
            content = json.dumps(minimal_instance(schema))
        else:
            content = "{}"
        message = SimpleNamespace(content=content, refusal=None, role="assistant")
        return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason="stop")],
                               usage=_usage(max(len(str(messages)) // 4, 1), 20))


class _Embeddings:
    async def create(self, *, input, dimensions: int = 3072, **kwargs):
        await asyncio.sleep(FAKE_DELAYS["embedding"])
        texts = [input] if isinstance(input, str) else list(input)
        data = []
        for index, text in enumerate(texts):
            rng = random.Random(hashlib.sha256(text.encode()).hexdigest())
            data.append(SimpleNamespace(index=index, embedding=[rng.uniform(-1, 1) for _ in range(dimensions)]))
        tokens = max(sum(len(t) for t in texts) // 4, 1)
        return SimpleNamespace(data=data, usage=SimpleNamespace(prompt_tokens=tokens, total_tokens=tokens))


class FakeAsyncOpenAI:
    def __init__(self):
        self.audio = SimpleNamespace(transcriptions=_Transcriptions())
        self.chat = SimpleNamespace(completions=_Completions())
        self.embeddings = _Embeddings()

    def with_options(self, **kwargs) -> "FakeAsyncOpenAI":
        return self

    def __getattr__(self, name: str):
        raise NotImplementedError(f"fake OpenAI: {name} is not faked")
