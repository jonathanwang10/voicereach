"""
OpenAI model names, each overridable by an env var of the same name (H2-1.8).

Read at import; blank or unset uses the default. Consumers read `model_config.X`
at call time (not `from model_config import X`), so a test can monkeypatch it.
"""
import os


def _env(name: str, default: str) -> str:
    return (os.getenv(name) or "").strip() or default


CHAT_MODEL = _env("CHAT_MODEL", "gpt-4o")
# whisper-1, gpt-4o-transcribe and gpt-4o-mini-transcribe shut down 2027-02-26; OpenAI's
# speech-to-text guide recommends gpt-transcribe for new work (H2-3.4)
TRANSCRIBE_MODEL = _env("TRANSCRIBE_MODEL", "gpt-transcribe")
REALTIME_MODEL = _env("REALTIME_MODEL", "gpt-realtime")
EMBEDDING_MODEL = _env("EMBEDDING_MODEL", "text-embedding-3-large")
