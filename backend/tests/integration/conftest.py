"""tests/integration/ talks to a running backend. Everything here is skipped unless
VOICEREACH_API_URL (e.g. http://localhost:8001) and VOICEREACH_LIVE_TOKEN (a real
Supabase access token for an allowed user) are both set."""
import os
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
API_URL = os.getenv("VOICEREACH_API_URL", "")
LIVE_TOKEN = os.getenv("VOICEREACH_LIVE_TOKEN", "")


def pytest_collection_modifyitems(config, items):
    if API_URL and LIVE_TOKEN:
        return
    skip = pytest.mark.skip(reason="live smoke test: set VOICEREACH_API_URL and VOICEREACH_LIVE_TOKEN")
    for item in items:
        # this hook runs for the whole session, so only touch our own directory
        if HERE in Path(str(item.fspath)).resolve().parents:
            item.add_marker(skip)
