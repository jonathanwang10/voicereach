"""Shared test helpers: strict and in-memory Supabase fakes, row builders, route listing."""
import asyncio
import copy
import json
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, List, Optional
from unittest.mock import MagicMock

import httpx2
import openai

from db.models import SaveIndividualResponse


FIXTURES = Path(__file__).resolve().parent / "fixtures"


def fixture_audio(name: str) -> bytes:
    """Bytes of a committed test recording in backend/tests/fixtures/ (real M4A/AAC)."""
    return (FIXTURES / name).read_bytes()


def openai_bad_request(code: str, param: str = "file") -> openai.BadRequestError:
    """The 400 the OpenAI SDK raises, with the error `code`/`param` it parses from the body."""
    return openai.BadRequestError(
        "bad request",
        response=httpx2.Response(400, request=httpx2.Request("POST", "https://api.openai.com/v1/audio/transcriptions")),
        body={"code": code, "param": param})


def save_response(payload: dict) -> SaveIndividualResponse:
    """Build the object IndividualService.save_individual really returns.

    The route reads result.individual.id, so a bare dict is not enough.
    """
    payload["individual"].setdefault("last_location", None)
    return SaveIndividualResponse.model_validate(payload)


def all_route_paths(application) -> List[str]:
    """Flat list of every route path, including routers mounted via include_router
    (newer FastAPI keeps them as _IncludedRouter objects instead of flattening)."""
    out = []
    for r in application.routes:
        if hasattr(r, "original_router"):
            prefix = r.include_context.prefix
            out += [prefix + x.path for x in r.original_router.routes]
        else:
            out.append(getattr(r, "path", ""))
    return out


