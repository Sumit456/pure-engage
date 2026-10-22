#!/usr/bin/env bash
# Local PostgreSQL for development and tests, kept in ./.pgdata (gitignored). Trust auth on 127.0.0.1 only.
# Usage: scripts/dev-db.sh start|stop|status|reset
# Not needed if you already have Postgres: set PE_DATABASE_URL / PE_TEST_DATABASE_URL instead.
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN="${PGBIN:-$(pg_config --bindir 2>/dev/null || ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA="$PWD/.pgdata"
PORT="${PE_DB_PORT:-5433}"
USER_NAME=pure_engage

# initdb refuses to run as root; use the postgres system user in that case.
as_owner() { if [[ $(id -u) == 0 ]]; then runuser -u postgres -- "$@"; else "$@"; fi; }

start() {
  if [[ ! -f "$DATA/PG_VERSION" ]]; then
    mkdir -p "$DATA"; [[ $(id -u) == 0 ]] && chown postgres "$DATA"
    as_owner "$PGBIN/initdb" -D "$DATA" -U "$USER_NAME" --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null
  fi
  if ! as_owner "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
    as_owner "$PGBIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w \
      -o "-p $PORT -k $DATA -c listen_addresses=127.0.0.1" start >/dev/null
  fi
  for db in pure_engage pure_engage_test; do
    "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U "$USER_NAME" -d postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 \
      || "$PGBIN/createdb" -h 127.0.0.1 -p "$PORT" -U "$USER_NAME" "$db"
  done
  echo "Postgres ready: postgres://$USER_NAME@127.0.0.1:$PORT/pure_engage (tests use pure_engage_test)"
}

case "${1:-start}" in
  start) start ;;
  stop) as_owner "$PGBIN/pg_ctl" -D "$DATA" stop -m fast ;;
  status) as_owner "$PGBIN/pg_ctl" -D "$DATA" status ;;
  reset) as_owner "$PGBIN/pg_ctl" -D "$DATA" stop -m fast 2>/dev/null || true; rm -rf "$DATA"; start ;;
  *) echo "usage: $0 start|stop|status|reset"; exit 2 ;;
esac
