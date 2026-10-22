# PureNet mock

Prism serves `docs/contracts/purenet.openapi.yaml` (ADR-0002). **Everything here is INFERRED**: it reflects what
we *assume* PureNet does (see `docs/contracts/ASSUMPTIONS.md`), not verified behaviour.

```bash
npm run mock:purenet                                 # or: docker compose -f mock/purenet/docker-compose.yml up
npm run smoke:purenet                                # in another terminal
curl -H 'Authorization: Bearer x' http://127.0.0.1:4010/members/MBR-TEST-0001
curl -H 'Authorization: Bearer x' -H 'Prefer: dynamic=true' http://127.0.0.1:4010/members/MBR-TEST-0001   # random valid data
```

Prism checks for the presence of a bearer token, but not whether it's valid. It's stateless and doesn't push
events. Event payload examples are in `docs/contracts/purenet-events.asyncapi.yaml`.
