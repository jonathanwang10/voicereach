"""Shared test helpers: strict and in-memory Supabase fakes, row builders, route listing."""
import copy
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Callable, List, Optional
from unittest.mock import MagicMock

from db.models import SaveIndividualResponse


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
    """

    def __init__(self):
        self.rules: List[_Rule] = []
        self.calls: List[Call] = []

    def on(self, table: str, verb: str, data: Any = None, error: BaseException = None,
           times: Optional[int] = None) -> "FakeSupabase":
        assert verb in _VERBS, f"unknown verb {verb!r}"
        self.rules.append(_Rule(table, verb, data, error, times))
        return self

    def table(self, name: str) -> "_Chain":
        return _Chain(self, name)

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
        assert self._call is not None, f"execute() with no select/insert/update/... on {self._table}"
        call = self._call
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
        return SimpleNamespace(data=data if data is not None else [])


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
        self.sb, self.table, self.filters = sb, table, []

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

    def execute(self):
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
            return MagicMock(data=list(rows))
        if self.table == "interactions":
            ids = next((f[2] for f in self.filters if f[0] == "in"), None)
            rows = [r for r in self.sb.interactions if ids is None or r["individual_id"] in ids]
            rows = sorted(rows, key=lambda r: r["created_at"], reverse=True)
            return MagicMock(data=rows)
        if self.table == "individual_embeddings":
            return MagicMock(data=list(self.sb.embeddings))
        raise AssertionError(f"FakeListDB has no table {self.table!r}")
