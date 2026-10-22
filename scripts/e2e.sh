#!/usr/bin/env bash
# End-to-end against the Prism mocks: token → member sync, then signed events → receiver → ingest.
set -euo pipefail
cd "$(dirname "$0")/.."
export PURENET_WEBHOOK_SECRET="${PURENET_WEBHOOK_SECRET:-whsec_e2e_local_only}"
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT

wait_for() { for _ in $(seq 1 40); do curl -s -o /dev/null "$1" && return 0; sleep 0.5; done; echo "timeout waiting for $1"; return 1; }

npx prism mock -h 127.0.0.1 -p 4010 docs/contracts/purenet.openapi.yaml >/dev/null 2>&1 & pids+=($!)
npx prism mock -h 127.0.0.1 -p 4011 docs/contracts/purenet-oauth.openapi.yaml >/dev/null 2>&1 & pids+=($!)
PORT=4100 node src/server.js >/dev/null & pids+=($!)
wait_for http://127.0.0.1:4010/members/x
wait_for http://127.0.0.1:4011/oauth2/token
wait_for http://127.0.0.1:4100/healthz

echo "== 1. member sync (OAuth token from mock → search → consents → mapping)"
node scripts/sync-member.mjs MBR-TEST-0001

echo "== 2. signed events, each sent twice (second round must be duplicates)"
node scripts/emit-events.mjs --twice

echo "== 3. tampered signature must be rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'x-purenet-signature: t=1,v1=0000000000000000000000000000000000000000000000000000000000000000' -d '{}' http://127.0.0.1:4100/hooks/purenet)
[[ $code == 401 ]] && echo "ok 401" || { echo "FAIL got $code"; exit 1; }

echo "== 4. what was ingested"
ingested=$(curl -s http://127.0.0.1:4100/_dev/ingested)
echo "$ingested"
n=$(node -e 'console.log(JSON.parse(process.argv[1]).length)' "$ingested")
[[ $n == 3 ]] && echo "ok: 3 events ingested once each" || { echo "FAIL: expected 3 ingested payloads, got $n"; exit 1; }
