"""Model names come from services/model_config.py, each overridable by an env var (H2-1.8)."""
import importlib
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from services import model_config

NAMES = ("CHAT_MODEL", "TRANSCRIBE_MODEL", "REALTIME_MODEL", "EMBEDDING_MODEL")

@pytest.fixture(autouse=True)
def _restore():
    yield
    importlib.reload(model_config)

def test_defaults(monkeypatch):
    for n in NAMES: monkeypatch.delenv(n, raising=False)
    importlib.reload(model_config)
    assert [getattr(model_config, n) for n in NAMES] == \
        ["gpt-4o", "gpt-transcribe", "gpt-realtime", "text-embedding-3-large"]   # H2-3.4

def test_env_overrides_and_blank_means_default(monkeypatch):
    monkeypatch.setenv("CHAT_MODEL", "gpt-test"); monkeypatch.setenv("REALTIME_MODEL", "  ")
    importlib.reload(model_config)
    assert model_config.CHAT_MODEL == "gpt-test" and model_config.REALTIME_MODEL == "gpt-realtime"

def _chat_reply(content="{}"):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])

async def test_categorize_uses_chat_model_and_compare_the_duplicate_model(monkeypatch):
    from services.openai_service import OpenAIService
    monkeypatch.setattr(model_config, "CHAT_MODEL", "chat-x")
    monkeypatch.setattr(model_config, "DUPLICATE_MODEL", "dup-x")      # H2-3.5
    svc = OpenAIService(); create = AsyncMock(return_value=_chat_reply())
    monkeypatch.setattr(svc.client.chat.completions, "create", create)
    await svc.categorize_transcription("hi", []); await svc.compare_individuals("p")
    assert [c.kwargs["model"] for c in create.call_args_list] == ["chat-x", "dup-x"]

async def test_whisper_uses_transcribe_model(monkeypatch, tmp_path):
    from services.openai_service import OpenAIService
    monkeypatch.setattr(model_config, "TRANSCRIBE_MODEL", "stt-x")
    svc = OpenAIService(); create = AsyncMock(return_value=SimpleNamespace(text=" hello "))
    monkeypatch.setattr(svc.whisper_client.audio.transcriptions, "create", create)
    path = tmp_path / "a.m4a"; path.write_bytes(b"x")
    assert await svc._whisper(str(path)) == "hello"
    assert create.call_args.kwargs["model"] == "stt-x"

async def test_embeddings_use_embedding_model(monkeypatch):
    from services.embedding_service import EmbeddingService
    monkeypatch.setattr(model_config, "EMBEDDING_MODEL", "emb-x")
    svc = EmbeddingService()
    create = AsyncMock(return_value=SimpleNamespace(data=[SimpleNamespace(index=0, embedding=[0.0] * 3072)]))
    monkeypatch.setattr(svc.client.embeddings, "create", create)
    await svc.generate_embedding("x")
    assert svc.model == "emb-x"
    assert create.call_args.kwargs["model"] == "emb-x"
