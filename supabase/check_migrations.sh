#!/usr/bin/env bash
# Apply a base schema, then every migration twice, in name order (H2-8.4). A
# migration that isn't idempotent fails the second pass. Usage:
#   supabase/check_migrations.sh <db_url> <base_schema.sql>
# A local or CI database only: never the hosted one.
set -euo pipefail
shopt -s nullglob

db_url="$1"
base="$2"
dir="$(cd "$(dirname "$0")" && pwd)/migrations"
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"   # no "already exists, skipping"

psql "$db_url" -v ON_ERROR_STOP=1 -q -f "$base"
for pass in 1 2; do
  for file in "$dir"/*.sql; do
    psql "$db_url" -v ON_ERROR_STOP=1 -q -f "$file"
  done
done
echo "migrations applied twice: OK"
