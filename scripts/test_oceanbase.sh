#!/usr/bin/env bash
set -euo pipefail

: "${OB_TENANT_PASSWORD:?Set OB_TENANT_PASSWORD}"
: "${OCEANBASE_DATABASE_URL:?Set OCEANBASE_DATABASE_URL}"

compose=(docker compose -f docker-compose.yml -f docker-compose.oceanbase.yml)
"${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
"${compose[@]}" up -d oceanbase
trap '"${compose[@]}" down --volumes --remove-orphans' EXIT

echo "Waiting for OceanBase..."
ready=0
for _ in $(seq 1 40); do
  if "${compose[@]}" exec -T oceanbase sh -c "obclient -h127.0.0.1 -P2881 -uroot@test -p\"\${OB_TENANT_PASSWORD}\" -e 'SELECT 1'" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 5
done
if [[ "$ready" != "1" ]]; then
  "${compose[@]}" logs --tail 200 oceanbase
  echo "OceanBase did not become ready" >&2
  exit 1
fi

"${compose[@]}" exec -T oceanbase sh -c \
  'obclient -h127.0.0.1 -P2881 -uroot@test -p"${OB_TENANT_PASSWORD}" -e "CREATE DATABASE IF NOT EXISTS staffdeck DEFAULT CHARACTER SET utf8mb4"'

"${compose[@]}" run --rm --no-deps staffdeck python - <<'PY'
from sqlalchemy import text
from app.db.database import engine, init_db

init_db()
with engine.connect() as conn:
    assert conn.execute(text("SELECT 1")).scalar_one() == 1
print("OceanBase SQLAlchemy initialization succeeded")
PY