def assert_off_event_loop(what: str) -> None:
    """Fail a sync query made while an asyncio loop runs in this thread: in the real
    app it would block the loop. Every fake's execute() calls this first (H2-1.1)."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    raise AssertionError(f"{what} ran on the event loop thread; wrap it in run_db (H2-1.1)")


# --- FakeSupabase: strict and scripted ------------------------------------------------------

_VERBS = {"select", "insert", "update", "upsert", "delete"}
_WRITE_VERBS = {"insert", "update", "upsert"}
_MODIFIERS = {"eq", "neq", "in_", "ilike", "or_", "order", "limit", "range", "single", "maybe_single"}


@dataclass
class Call:
    """One executed query: table(table).<verb>(payload/args).<mods...>.execute()."""
    table: str
    verb: str
    payload: Any = None
    args: tuple = ()
    kwargs: dict = field(default_factory=dict)
    mods: list = field(default_factory=list)  # [(name, args, kwargs), ...] in call order

    def mod(self, name):
        """(args, kwargs) of the first `name` modifier, or None if the chain had none."""
        return next(((a, k) for n, a, k in self.mods if n == name), None)


@dataclass
class _Rule:
    table: str
    verb: str
    data: Any
    error: Optional[BaseException]
    times: Optional[int]


class FakeSupabase:
    """A strict, scripted stand-in for the supabase-py client.

    Script what each (table, verb) returns, run the code, then assert on what it sent:

        sb = FakeSupabase()
        sb.on("categories", "select", data=CATEGORIES)
        sb.on("individuals", "insert", data=lambda call: [{**ROW, **call.payload}])
        ...
        assert sb.payloads("individuals", "insert") == [{...}]

    - A chain is table(name).<verb>(...)[.<modifier>(...)].execute(). Verbs: select,
      insert, update, upsert, delete. Modifiers: eq, neq, in_, ilike, or_, order, limit,
      range, single, maybe_single. Any other method is an AttributeError.
    - execute() with nothing scripted for its (table, verb) raises AssertionError naming
      the chain, so a test can never pass on an auto-generated MagicMock value.
    - Rules are used in the order added; `times=n` uses a rule n times, otherwise it stays.
      `data` may be a callable taking the Call (e.g. to echo an insert payload);
      `error=exc` makes execute() raise it.
    - maybe_single() gives the first row, or None for no rows (as postgrest does);
      single() gives the first row and raises APIError PGRST116 for no rows.
    - A function call is rpc(name, params)[.<modifier>(...)].execute(), scripted with
      on_rpc(name, data=, error=, times=) under the same rules. It is recorded as
      Call(table=name, verb="rpc", payload=params); rpc_params(name) lists them. Table
      rules never answer an rpc and rpc rules never answer a table query. The params
      must be JSON-serialisable (the real client sends them as JSON), and the result is
      the scripted value as is (None stays None). pg_error(code) builds the APIError a
      `RAISE ... USING ERRCODE` gives.
    """

    def __init__(self):
        self.rules: List[_Rule] = []
        self.calls: List[Call] = []

    def on(self, table: str, verb: str, data: Any = None, error: BaseException = None,
           times: Optional[int] = None) -> "FakeSupabase":
        assert verb in _VERBS, f"unknown verb {verb!r}"
        self.rules.append(_Rule(table, verb, data, error, times))
        return self

    def on_rpc(self, name: str, data: Any = None, error: BaseException = None,
               times: Optional[int] = None) -> "FakeSupabase":
        self.rules.append(_Rule(name, "rpc", data, error, times))
        return self

    def table(self, name: str) -> "_Chain":
        return _Chain(self, name)

    def rpc(self, name: str, params: Optional[dict] = None) -> "_Chain":
        chain = _Chain(self, name)
        chain._call = Call(name, "rpc", copy.deepcopy(params or {}))
        return chain

    def rpc_params(self, name: str) -> List[dict]:
        return [c.payload for c in self.calls_to(name, "rpc")]

    def calls_to(self, table: str, verb: Optional[str] = None) -> List[Call]:
        return [c for c in self.calls if c.table == table and (verb is None or c.verb == verb)]

    def payloads(self, table: str, verb: str) -> list:
        return [c.payload for c in self.calls_to(table, verb)]

    def _result(self, call: Call):
        for rule in self.rules:
            if rule.table == call.table and rule.verb == call.verb and rule.times != 0:
                if rule.times is not None:
                    rule.times -= 1
                if rule.error is not None:
                    raise rule.error
                data = rule.data(call) if callable(rule.data) else copy.deepcopy(rule.data)
                return data
        mods = "".join(f".{n}()" for n, _, _ in call.mods)
        if call.verb == "rpc":
            raise AssertionError(f"FakeSupabase: nothing scripted for rpc({call.table!r}){mods}.execute()")
        raise AssertionError(
            f"FakeSupabase: nothing scripted for table({call.table!r}).{call.verb}(){mods}.execute()")


class _Chain:
    def __init__(self, sb: FakeSupabase, table: str):
        self._sb, self._table, self._call = sb, table, None

    def __getattr__(self, name: str) -> Callable:
        if name in _VERBS:
            def verb(*args, **kwargs):
                assert self._call is None, f"two verbs in one chain on {self._table}: {self._call.verb}, {name}"
                payload = copy.deepcopy(args[0]) if name in _WRITE_VERBS and args else None
                self._call = Call(self._table, name, payload, args, kwargs)
                return self
            return verb
        if name in _MODIFIERS:
            def modifier(*args, **kwargs):
                assert self._call is not None, f"{name}() before select/insert/update/... on {self._table}"
                self._call.mods.append((name, args, kwargs))
                return self
            return modifier
        raise AttributeError(f"FakeSupabase has no .{name}()")

    def execute(self):
        assert_off_event_loop(f"FakeSupabase: table({self._table!r}).execute()")
        assert self._call is not None, f"execute() with no select/insert/update/... on {self._table}"
        call = self._call
        if call.verb == "rpc":
            try:
                json.dumps(call.payload)
            except (TypeError, ValueError) as e:
                raise AssertionError(f"FakeSupabase: rpc({call.table!r}) params are not JSON-serialisable: {e}")
        self._sb.calls.append(call)
        data = self._sb._result(call)
        names = {n for n, _, _ in call.mods}
        if names & {"single", "maybe_single"}:
            rows = data if isinstance(data, list) else ([data] if data else [])
            if not rows:
                if "maybe_single" in names:
                    return None
                from postgrest.exceptions import APIError
                raise APIError({"code": "PGRST116", "message": "JSON object requested, multiple (or no) rows returned",
                                "details": "The result contains 0 rows", "hint": None})
            return SimpleNamespace(data=rows[0])
        if call.verb == "rpc":
            return SimpleNamespace(data=data)
        return SimpleNamespace(data=data if data is not None else [])


def pg_error(code: str, message: str = "database error"):
    """The APIError postgrest raises for a SQLSTATE (e.g. a `RAISE ... USING ERRCODE`)."""
    from postgrest.exceptions import APIError
    return APIError({"code": code, "message": message, "details": None, "hint": None})


def paged(rows: list) -> Callable[["Call"], list]:
    """`data=` for a scripted select: the slice the call's .range(a, b) asks for
    (every row when the chain has no range), so fetch_all can page through `rows`."""
    def page(call: "Call") -> list:
        r = call.mod("range")
        if r is None:
            return copy.deepcopy(rows)
        start, end = r[0]
        return copy.deepcopy(rows[start:end + 1])
    return page


def save_rpc(existing: Optional[dict] = None, *, new_id: str = None, interaction_id: str = None,
             at: str = "2026-02-01T00:00:00+00:00") -> Callable[["Call"], dict]:
    """`data=` for on_rpc("save_individual"): plays the SQL function from its params.

    A new person (p_individual_id null) is inserted at version 1; a merge updates
    `existing` and bumps its version. last_location is the visit's location, else the
    existing one. The interaction row carries the p_interaction fields plus
    client_request_id. Always `replayed: False` (script a replay explicitly).
    """
    new_id = new_id or ID1
    interaction_id = interaction_id or ID2

    def play(call: "Call") -> dict:
        p = call.payload
        visit = p["p_interaction"]
        location = visit.get("location")
        if p["p_individual_id"] is None:
            individual = {"id": new_id, "urgency_override": None, "created_at": at, "version": 1,
                          "last_location": location}
        else:
            base = existing or {}
            individual = {"created_at": at, "urgency_override": None, **base, "id": p["p_individual_id"],
                          "version": base.get("version", 1) + 1,
                          "last_location": location or base.get("last_location")}
        individual.update(name=p["p_name"], data=p["p_data"], urgency_score=p["p_urgency_score"], updated_at=at)
        interaction = {"id": interaction_id, "individual_id": individual["id"], "created_at": at,
                       "user_id": visit.get("user_id"), "user_name": visit.get("user_name") or "Unknown",
                       "transcription": visit.get("transcription"), "audio_url": visit.get("audio_url"),
                       "location": location, "changes": visit.get("changes") or {},
                       "client_request_id": p["p_client_request_id"]}
        return {"individual": individual, "interaction": interaction, "replayed": False}
    return play


# --- FakePeopleDB: in-memory name search (duplicate detection, assistant context) ----------

class FakePeopleDB:
    """In-memory stand-in for the PostgREST reads duplicate detection and the assistant make.

    Supports table().select().ilike()/or_()/order()/limit().execute() on "individuals" and
    "categories" only (any other table or method fails). An `or_` filter of
    `name.ilike.*tok*` parts keeps rows whose name contains any token; `ilike` with a `%`
    at either end keeps rows whose name contains the rest, and without one keeps
    case-insensitive equal names. Rows come back in the given order (treat it as "most
    recently updated first"). With fail=True every execute() raises, like a database
    outage. table("categories") returns `categories` (default none); with
    categories_fail=True only that table raises.
    """

    def __init__(self, individuals, fail=False, categories=None, categories_fail=False):
        self.individuals, self.fail, self.queries = list(individuals), fail, []
        self.categories, self.categories_fail = list(categories or []), categories_fail

    def table(self, name):
        assert name in ("individuals", "categories"), f"FakePeopleDB has no table {name!r}"
        return _PeopleQuery(self, name)

    def rpc(self, name, params):
        """find_duplicate_candidates, approximated in memory (the real trigram matching is
        tested against Postgres in Phase 8): a name containing any _name_tokens token,
        then a data value matching the whole name at a word start (match_individual) among
        the first 200 rows; name matches first, no repeats, at most p_limit."""
        assert name == "find_duplicate_candidates", f"FakePeopleDB has no function {name!r}"
        return _PeopleRpc(self, name, params)


class _PeopleRpc:
    def __init__(self, sb, name, params):
        self.sb, self.name, self.params = sb, name, dict(params)

    def execute(self):
        from services.duplicate_detection_service import DuplicateDetectionService
        from services.search_matching import match_individual
        assert_off_event_loop(f"FakePeopleDB: rpc({self.name!r}).execute()")
        self.sb.queries.append(("rpc", self.name, dict(self.params)))
        if self.sb.fail:
            raise RuntimeError("database unavailable")
        p_name, limit = self.params["p_name"], self.params.get("p_limit", 50)
        tokens = DuplicateDetectionService._name_tokens(p_name)
        by_name = [r for r in self.sb.individuals if any(t in (r.get("name") or "").lower() for t in tokens)]
        by_value = [r for r in self.sb.individuals[:200] if match_individual(p_name, r) == "value"]
        rows, seen = [], set()
        for r in by_name + by_value:
            if r.get("id") not in seen:
                seen.add(r.get("id"))
                rows.append(r)
        return MagicMock(data=rows[:limit])


class _PeopleQuery:
    def __init__(self, sb, table):
        self.sb, self.table, self.filters, self.n = sb, table, [], None

    def select(self, *a, **k):
        return self

    def ilike(self, col, pattern):
        self.filters.append(("ilike", col, pattern))
        return self

    def or_(self, filters):
        self.filters.append(("or", filters))
        return self

    def order(self, *a, **k):
        return self

    def limit(self, n):
        self.n = n
        return self

    def execute(self):
        assert_off_event_loop(f"FakePeopleDB: table({self.table!r}).execute()")
        self.sb.queries.append((self.table, list(self.filters)))
        if self.sb.fail or (self.table == "categories" and self.sb.categories_fail):
            raise RuntimeError("database unavailable")
        if self.table == "categories":
            return MagicMock(data=list(self.sb.categories))
        rows = list(self.sb.individuals)
        for f in self.filters:
            if f[0] == "ilike":
                needle = f[2].strip("%").replace("\\", "").lower()
                if f[2].startswith("%") or f[2].endswith("%"):
                    rows = [r for r in rows if needle in (r.get("name") or "").lower()]
                else:  # no wildcard: case-insensitive equality, like Postgres ILIKE
                    rows = [r for r in rows if needle == (r.get("name") or "").lower()]
            elif f[0] == "or":
                needles = [part.split(".ilike.", 1)[1].strip("*%").lower() for part in f[1].split(",")]
                rows = [r for r in rows if any(n in (r.get("name") or "").lower() for n in needles)]
        if self.n is not None:
            rows = rows[: self.n]
        return MagicMock(data=rows)


# --- FakeListDB: the list/search reads (individuals + interactions) -------------------------

ID1 = "00000000-0000-0000-0000-000000000001"
ID2 = "00000000-0000-0000-0000-000000000002"


def person(i, **kw):
    """An individuals row with id ...000i, created 2026-01-0i, updated in September."""
    base = {"id": f"00000000-0000-0000-0000-00000000000{i}", "name": f"Person {i}", "urgency_score": 10,
            "urgency_override": None, "data": {}, "created_at": f"2026-01-0{i}T00:00:00+00:00",
            "updated_at": "2026-09-09T00:00:00+00:00", "last_location": None}
    base.update(kw)
    return base


class FakeListDB:
    """In-memory "individuals", "interactions" and "individual_embeddings" (default none)
    for IndividualService.search_individuals, fetch_last_seen and /api/embeddings/search.
    Any other table fails. `queries` records (table, filters) per execute()."""

    def __init__(self, individuals, interactions, embeddings=()):
        self.individuals, self.interactions, self.queries = individuals, interactions, []
        self.embeddings = list(embeddings)

    def table(self, name):
        return _ListQuery(self, name)

    def count(self, table):
        return len([q for q in self.queries if q[0] == table])


class _ListQuery:
    def __init__(self, sb, table):
        self.sb, self.table, self.filters, self.window = sb, table, [], None

    def select(self, *a, **k):
        return self

    def ilike(self, col, pattern):
        self.filters.append(("ilike", col, pattern))
        return self

    def or_(self, filters):
        self.filters.append(("or", filters))
        return self

    def in_(self, col, values):
        self.filters.append(("in", col, list(values)))
        return self

    def eq(self, col, value):
        self.filters.append(("eq", col, value))
        return self

    def order(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def range(self, start, end):
        self.window = (start, end)
        return self

    def _page(self, rows):
        return list(rows) if self.window is None else list(rows)[self.window[0]:self.window[1] + 1]

    def execute(self):
        assert_off_event_loop(f"FakeListDB: table({self.table!r}).execute()")
        self.sb.queries.append((self.table, self.filters))
        if self.table == "individuals":
            rows = self.sb.individuals
            for f in self.filters:
                if f[0] == "ilike":
                    needle = f[2].strip("%").replace("\\", "").lower()
                    rows = [r for r in rows if needle in r["name"].lower()]
                elif f[0] == "or":  # name.ilike.*tok*,name.ilike.*tok2*
                    needles = [p.split(".ilike.", 1)[1].strip("*").lower() for p in f[1].split(",")]
                    rows = [r for r in rows if any(n in r["name"].lower() for n in needles)]
            return MagicMock(data=self._page(rows))
        if self.table == "interactions":
            ids = next((f[2] for f in self.filters if f[0] == "in"), None)
            rows = [r for r in self.sb.interactions if ids is None or r["individual_id"] in ids]
            rows = sorted(rows, key=lambda r: r["created_at"], reverse=True)
            return MagicMock(data=self._page(rows))
        if self.table == "individual_embeddings":
            return MagicMock(data=self._page(self.sb.embeddings))
        raise AssertionError(f"FakeListDB has no table {self.table!r}")
