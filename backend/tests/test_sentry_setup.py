"""Optional Sentry (H2-8.2): off without SENTRY_DSN; with it, errors only, and nothing a
request carried (body, query, headers, exception text, local variables, library
breadcrumbs) leaves the backend."""
import json
import re

import pytest
import sentry_sdk
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sentry_sdk.transport import Transport

from services.request_log import RequestLogMiddleware
from services.sentry_setup import init_sentry, scrub_breadcrumb, scrub_event

SENTINEL = "Zebulon Quixley"


@pytest.fixture(autouse=True)
def _no_client_after():
    yield
    sentry_sdk.get_client().close()
    sentry_sdk.init(dsn=None)


def test_no_dsn_is_a_noop(monkeypatch):
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    assert init_sentry() is False and not sentry_sdk.get_client().is_active()


def test_init_options(monkeypatch):
    seen = {}
    monkeypatch.setattr(sentry_sdk, "init", lambda **kw: seen.update(kw))
    assert init_sentry("https://pub@example.invalid/1") is True
    assert seen["send_default_pii"] is False and seen["include_local_variables"] is False
    assert seen["max_request_body_size"] == "never" and seen["auto_enabling_integrations"] is False
    assert seen["before_send"] is scrub_event and seen["before_breadcrumb"] is scrub_breadcrumb
    assert seen.get("traces_sample_rate") is None   # errors only
    assert {type(i).__name__ for i in seen["integrations"]} == {"StarletteIntegration", "FastApiIntegration"}


def test_environment_comes_from_env(monkeypatch):
    seen = {}
    monkeypatch.setattr(sentry_sdk, "init", lambda **kw: seen.update(kw))
    monkeypatch.setenv("ENVIRONMENT", "production")
    init_sentry("https://pub@example.invalid/1")
    assert seen["environment"] == "production"


def test_scrub_event_strips_request_body_query_headers_and_exception_text():
    event = {"request": {"method": "POST", "url": "http://h/api/individuals?search=Zeb", "query_string": "search=Zeb",
                         "data": {"name": "Zeb"}, "headers": {"authorization": "Bearer t"}, "cookies": {"a": "b"}, "env": {}},
             "exception": {"values": [{"type": "RuntimeError", "value": "failed for Zeb",
                                       "stacktrace": {"frames": [{"function": "f", "vars": {"name": "Zeb"}}]}}]},
             "user": {"id": "u"}, "extra": {"x": "Zeb"}, "server_name": "box",
             "breadcrumbs": {"values": [{"type": "http", "category": "httplib", "data": {"url": "/?q=Zeb"}}]}}
    out = scrub_event(event, {})
    assert "Zeb" not in json.dumps(out)
    assert out["request"] == {"method": "POST", "url": "http://h/api/individuals"}
    assert out["exception"]["values"][0]["type"] == "RuntimeError"
    assert out["exception"]["values"][0]["stacktrace"]["frames"] == [{"function": "f"}]
    assert "user" not in out and "extra" not in out and "server_name" not in out


def test_scrub_event_tolerates_a_bare_event():
    assert scrub_event({"message": "x"}, {}) == {"message": "x"}


@pytest.mark.parametrize("crumb,kept", [
    ({"type": "log", "category": "api.individuals", "message": "Saved", "data": {"k": "v"}}, True),
    ({"type": "log", "category": "httpx", "message": "GET ..."}, False),
    ({"type": "log", "category": "openai._base_client", "message": "POST ..."}, False),
    ({"type": "http", "category": "httplib"}, False),
    ({"category": "query"}, False)])
def test_scrub_breadcrumb_keeps_only_app_log_lines_without_data(crumb, kept):
    out = scrub_breadcrumb(dict(crumb), {})
    if kept:
        assert out is not None and "data" not in out and out["message"] == "Saved"
    else:
        assert out is None


class _Capturing(Transport):
    def __init__(self, options=None):
        super().__init__(options)
        self.events = []

    def capture_envelope(self, envelope):
        for item in envelope.items:
            if item.type == "event":
                self.events.append(item.payload.json)


def test_captured_fastapi_error_is_scrubbed_and_tagged(monkeypatch):
    transport = _Capturing()
    real_init = sentry_sdk.init
    monkeypatch.setattr(sentry_sdk, "init", lambda **kw: real_init(**kw, transport=transport))
    assert init_sentry("https://pub@example.invalid/1") is True

    app = FastAPI()
    app.add_middleware(RequestLogMiddleware)

    @app.post("/boom/{x}")
    async def boom(x: str):
        raise RuntimeError(f"failed for {SENTINEL}")

    r = TestClient(app, raise_server_exceptions=False).post(f"/boom/1?search={SENTINEL}", json={"name": SENTINEL})
    assert r.status_code == 500
    sentry_sdk.flush()
    events = transport.events
    assert len(events) == 1
    assert "quixley" not in json.dumps(events[0]).lower()
    # An unhandled 500 is answered outside every user middleware, so it has no
    # X-Request-Id header; the event and the summary line still carry the id
    assert re.fullmatch(r"[0-9a-f]{32}", events[0]["tags"]["request_id"])
    assert events[0]["transaction"] == "/boom/{x}"
