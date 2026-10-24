"""
Structured request logs (H2-8.1).

Every HTTP response carries X-Request-Id, and each request, recording job and realtime
session ends with one JSON summary line on the `voicereach.request` logger: the route
template (never the path or query, which can hold a name), status, duration, stage
timings (`whisper_ms`, `extract_ms`, `dup_ms`) and token usage per kind. The summary
takes only the fields in SUMMARY_FIELDS, so a new one can't smuggle data in unreviewed.

The per-request RequestLog lives in a ContextVar. Stages mutate that one object, so
work in the threadpool or in tasks created inside the request is seen too.
"""
import json
import logging
import re
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterator, Optional
from uuid import uuid4

REQUEST_ID_HEADER = "X-Request-Id"
SUMMARY_LOGGER = "voicereach.request"
SUMMARY_FIELDS = {"method", "route", "status", "duration_ms", "job_id", "job_status", "close_code"}
USAGE_KEYS = ("prompt_tokens", "completion_tokens", "input_tokens", "output_tokens", "total_tokens")
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{8,64}$")

_summary_logger = logging.getLogger(SUMMARY_LOGGER)


@dataclass
class RequestLog:
    request_id: str
    timings: dict[str, int] = field(default_factory=dict)
    usage: dict[str, dict[str, int]] = field(default_factory=dict)


_current: ContextVar[Optional[RequestLog]] = ContextVar("voicereach_request_log", default=None)


def current_log() -> Optional[RequestLog]:
    return _current.get()


@contextmanager
def stage_timer(name: str) -> Iterator[None]:
    """Add the block's elapsed whole ms to the current log's timings[name] (repeats sum)."""
    log = _current.get()
    start = time.perf_counter()
    try:
        yield
    finally:
        if log is not None:
            log.timings[name] = log.timings.get(name, 0) + int((time.perf_counter() - start) * 1000)


def _usage_of(source: Any) -> Any:
    if source is None or isinstance(source, (str, bytes)):
        return None
    if isinstance(source, dict):
        return source.get("usage") if "usage" in source else source
    return getattr(source, "usage", source)


def record_usage(kind: str, source: Any) -> None:
    """Sum the token counts of `source` (a response with .usage, a usage object or a
    dict) into the current log's usage[kind]. A no-op without either."""
    log = _current.get()
    usage = _usage_of(source)
    if log is None or usage is None:
        return
    counts = log.usage.setdefault(kind, {})
    for key in USAGE_KEYS:
        value = usage.get(key) if isinstance(usage, dict) else getattr(usage, key, None)
        if isinstance(value, int) and not isinstance(value, bool):
            counts[key] = counts.get(key, 0) + value
    if not counts:
        del log.usage[kind]


@contextmanager
def log_context(request_id: Optional[str] = None) -> Iterator[RequestLog]:
    """A RequestLog for work outside an HTTP request (a recording job, a WebSocket session)."""
    log = RequestLog(request_id=request_id or uuid4().hex)
    token = _current.set(log)
    try:
        yield log
    finally:
        _current.reset(token)


def emit_summary(event: str, log: RequestLog, level: int = logging.INFO, **fields) -> None:
    unknown = set(fields) - SUMMARY_FIELDS
    if unknown:
        raise ValueError(f"not a summary field: {', '.join(sorted(unknown))}")
    summary: dict[str, Any] = {"request_id": log.request_id, **fields, **log.timings}
    if log.usage:
        summary["usage"] = log.usage
    _summary_logger.log(level, event, extra={"summary": summary})


def _incoming_id(scope) -> Optional[str]:
    for name, value in scope.get("headers") or []:
        if name == b"x-request-id":
            text = value.decode("latin-1")
            return text if _SAFE_ID.match(text) else None
    return None


class RequestLogMiddleware:
    """Pure ASGI, HTTP only: the request id header and the summary line, for every
    response (a 413 or 401 from inner middleware, an unhandled 500 included)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = _incoming_id(scope) or uuid4().hex
        log = RequestLog(request_id=request_id)
        token = _current.set(log)
        start = time.perf_counter()
        state = {"status": 500, "duration_ms": None}

        async def send_with_id(message):
            if message["type"] == "http.response.start":
                state["status"] = message["status"]
                headers = list(message.get("headers") or [])
                headers.append((REQUEST_ID_HEADER.lower().encode(), request_id.encode()))
                message = {**message, "headers": headers}
            elif message["type"] == "http.response.body" and not message.get("more_body"):
                state["duration_ms"] = int((time.perf_counter() - start) * 1000)
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except Exception:
            state["status"] = 500
            raise
        finally:
            route = getattr(scope.get("route"), "path", None) or "unmatched"
            duration = state["duration_ms"]
            if duration is None:
                duration = int((time.perf_counter() - start) * 1000)
            level = logging.DEBUG if scope.get("path") == "/health" else logging.INFO
            emit_summary("request", log, level=level, method=scope.get("method"), route=route,
                         status=state["status"], duration_ms=duration)
            _current.reset(token)


class JsonFormatter(logging.Formatter):
    """One JSON object per record. Never the traceback or the exception message: a
    message can echo the data that was sent. Only the exception's type."""

    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        summary = getattr(record, "summary", None)
        if isinstance(summary, dict):
            out.update(summary)
        else:
            log = _current.get()
            if log is not None:
                out["request_id"] = log.request_id
        if record.exc_info and record.exc_info[0] is not None:
            out["exc_type"] = record.exc_info[0].__name__
        return json.dumps(out, default=str)
