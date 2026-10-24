"""
Optional Sentry error reports (H2-8.2): only when SENTRY_DSN is set, errors only (no
tracing). An event keeps the error's type, its stack frames without local variables,
the route template and the request id. It never keeps a body, a query string, headers,
cookies, the exception's message (it can echo the data sent) or a library's breadcrumb
(httpx and OpenAI lines carry URLs and prompts).
"""
import os
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

from services.request_log import QUIET_LIBRARY_LOGGERS


def init_sentry(dsn: Optional[str] = None) -> bool:
    """Start the client when there is a DSN (SENTRY_DSN by default); False otherwise."""
    dsn = dsn if dsn is not None else os.getenv("SENTRY_DSN", "")
    if not dsn:
        return False
    sentry_sdk.init(
        dsn=dsn,
        send_default_pii=False,
        include_local_variables=False,
        max_request_body_size="never",
        # httpx and OpenAI integrations would record URLs and prompts: only these two
        auto_enabling_integrations=False,
        integrations=[StarletteIntegration(), FastApiIntegration()],
        before_send=scrub_event,
        before_breadcrumb=scrub_breadcrumb,
        environment=os.getenv("ENVIRONMENT", "development"),
    )
    return True


def _without_query(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def scrub_event(event: dict, hint: dict) -> dict:
    request = event.get("request")
    if isinstance(request, dict):
        kept = {}
        if "method" in request:
            kept["method"] = request["method"]
        if isinstance(request.get("url"), str):
            kept["url"] = _without_query(request["url"])
        event["request"] = kept
    for value in (event.get("exception") or {}).get("values") or []:
        value["value"] = ""
        for frame in (value.get("stacktrace") or {}).get("frames") or []:
            frame.pop("vars", None)
    for key in ("user", "extra", "server_name"):
        event.pop(key, None)
    crumbs = event.get("breadcrumbs")
    if isinstance(crumbs, dict) and isinstance(crumbs.get("values"), list):
        crumbs["values"] = [c for c in (scrub_breadcrumb(dict(c), {}) for c in crumbs["values"]) if c]
    return event


def scrub_breadcrumb(crumb: dict, hint: dict) -> Optional[dict]:
    """Only the app's own log lines, without their data."""
    category = crumb.get("category") or ""
    if crumb.get("type") != "log" or any(category == q or category.startswith(q + ".") for q in QUIET_LIBRARY_LOGGERS):
        return None
    crumb.pop("data", None)
    return crumb
