# API contract fixtures for independent clients

Download [`fixtures/api-contract/v1.json`](../fixtures/api-contract/v1.json) from
the same revision as the API you integrate with. It is ordinary JSON; a Python,
Go, Rust or browser client can load it without installing Mimir's SDK. The host
`https://mimir.example` and every address, timestamp, balance and signature are
synthetic. The signature is 64 zero bytes in base64 and will fail real signature
verification. These examples are for offline clients and fake transports.

The suite contains twelve request/response exchanges plus schema negotiation,
signature-message, timestamp-boundary, retry-header and complete error-catalogue
examples. Request `body` is the exact HTTP body string, or `null` for reads, so
the invalid-JSON case can be replayed faithfully. Response headers list the
contract-relevant headers; runtime-added headers such as `content-type` may also
be present. `fixtureVersion` versions this artifact format;
`apiSchemaVersion` identifies the existing schema helper version.

## Offline use

For example, an independent Python client can inspect a successful read and a
rejection without contacting a deployment:

```python
import json

with open("fixtures/api-contract/v1.json", encoding="utf-8") as source:
    suite = json.load(source)

exchanges = {case["id"]: case for case in suite["exchanges"]}
read = exchanges["market-read"]
assert read["request"]["method"] == "GET"
assert read["response"]["body"]["item"]["id"] == 42

rejection = exchanges["market-invalid-id"]["response"]
assert rejection["status"] == 400
assert rejection["body"]["error"]["code"] == "invalid_request"
assert rejection["body"]["error"]["retryable"] is False
```

Use the request entries as fake-transport inputs and their response entries as
expected output. The automated suite also executes real GET/POST route handlers
against fake index snapshots, authentication and spendable balances, with all
network access rejected. Authentication success in these tests does not make the
placeholder signature valid. No funded transaction is constructed or submitted.

## Supported behavior preserved

- Public market reads retain their plain `{item, cache}` JSON shape. They do not
  acquire a `schemaVersion` wrapper or a schema-version header in this change.
- `resolveRequestVersion` allows reads without a version and requires it when
  called with `mutating: true`. Leading zeroes and surrounding whitespace remain
  accepted; unsupported and malformed versions remain distinct verdicts. These
  helper verdicts are not invented HTTP error codes.
- Signed agent writes still use the envelope's `version: "v1"`. Valid responses
  keep `x-mimir-schema-version: 1`, `cache-control: no-store` and trace headers.
  Some existing validation failures carry only `error.message` (and sometimes
  `details`). Their fixtures preserve that shape; clients must tolerate a missing
  `error.code` and use the HTTP status. This change does not retrofit those routes.
- `checkShape` reports unexpected fields separately from `ok`. The agent route
  rejects those reported extras. A 128-character nonce is allowed; 129 characters
  are rejected before verification or persistence. Timestamp skew is inclusive
  at five minutes in either direction.
- `errorCatalogue` publishes every existing `ApiErrorCode`, HTTP status,
  `retryable` flag, retry delay and structured error example directly from
  `apiErrorCatalogue`/`apiError`. No public error codes are added. A zero retry
  delay omits `retry-after`; fractional positive delays round up in the header.
  Trace IDs are correlation labels, never authorization credentials.
- `dry-run-exact-balance` and `dry-run-one-atomic-short` compare integer atomic
  USDC strings against the minimum stake. USDC has seven decimal places;
  `20000000` atomic units equal 2 USDC. Existing display fields remain in display
  USDC. XLM remains for fees/reserve, and contract state remains authoritative.
  The fixture suite does not change pull payouts or worker-held signing keys.

## Verify and update

```sh
npm ci
npm run check:api-fixtures
npm run test:api-fixtures
npm run test:node
npm run typecheck
```

The fixture test is automatically discovered by the existing Node test runner.
It validates signed request shapes against `validateAgentApiRequest` and
`validateAgentRequestEnvelope`, pins the error catalogue to the helper output,
checks route responses and proves deterministic generation under another clock
and ambient trace. Negative tests cover wrong types, unexpected fields, malformed
JSON, unsupported versions and byte/nonce/timestamp/USDC boundaries.

After an intentional contract change, regenerate and review the JSON diff:

```sh
npm run check:api-fixtures -- --write
npm run test:api-fixtures
```

The check exits nonzero for a missing or stale artifact, naming the regeneration
command. Generated data never uses a live clock, random key, environment secret,
database or RPC. Revert the fixture, generator and documentation together to roll
back; no contract, funded state or deployment rollback is involved.

Before this suite, independent clients had OpenAPI examples embedded in YAML and
separate helper tests. They now have one deterministic JSON artifact with exact
request bytes, expected HTTP results and executable route checks. The PR should
include the actual focused and workspace results, including any upstream failures.

Rendered error example from `market-invalid-id`:

```http
HTTP/1.1 400

{"error":{"code":"invalid_request","message":"Invalid VS id","retryable":false,"field":"id"}}
```
