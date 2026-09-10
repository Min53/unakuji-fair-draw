#!/usr/bin/env bash
# Applies db/001..005 to whatever Postgres DATABASE_URL points at, in order.
# Usage: DATABASE_URL=postgresql://user:pass@host:port/db ./apply-schema.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DATABASE_URL="${DATABASE_URL:-postgresql://postgres:devpass@localhost:55432/unakuji}"
for f in db/001_tables.sql db/002_functions.sql db/003_queue_functions.sql db/004_admin_functions.sql; do
  echo "Applying $f ..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
echo "Schema applied. db/005_roles.sql is optional (a least-privilege app role) — apply it separately if you want it."
