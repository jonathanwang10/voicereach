import os
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent

API_URL = os.getenv("VOICEREACH_API_URL", "http://localhost:8001")


def pytest_collection_modifyitems(config, items):
    if os.getenv("VOICEREACH_INTEGRATION") == "1":
        return
    skip = pytest.mark.skip(reason="integration test: set VOICEREACH_INTEGRATION=1 and run the backend")
    for item in items:
        # this hook runs for the whole session, so only touch our own directory
        if HERE in Path(str(item.fspath)).resolve().parents:
            item.add_marker(skip)
