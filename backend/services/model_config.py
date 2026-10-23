"""
OpenAI model names, each overridable by an env var of the same name (H2-1.8).

Read at import; blank or unset uses the default. Consumers read `model_config.X`
at call time (not `from model_config import X`), so a test can monkeypatch it.
"""
import os


def _env(name: str, default: str) -> str:
    return (os.getenv(name) or "").strip() or default


CHAT_MODEL = _env("CHAT_MODEL", "gpt-4o")
TRANSCRIBE_MODEL = _env("TRANSCRIBE_MODEL", "whisper-1")
REALTIME_MODEL = _env("REALTIME_MODEL", "gpt-realtime")
EMBEDDING_MODEL = _env("EMBEDDING_MODEL", "text-embedding-3-large")
