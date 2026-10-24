"""
The voice assistant's tools (H2-5.8): four read-only lookups over the case database,
run on the server by the realtime proxy. The model asks for one with a function call;
the proxy runs it here and sends the result back only as a delimited
`function_call_output` (`realtime_guard.function_call_output_event`), never as a
system message. A client can't send tool output itself (the guard drops it).

Logs carry the tool name and a count or an exception type, never arguments or results.
"""
import json
import logging
import re
from typing import Any, Optional

from services import retrieval
from services.realtime_guard import function_call_output_event

logger = logging.getLogger(__name__)

TOOL_NAMES = ("search_people", "get_person", "recent_interactions", "most_urgent")
MAX_TOOL_ROUNDS = 3
MAX_LIMIT = 10
DEFAULT_LIMIT = 5
NO_RECORD = "No record found."
MAX_QUERY_CHARS = 200
MAX_NEAR_CHARS = 100

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_LIMIT = {"type": "integer", "minimum": 1, "maximum": MAX_LIMIT}
_PERSON_ID = {"type": "string", "description": "A person's id (a UUID) from search results."}


def _tool(name: str, description: str, properties: dict, required: list) -> dict:
    return {
        "type": "function",
        "name": name,
        "description": f"{description} Read-only.",
        "parameters": {"type": "object", "properties": properties, "required": required,
                       "additionalProperties": False},
    }


TOOL_DEFINITIONS: list[dict] = [
    _tool("search_people",
          "Find people in the case database by name, nickname or description. "
          "Returns compact summaries with their id and last_seen.",
          {"query": {"type": "string", "minLength": 1, "maxLength": MAX_QUERY_CHARS}, "limit": _LIMIT},
          ["query"]),
    _tool("get_person",
          "All recorded fields for one person, their latest visits, and when and where they were last seen.",
          {"individual_id": _PERSON_ID},
          ["individual_id"]),
    _tool("recent_interactions",
          "One person's most recent visits, newest first, each with its date.",
          {"individual_id": _PERSON_ID, "limit": _LIMIT},
          ["individual_id"]),
    _tool("most_urgent",
          "The most urgent people, optionally only those last seen near a San Francisco neighbourhood.",
          {"near": {"type": "string", "description": 'An SF neighbourhood such as "Mission".'}, "limit": _LIMIT},
          []),
]


def _limit(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        value = DEFAULT_LIMIT
    return max(1, min(value, MAX_LIMIT))


def _required_text(args: dict, key: str, max_chars: int) -> Optional[str]:
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()[:max_chars]


def parse_tool_arguments(name: str, arguments: str) -> dict | None:
    """The call's arguments, normalised; None for an unknown tool or unusable arguments."""
    if name not in TOOL_NAMES:
        return None
    try:
        args = json.loads(arguments) if isinstance(arguments, str) else None
    except (json.JSONDecodeError, ValueError, RecursionError):
        return None
    if not isinstance(args, dict):
        return None
    if name == "search_people":
        query = _required_text(args, "query", MAX_QUERY_CHARS)
        return None if query is None else {"query": query, "limit": _limit(args.get("limit"))}
    if name == "most_urgent":
        near = args.get("near")
        near = near.strip()[:MAX_NEAR_CHARS] if isinstance(near, str) else None
        return {"near": near or None, "limit": _limit(args.get("limit"))}
    individual_id = _required_text(args, "individual_id", 100)
    if individual_id is None:
        return None
    if name == "get_person":
        return {"individual_id": individual_id}
    return {"individual_id": individual_id, "limit": _limit(args.get("limit"))}


def format_tool_result(result: Any) -> str:
    """JSON with < and > escaped, so no stored value can form a delimiter."""
    text = json.dumps(result, ensure_ascii=False, default=str)
    return text.replace("<", "\\u003c").replace(">", "\\u003e")


async def run_tool(name: str, arguments: str) -> str:
    """The tool's result as text to delimit. Never raises."""
    args = parse_tool_arguments(name, arguments)
    if args is None:
        return format_tool_result({"error": "invalid_arguments"})
    if "individual_id" in args and not _UUID.match(args["individual_id"]):
        return format_tool_result({"results": [], "message": NO_RECORD})
    try:
        if name == "get_person":
            result = await getattr(retrieval, name)(args["individual_id"])
        else:
            result = await getattr(retrieval, name)(**args)
    except retrieval.UnknownAreaError:
        logger.info("Assistant tool %s: unknown area", name)
        return format_tool_result({"error": "unknown_area",
                                   "message": "That is not a San Francisco neighbourhood I know."})
    except Exception as e:
        logger.warning("Assistant tool %s failed: %s", name, type(e).__name__)
        return format_tool_result({"error": "lookup_failed"})
    if not result:
        logger.info("Assistant tool %s returned %d result(s)", name, 0)
        return format_tool_result({"results": [], "message": NO_RECORD})
    if isinstance(result, dict):
        logger.info("Assistant tool %s returned %d result(s)", name, 1)
        return format_tool_result({"person": result})
    logger.info("Assistant tool %s returned %d result(s)", name, len(result))
    return format_tool_result({"results": list(result)})


class ToolCallRouter:
    """Watches upstream events for one session and answers the model's tool calls.

    Calls are run when their response is done (a cancelled response's calls are
    dropped). After MAX_TOOL_ROUNDS responses in a row that only called tools, the
    next response is told to answer without them.
    """

    def __init__(self):
        self._pending: dict[str, list[tuple[str, str, str]]] = {}
        self._rounds = 0

    async def on_upstream_event(self, event: Any) -> list[dict]:
        if not isinstance(event, dict):
            return []
        if event.get("type") == "response.function_call_arguments.done":
            call_id, name = event.get("call_id"), event.get("name")
            if isinstance(call_id, str) and isinstance(name, str):
                arguments = event.get("arguments")
                self._pending.setdefault(str(event.get("response_id")), []).append(
                    (call_id, name, arguments if isinstance(arguments, str) else ""))
            return []
        if event.get("type") != "response.done" or not isinstance(event.get("response"), dict):
            return []

        response = event["response"]
        remembered = {c[0]: c for c in self._pending.pop(str(response.get("id")), [])}
        calls = []
        output = response.get("output")
        for item in output if isinstance(output, list) else []:
            if not isinstance(item, dict) or item.get("type") != "function_call":
                continue
            call_id = item.get("call_id")
            if not isinstance(call_id, str):
                continue
            if call_id in remembered:
                calls.append(remembered.pop(call_id))
            elif isinstance(item.get("name"), str):
                arguments = item.get("arguments")
                calls.append((call_id, item["name"], arguments if isinstance(arguments, str) else ""))
        calls.extend(remembered.values())

        if response.get("status") != "completed":
            return []
        if not calls:
            self._rounds = 0
            return []
        self._rounds += 1
        events = [function_call_output_event(call_id, await run_tool(name, arguments))
                  for call_id, name, arguments in calls]
        if self._rounds >= MAX_TOOL_ROUNDS:
            self._rounds = 0
            events.append({"type": "response.create", "response": {"tool_choice": "none"}})
        else:
            events.append({"type": "response.create"})
        return events
