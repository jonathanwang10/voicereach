"""
The one place an OpenAI client is built (H2-8.5). VOICEREACH_FAKE_OPENAI=1 swaps in
services.fake_openai for load tests, so a run costs nothing and its latency is fixed;
it is refused when ENVIRONMENT=production. The realtime proxy is never faked.
"""
import os

from openai import AsyncOpenAI

from services.fake_openai import FakeAsyncOpenAI


def fake_openai_enabled() -> bool:
    """True when VOICEREACH_FAKE_OPENAI is exactly "1"; raises in production."""
    if os.getenv("VOICEREACH_FAKE_OPENAI") != "1":
        return False
    if (os.getenv("ENVIRONMENT") or "").strip().lower() == "production":
        raise RuntimeError("VOICEREACH_FAKE_OPENAI=1 is not allowed when ENVIRONMENT=production")
    return True


def make_async_openai(**kwargs) -> AsyncOpenAI | FakeAsyncOpenAI:
    """AsyncOpenAI(**kwargs), or the fake in fake-OpenAI mode."""
    if fake_openai_enabled():
        return FakeAsyncOpenAI()
    return AsyncOpenAI(**kwargs)
