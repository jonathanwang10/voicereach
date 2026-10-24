"""uvicorn's own loggers go through the app's formatter (review I-1). uvicorn configures
"uvicorn", "uvicorn.error" and "uvicorn.access" with their own text handlers before it
imports the app, so without this an unhandled exception printed its full traceback,
message included, whatever LOG_FORMAT said. Each test runs a fresh interpreter that
does what `python -m uvicorn main:app` does: uvicorn's logging config, then `import main`."""
import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
SENTINEL = "Sentinel Person HIV positive"

SCRIPT = f"""
import copy, logging, logging.config
from uvicorn.config import LOGGING_CONFIG
logging.config.dictConfig(copy.deepcopy(LOGGING_CONFIG))
import main
try:
    raise ValueError({SENTINEL!r})
except ValueError:
    logging.getLogger("uvicorn.error").exception("Exception in ASGI application")
logging.getLogger("uvicorn.access").info('%s - "%s %s HTTP/%s" %d', "127.0.0.1:1", "GET",
                                         "/api/individuals?search=Sentinel", "1.1", 200)
"""


def _run(**env) -> str:
    result = subprocess.run([sys.executable, "-c", SCRIPT], cwd=BACKEND, capture_output=True, text=True,
                            timeout=60, env={**os.environ, "SENTRY_DSN": "", "LOG_FORMAT": "", **env})
    assert result.returncode == 0, result.stderr[-2000:]
    return result.stderr + result.stdout


def test_an_unhandled_exception_logs_its_type_only():
    out = _run()
    assert SENTINEL not in out
    lines = [json.loads(line) for line in out.splitlines() if line.startswith("{")]
    error = next(line for line in lines if line["msg"] == "Exception in ASGI application")
    assert error["exc_type"] == "ValueError" and error["logger"] == "uvicorn.error"


def test_the_access_line_is_json_and_keeps_dropping_the_query():
    out = _run()
    assert "Sentinel" not in out
    lines = [json.loads(line) for line in out.splitlines() if line.startswith("{")]
    access = next(line for line in lines if line["logger"] == "uvicorn.access")
    assert "/api/individuals" in access["msg"]


def test_the_text_format_drops_the_traceback_too():
    out = _run(LOG_FORMAT="text")
    assert SENTINEL not in out
    assert "Exception in ASGI application" in out and "exc_type=ValueError" in out
    assert "Traceback" not in out
