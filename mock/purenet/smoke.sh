#!/usr/bin/env bash
# Smoke-test a running PureNet mock (npm run mock:purenet). Invalid requests get the contract's 400 (Prism's fallback is 422 only when no 400 is declared).
set -u
BASE="${PURENET_MOCK_URL:-http://127.0.0.1:4010}"
AUTH=(-H "Authorization: Bearer test-token")
EX="$(dirname "$0")/examples"
fail=0

check() { # expected-status description curl-args...
  local want=$1 desc=$2; shift 2
  local got; got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [[ $got == "$want" ]]; then echo "ok   $got $desc"; else echo "FAIL $got (want $want) $desc"; fail=1; fi
}

check 200 "search members"            "${AUTH[@]}" "$BASE/members?identifier=urn:purenet:member-id%7CMBR-TEST-0001"
check 200 "get member"                "${AUTH[@]}" "$BASE/members/MBR-TEST-0001"
check 200 "list consents"             "${AUTH[@]}" "$BASE/members/MBR-TEST-0001/consents"
check 201 "create subscription"       "${AUTH[@]}" -H 'Content-Type: application/json' -d @"$EX/subscription-request.json" "$BASE/subscriptions"
check 204 "delete subscription"       "${AUTH[@]}" -X DELETE "$BASE/subscriptions/sub_test_0001"
check 401 "no token is rejected"                   "$BASE/members/MBR-TEST-0001"
check 400 "missing identifier rejected" "${AUTH[@]}" "$BASE/members"
check 400 "http callback rejected"    "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"callbackUrl":"http://insecure.example.com","eventTypes":["member.updated"]}' "$BASE/subscriptions"
exit $fail
