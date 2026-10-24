#!/usr/bin/env bash
# Apply a base schema, then every migration twice, in name order (H2-8.4). A
# migration that isn't idempotent fails the second pass. Usage:
#   supabase/check_migrations.sh <db_url> <base_schema.sql>
# A local or CI database only: any host but this machine is refused (review C-1).
set -euo pipefail
shopt -s nullglob

db_url="$1"
base="$2"

if ! python3 - "$db_url" <<'PY'
import sys
from urllib.parse import urlsplit
url = sys.argv[1]
hosts = []
if "://" in url:
    netloc = urlsplit(url).netloc.rsplit("@", 1)[-1]
    for part in netloc.split(","):
        part = part.strip()
        hosts.append(part[1:part.index("]")] if part.startswith("[") else part.split(":")[0])
else:
    for item in url.split():
        key, _, value = item.partition("=")
        if key in ("host", "hostaddr"):
            hosts += [h.strip() for h in value.split(",")]
local = {"", "localhost", "127.0.0.1", "::1"}
sys.exit(0 if all(h in local or h.startswith("/") for h in hosts) else 1)
PY
then
  echo "check_migrations.sh: <db_url> must be a local database (localhost, 127.0.0.1, ::1)" >&2
  exit 2
fi
dir="$(cd "$(dirname "$0")" && pwd)/migrations"
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"   # no "already exists, skipping"

psql "$db_url" -v ON_ERROR_STOP=1 -q -f "$base"
for pass in 1 2; do
  for file in "$dir"/*.sql; do
    psql "$db_url" -v ON_ERROR_STOP=1 -q -f "$file"
  done
done
echo "migrations applied twice: OK"
