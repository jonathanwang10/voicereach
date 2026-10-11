"""Shared helpers for tests that mock IndividualService."""
from db.models import SaveIndividualResponse


def save_response(payload: dict) -> SaveIndividualResponse:
    """Build the object IndividualService.save_individual really returns.

    The route reads result.individual.id, so a bare dict is not enough.
    """
    payload["individual"].setdefault("last_location", None)
    return SaveIndividualResponse.model_validate(payload)


class FakeSupabase:
    """In-memory stand-in for the PostgREST calls duplicate detection makes.

    Supports table().select().ilike()/or_()/order()/limit().execute(). An `or_`
    filter of `name.ilike.*tok*` parts keeps rows whose name contains any token;
    `ilike` with a `%` at either end keeps rows whose name contains the rest, and
    without one keeps case-insensitive equal names. Rows come
    back in the given order (treat it as "most recently updated first").
    With fail=True every execute() raises, like a database outage.
    """

    def __init__(self, individuals, fail=False):
        self.individuals, self.fail, self.queries = list(individuals), fail, []

    def table(self, name):
        return _FakeQuery(self, name)


class _FakeQuery:
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
        from unittest.mock import MagicMock
        self.sb.queries.append((self.table, list(self.filters)))
        if self.sb.fail:
            raise RuntimeError("database unavailable")
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
