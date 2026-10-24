"""The Locust file only calls routes the app has (H2-8.5)."""
import ast
import re
from pathlib import Path

from tests.helpers import all_route_paths

LOCUSTFILE = Path(__file__).resolve().parents[1] / "loadtest" / "locustfile.py"


def _paths() -> set[str]:
    found = set()
    tree = ast.parse(LOCUSTFILE.read_text())
    # The literal pieces of an f-string are read with their f-string, not alone
    pieces = {id(v) for node in ast.walk(tree) if isinstance(node, ast.JoinedStr) for v in node.values}
    for node in ast.walk(tree):
        if id(node) in pieces:
            continue
        if isinstance(node, ast.JoinedStr):
            text = "".join(v.value if isinstance(v, ast.Constant) else "SEGMENT" for v in node.values)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            text = node.value
        else:
            continue
        if text.startswith("/api/"):
            text = text.split("?")[0].split(" ")[0].replace("[id]", "SEGMENT")
            found.add(text)
    return found


def test_locustfile_only_calls_routes_that_exist():
    import main
    patterns = [re.compile("^" + re.sub(r"\{[^}]+\}", "[^/]+", path) + "$")
                for path in all_route_paths(main.app) if path.startswith("/api/")]
    paths = _paths()
    assert {"/api/individuals", "/api/recordings", "/api/embeddings/search"} <= paths
    missing = [p for p in sorted(paths) if not any(pattern.match(p) for pattern in patterns)]
    assert missing == []
