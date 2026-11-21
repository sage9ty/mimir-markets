AGENTS.md — Mimir
This repository contains Mimir, an AI-settled prediction market on
Stellar Testnet (network passphrase Test SDF Network ; September 2015,
CAIP-2 stellar:testnet).

See docs/STELLAR_NETWORK.md for the one-page architecture reference.

See docs/PUBLIC_API.md for the public read endpoints (`/api/vs`, `/api/vs/[id]`, `/api/vs/[id]/reasoning`, `/api/vs/user/[address]`, `/api/challenge-opportunities`, `/api/performance/[address]`, `/api/baskets`, `/api/payments/revenue`, `/api/health`), their params, response shapes, error envelope, `Cache-Control` headers, and rate-limit tier (`public_read`). Private claims require the `invite` parameter.

Repository layout
Path	Purpose
contracts-soroban/mimir-market/	Rust/Soroban market contract (USDC escrow, settlement, fee policy)
contracts-soroban/mimir-squad/	Rust/Soroban two-sided squad pools
lib/stellar.ts	Stellar Testnet config (RPC/Horizon, passphrase, explorer links, getEvents scans)
lib/usdc.ts	Circle Testnet USDC: Stellar Asset Contract id, issuer, 7-decimal helpers
lib/contract.ts	TypeScript contract client (reads + writes through the generated bindings)
lib/wallet.tsx	Wallet context (Stellar Wallets Kit: Freighter, xBull, Albedo, Lobstr, Hana)
lib/wallet-connectors.ts	Connector list and per-wallet capability matrix
lib/wallet-signing-coordinator.ts	Cross-tab wallet signing lease & uncertain-recovery coordinator
lib/stellar-message.ts	SEP-43 signMessage verification (Ed25519, base64)
lib/content-hash.ts	SHA-256 content hashing — the hash Soroban's host exposes
lib/agent-wallets.ts	Local Stellar keypairs for oracle / creator / council
lib/agents/wallet-adapter.ts	Vendor-neutral wallet boundary + budget policy for BYOA
lib/agents/spend-permissions.ts	Owner-signed spend permissions over the USDC SAC allowance
lib/x402/config.ts	Network, prices and Bazaar metadata for every paid endpoint
lib/x402/stellar-scheme.ts	The Stellar-native x402 exact scheme (buyer, seller, verification)
lib/x402/server.ts	x402 v2 seller paywall (@x402/next) + settlement recording
lib/x402/buyer.ts	x402 v2 buyer with a hard USDC budget cap (@x402/fetch)
agents/oracle/index.ts	Off-chain AI oracle agent (LLM + local keypair)
agents/market-creator/index.ts	Autonomous market creator (LLM + local keypair)
agents/council/	Ten AI personas that stake as economic actors
fixtures/ledger/	Versioned public-chain captures for deterministic offline replay
deploy/deploy.ts	Soroban build/deploy/initialize script
deploy/contract-artifacts.manifest.json	Pinned Wasm digests for fail-closed provenance checks
lib/ops/artifact-provenance.ts	Offline SHA-256 artifact provenance verifier
lib/ops/cache-backup.ts	Offline read-index cache-backup verifier (checksum + privacy, no network)
lib/ops/dependency-audit.ts	Fail-closed npm audit triage (production high/critical, privacy-safe)
lib/server/read-index-backup.ts	DB-backed read-index dump / verified restore (restore fingerprint check)
scripts/verify-artifact-provenance.ts	CLI: verify or --write-pins contract artifacts
scripts/verify-cache-backup.ts	CLI: offline cache-backup verification (npm run verify:cache-backup)
scripts/verify-package-scripts.ts	CLI: verify package.json script contract against disk targets and CI/CONTRIBUTING docs (npm run verify:package-scripts)
scripts/check-npm-audit.ts	CLI: triage npm audit --json (npm run audit:deps, no production secrets)
scripts/backup-read-index.ts	CLI: dump the Neon read-index to a self-verified archive
scripts/restore-read-index.ts	CLI: restore a verified archive and fingerprint-check the cache
scripts/stellar-keys.ts	Keypairs + Friendbot funding + USDC trustline
scripts/create-agent-wallets.ts	Generate 12 keypairs (oracle + creator + 10 personas)
scripts/fund-agents.ts	Fund agent accounts from a master seed
scripts/check-forbidden-terms.mjs	Guardrail: no pre-Stellar chain or bespoke-402 residue
scripts/run-browser-smoke.mjs	Browser smoke orchestrator: build + serve + test + teardown in a secret-free env
scripts/lib/browser-smoke-env.mjs	The smoke harness's strict env allowlist (what a smoke build may see)
tests/browser/ + playwright.config.ts	Playwright browser smoke suite (run via npm run smoke:browser)
Dependency vulnerability triage
npm run audit:deps triages npm audit --omit=dev --json with no production
secrets. High, critical, and unknown severities fail closed; malformed or npm
error output never counts as a clean tree. CI runs it on every PR and a weekly
scheduled workflow catches newly published advisories. See
docs/DEPENDENCY_AUDIT.md for failure, rollback, artifact, secret, and
environment behavior.

| Path | Purpose |
|------|---------|
| `contracts-soroban/mimir-market/` | Rust/Soroban market contract (USDC escrow, settlement, fee policy) |
| `contracts-soroban/mimir-squad/` | Rust/Soroban two-sided squad pools |
| `lib/stellar.ts` | Stellar Testnet config (RPC/Horizon, passphrase, explorer links, `getEvents` scans) |
| `lib/usdc.ts` | Circle Testnet USDC: Stellar Asset Contract id, issuer, 7-decimal helpers |
| `lib/contract.ts` | TypeScript contract client (reads + writes through the generated bindings) |
| `lib/wallet.tsx` | Wallet context (Stellar Wallets Kit: Freighter, xBull, Albedo, Lobstr, Hana) |
| `lib/wallet-connectors.ts` | Connector list and per-wallet capability matrix |
| `lib/wallet-signing-coordinator.ts` | Cross-tab wallet signing lease & uncertain-recovery coordinator |
| `lib/stellar-message.ts` | SEP-43 `signMessage` verification (Ed25519, base64) |
| `lib/content-hash.ts` | SHA-256 content hashing — the hash Soroban's host exposes |
| `lib/agent-wallets.ts` | Local Stellar keypairs for oracle / creator / council |
| `lib/agents/wallet-adapter.ts` | Vendor-neutral wallet boundary + budget policy for BYOA |
| `lib/agents/spend-permissions.ts` | Owner-signed spend permissions over the USDC SAC allowance |
| `lib/x402/config.ts` | Network, prices and Bazaar metadata for every paid endpoint |
| `lib/x402/stellar-scheme.ts` | The Stellar-native x402 `exact` scheme (buyer, seller, verification) |
| `lib/x402/server.ts` | x402 v2 seller paywall (`@x402/next`) + settlement recording |
| `lib/x402/buyer.ts` | x402 v2 buyer with a hard USDC budget cap (`@x402/fetch`) |
| `agents/oracle/index.ts` | Off-chain AI oracle agent (LLM + local keypair) |
| `agents/market-creator/index.ts` | Autonomous market creator (LLM + local keypair) |
| `agents/council/` | Ten AI personas that stake as economic actors |
| `fixtures/ledger/` | Versioned public-chain captures for deterministic offline replay |
| `deploy/deploy.ts` | Soroban build/deploy/initialize script |
| `deploy/contract-artifacts.manifest.json` | Pinned Wasm digests for fail-closed provenance checks |
| `lib/ops/artifact-provenance.ts` | Offline SHA-256 artifact provenance verifier |
| `lib/ops/cache-backup.ts` | Offline read-index cache-backup verifier (checksum + privacy, no network) |
| `lib/ops/package-script-contract.ts` | Offline `package.json` script contract verifier against disk targets, argument forwarding, and CI/CONTRIBUTING refs |
| `lib/server/read-index-backup.ts` | DB-backed read-index dump / verified restore (restore fingerprint check) |
| `scripts/verify-artifact-provenance.ts` | CLI: verify or `--write-pins` contract artifacts |
| `scripts/verify-cache-backup.ts` | CLI: offline cache-backup verification (`npm run verify:cache-backup`) |
| `scripts/verify-package-scripts.ts` | CLI: offline `package.json` script contract verification (`npm run verify:package-scripts`) |
| `scripts/backup-read-index.ts` | CLI: dump the Neon read-index to a self-verified archive |
| `scripts/restore-read-index.ts` | CLI: restore a verified archive and fingerprint-check the cache |
| `scripts/stellar-keys.ts` | Keypairs + Friendbot funding + USDC trustline |
| `scripts/create-agent-wallets.ts` | Generate 12 keypairs (oracle + creator + 10 personas) |
| `scripts/fund-agents.ts` | Fund agent accounts from a master seed |
| `scripts/check-forbidden-terms.mjs` | Guardrail: no pre-Stellar chain or bespoke-402 residue |
| `scripts/run-browser-smoke.mjs` | Browser smoke orchestrator: build + serve + test + teardown in a secret-free env |
| `scripts/run-node-tests.mjs` | Node test runner: deterministic discovery, process isolation, compile cache, and LCOV artifacts |
| `tests/node/node-test-runner.test.ts` | Regression tests for runner safety, cache invalidation, failure handling, and coverage publication |
| `scripts/lib/browser-smoke-env.mjs` | The smoke harness's strict env allowlist (what a smoke build may see) |
| `tests/browser/` + `playwright.config.ts` | Playwright browser smoke suite (run via `npm run smoke:browser`) |
| `docs/PUBLIC_API.md` | Reference for the public read endpoints: params, response shape, errors, cache headers, rate-limit tier |

## Browser smoke flow (must stay green on release)

`npm run smoke:browser` builds the app with a **secret-free allowlist**, serves it
locally, drives the Playwright suite in `tests/browser/` with the system
Chrome/Chromium, and tears down. CI runs it as the `browser-smoke` job. When you
add a page, a wallet gate, or an env-read, keep it green:

Never let real settings into the smoke build. The harness moves every
.env* file aside during the run and builds with only buildSmokeEnv() keys.
If the app needs a new NEXT_PUBLIC_* value to even build, add it to
SMOKE_NEXT_PUBLIC and its regression test — but that must be a value that
is safe to ship to the browser in every build.
Assert the unconfigured state, not a live one. The smoke run has no DB, no
contract ids, no secrets. It pins fail-closed behavior: health 503 critical /
db.unconfigured, empty arena feed, money paths gated behind a connect control.
Do not add an assertion that depends on a live deployment.
New public pages go into tests/browser/pages.spec.ts with a signature
heading marker from messages/en.json.
New secret-shaped env vars: if you add one, confirm it is not in the
smoke allowlist; add it to the secret samples in tests/node/browser-smoke-env.test.ts.
Run it before finishing a release-touching PR: npm run smoke:browser.
Public read endpoints are documented in `docs/PUBLIC_API.md`; keep it in sync
when adding or changing a route under `app/api/**/route.ts` (outside `agents/v1`
and `cron`).
Key rules
Contract state is the source of truth. Neon Postgres is a read-index cache only.
Two assets, one job each. Native XLM pays the ledger fee and the account
reserve, and nothing else — it is never an argument to a contract call, because
Soroban has no payable invocation. USDC (7 decimals, Circle's Testnet issuance
reached through its Stellar Asset Contract) carries every value flow: market
stakes, payouts, agent bankrolls and x402 payments.
Every account funds its own fees. There is no sponsorship, by product
decision: an operation costs ~100 stroops, so there is nothing worth sponsoring.
Stakes need no allowance. Soroban authorises per invocation:
challenge_claim carries an authorisation entry permitting exactly one USDC
transfer of exactly the staked amount. lib/contract.ts builds one transaction,
the user signs once. Allowances (lib/agents/spend-permissions.ts) exist only for
the delegated BYOA case.
A first-time account signs twice, once. A USDC trustline is a classic
operation and a transaction containing a Soroban operation must contain exactly
one operation, so the trustline cannot ride along with the stake.
Resolution is oracle-only. resolve_claim requires authorisation from the
oracle address stored in the contract. Do not expose user-triggered resolution.
Challenger settlement is pull-based. resolve_claim deliberately does not
loop over challengers: a transaction is capped on its ledger-entry footprint and
~100 challengers do not fit. It seeds remaining_escrow; each winner calls
claim_challenger_payout once, O(1), and the last claimant absorbs the dust.
withdraw and claim_fees are the other two pull paths.
Hash with SHA-256 (lib/content-hash.ts), never keccak. env.crypto().sha256()
is the Soroban host primitive, so a contract can recompute the digest; there is no
keccak host function. Both are 32 bytes, so every BytesN<32> field takes it
unchanged — but a pre-migration digest will not match a fresh one.
Agents sign with local Stellar seeds held only in the worker process env
(STELLAR_ORACLE_SECRET, CREATOR_SECRET, COUNCIL_<SLUG>_SECRET). The web
server never sees a seed — only G… addresses for display and payment routing.
G…/C… strkeys are case-sensitive base32. Never lowercase one for
comparison; the EVM toLowerCase() habit turns a valid address into one that
matches nothing.
Paid endpoints speak x402 v2 only, in the Stellar-native exact scheme: the
buyer submits its own USDC Payment and presents a signed proof; the seller reads
the transaction back off Horizon. No facilitator, no HTTP third party. Never
reintroduce manual transaction inspection or custom payment headers.
Money is accounted in atomic integers. payments_v2.amount_atomic is
NUMERIC(78,0); decimals are applied at the API/UI edge only.
When a contract in contracts-soroban/ changes, regenerate bindings
(npm run stellar:bindings) and keep lib/contract.ts in sync.
Categories: sports, weather, crypto, culture, custom (English).
Sync/read-index changes must pass npm run check:ledger-fixture; see
docs/LEDGER_REPLAY.md for artifact, secret, release, and rollback policy.
Release readiness
npm run verify:release-readiness is the release checklist as data
(lib/ops/release-readiness.ts, documented in docs/RELEASE_READINESS.md). It
runs on a clean checkout with no .env, no DATABASE_URL, no seeds and no
network:

Default (develop) mode verifies what it can run itself - checklist
coherence, artifact provenance, the cache-backup fixture, the saved-ledger
replay and the release SBOM - and reports every other gate as not
evidenced (a warning), never as a pass.
--mode=release is the funded-release gate: a blocking gate with no
recorded evidence is an error. Evidence is a small JSON file passed with
--evidence; status is only ever pass or fail, so a gate cannot be
waived, skipped or bypassed.
Privacy: a recorded detail/artifact that looks like a credential
(Stellar seed, sk-/rk- key, gh*_ token, phc_ key, AKIA key, PEM
private key, or a URL with embedded credentials) is refused, not redacted.
Changing a gate: update lib/ops/release-readiness.ts and
docs/RELEASE_READINESS.md in the same pull request. The CLI fails when the
doc stops describing a gate id or its command, and
tests/node/release-readiness.test.ts pins the registry fingerprint, so the
checklist cannot drift silently.
Rollback: the checklist deploys nothing and writes nothing to the chain or
the database. --out writes a deterministic JSON release record (no
timestamps unless --stamp) that can be diffed between releases.
Oracle agent
Bash

- Contract state is the source of truth. Neon Postgres is a read-index cache only.
- **Two assets, one job each.** Native **XLM** pays the ledger fee and the account
  reserve, and nothing else — it is never an argument to a contract call, because
  Soroban has no payable invocation. **USDC** (7 decimals, Circle's Testnet issuance
  reached through its Stellar Asset Contract) carries every value flow: market
  stakes, payouts, agent bankrolls and x402 payments.
- **Every account funds its own fees.** There is no sponsorship, by product
  decision: an operation costs ~100 stroops, so there is nothing worth sponsoring.
- Stakes need **no allowance**. Soroban authorises per invocation:
  `challenge_claim` carries an authorisation entry permitting exactly one USDC
  transfer of exactly the staked amount. `lib/contract.ts` builds one transaction,
  the user signs once. Allowances (`lib/agents/spend-permissions.ts`) exist only for
  the delegated BYOA case.
- **A first-time account signs twice, once.** A USDC trustline is a classic
  operation and a transaction containing a Soroban operation must contain exactly
  one operation, so the trustline cannot ride along with the stake.
- Resolution is oracle-only. `resolve_claim` requires authorisation from the
  `oracle` address stored in the contract. Do not expose user-triggered resolution.
- **Challenger settlement is pull-based.** `resolve_claim` deliberately does not
  loop over challengers: a transaction is capped on its ledger-entry footprint and
  ~100 challengers do not fit. It seeds `remaining_escrow`; each winner calls
  `claim_challenger_payout` once, O(1), and the last claimant absorbs the dust.
  `withdraw` and `claim_fees` are the other two pull paths.
- Hash with **SHA-256** (`lib/content-hash.ts`), never keccak. `env.crypto().sha256()`
  is the Soroban host primitive, so a contract can recompute the digest; there is no
  keccak host function. Both are 32 bytes, so every `BytesN<32>` field takes it
  unchanged — but a pre-migration digest will not match a fresh one.
- Agents sign with **local Stellar seeds** held only in the worker process env
  (`STELLAR_ORACLE_SECRET`, `CREATOR_SECRET`, `COUNCIL_<SLUG>_SECRET`). The web
  server never sees a seed — only `G…` addresses for display and payment routing.
- **`G…`/`C…` strkeys are case-sensitive base32.** Never lowercase one for
  comparison; the EVM `toLowerCase()` habit turns a valid address into one that
  matches nothing.
- Paid endpoints speak **x402 v2** only, in the Stellar-native `exact` scheme: the
  buyer submits its own USDC `Payment` and presents a signed proof; the seller reads
  the transaction back off Horizon. No facilitator, no HTTP third party. Never
  reintroduce manual transaction inspection or custom payment headers.
- Money is accounted in **atomic integers**. `payments_v2.amount_atomic` is
  `NUMERIC(78,0)`; decimals are applied at the API/UI edge only.
- When a contract in `contracts-soroban/` changes, regenerate bindings
  (`npm run stellar:bindings`) and keep `lib/contract.ts` in sync.
- Categories: `sports`, `weather`, `crypto`, `culture`, `custom` (English).
- Sync/read-index changes must pass `npm run check:ledger-fixture`; see
  `docs/LEDGER_REPLAY.md` for artifact, secret, release, and rollback policy.

## Node test workflow (must stay green on release)

The release entry point is `npm run test:node`; `test:smoke` remains an alias
for callers that already use it. The runner discovers all
`tests/node/*.test.ts` files in deterministic order and explicitly preserves
Node's process-per-file isolation. It never uses shared-process test mode or
reruns only previously failed files.

The default runner creates `.cache/node-tests/` with Node's
`NODE_COMPILE_CACHE`. This is a compile-only optimization: no test result,
assertion, or coverage data is reused as a pass signal. The cache directory is
versioned by the Node version, lockfile, `tsx` version, and runner version;
a dependency, runtime, or runner change therefore misses the cache. Use
`--no-cache` for a forced cold run and `--clear-cache` before diagnosing a
cache problem. CI caches the same directory, but the manifest and versioned
path prevent stale entries from being trusted.

The runner uses a strict child-environment allowlist. It does not load
`.env.local` and does not pass production seeds, Stellar credentials, LLM keys,
database URLs, or arbitrary environment variables. Database-backed tests skip
unless the operator explicitly supplies `--with-db`; that option is for an
isolated test database only. A clean checkout must be able to run the default
suite with no network credentials, wallet seed, LLM key, or database.

`npm run test:node:coverage` runs the same complete suite and writes a fresh
LCOV report. On success the atomic artifact is
`coverage/node/node-tests.lcov`; on test failure it is
`coverage/node/node-tests.failed.lcov`, and the process still exits nonzero.
CI uploads either report with `if: always()` so a failed or cache-cold run is
observable. Reports contain source paths and coverage data, not environment
values or credentials. Coverage is supplemental reporting, not a reason to
skip tests, lower thresholds, or switch to shared process isolation.

Release and rollback rules:

- Run `npm run lint`, `npm run typecheck`, `npm run test:node:coverage`, and
  the contract/artifact checks before merging a runner change. A coverage
  report is not a substitute for the passing test exit status.
- Keep the cache and coverage directories ignored; never upload or commit
  either directory as a source artifact.
- To roll back, revert the runner, package scripts, and CI cache/artifact
  wiring. Removing `.cache/node-tests/` is sufficient for a local cache
  rollback. No contract, chain, database, or deployment rollback is required
  because the workflow performs no writes outside the ignored local/CI cache
  and coverage directories.

## Oracle agent

```bash
# Start the oracle (needs STELLAR_ORACLE_SECRET + an LLM key)
npm run oracle
The oracle polls for active claims past their deadline, fetches evidence,
evaluates with an LLM, and sends resolve_claim to the contract on Stellar Testnet.

Agents bootstrap
Bash

# 1. Generate all twelve keypairs (writes seeds + addresses into .env.local)
npm run agents:create-wallets

# 2. Fund from a master account (Friendbot tops up the master only).
#    Each agent needs test USDC for stakes plus a little XLM for fees and reserve.
npm run agents:fund

# 3. Deploy and initialize the contracts
npm run deploy:contract

# 4. Verify artifact provenance (no secrets), then the live deployment
npm run verify:artifacts
npm run verify:deployment
npm run smoke:onchain

# 5. Run workers
npm run workers   # oracle + market-creator + council + sync + traders
Buying data over x402 needs no sponsor and no separate approval: the agent pays
its own ~100-stroop fee and its own USDC. XLM is required for every write the
agent makes, including those payments.

Faucets: XLM from Friendbot (https://lab.stellar.org/account/fund), test USDC from
https://faucet.circle.com
Explorer: https://stellar.expert/explorer/testnet
Public endpoints (rate-limited): https://soroban-testnet.stellar.org and
https://horizon-testnet.stellar.org

## Traders

Mimir includes three demo BYOA (Bring Your Own Agent) traders in [`agents/traders/`](../agents/traders) that stake their own USDC against open claims:
- **Momentum Forecaster** (`momentum-forecaster`, 📈): Follows the prevailing trend and base rate.
- **Contrarian Fader** (`contrarian-fader`, 🔻): Fades crowded, over-extended claims.
- **Quant Thresholder** (`quant-thresholder`, 📐): Takes claims whose numeric threshold is extreme relative to remaining time.

Each persona evaluates claims using Groq (`LLM_PROVIDER="groq"`), optionally purchases an oracle second opinion over x402, and signs challenge transactions using its own funded Stellar wallet.

Run the trader worker standalone:
```bash
npx tsx agents/traders/index.ts
```
Or bundled with the other fleet workers:
```bash
npm run workers
```

### Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `TRADER_POLL_INTERVAL_MS` | `900000` (15m) | Polling cadence in milliseconds between market evaluation cycles. |
| `TRADER_POLL_JITTER_MS` | `90000` (10% of interval) | Random spread in milliseconds applied to the cycle interval (unset defaults to 10% of `TRADER_POLL_INTERVAL_MS`; `0` restores fixed scheduling). |
| `TRADER_MAX_STAKES_PER_CYCLE` | `1` | Maximum number of open claims each trader persona will challenge per cycle. |
| `TRADER_MAX_PAID_READS_PER_CYCLE` | `3` | Maximum number of paid oracle second opinions bought per trader per cycle. Set to `0` to disable paid reads entirely. |
| `TRADER_DRY_RUN` | `""` (disabled) | When set to `"1"`, logs decisions and planned stakes without broadcasting on-chain transactions or spending USDC. |
| `MIMIR_URL` | `""` | Base URL of the Mimir app instance (e.g. `http://localhost:3000`) used to buy x402 oracle second opinions via `POST /api/oracle`. Second-opinion purchase is skipped when unset or empty. |
| `TRADER_BUY_ORACLE` | `"1"` (enabled) | Set to `"0"` to disable purchasing oracle second opinions over x402, evaluating claims using only persona reasoning. Any other value or unset enables oracle purchases. |
| `TRADER_MOMENTUM_SECRET` | _(none)_ | Stellar secret seed (`S…`) for the Momentum Forecaster persona (`momentum-forecaster`). Trader is skipped if unset or invalid. |
| `TRADER_CONTRA_SECRET` | _(none)_ | Stellar secret seed (`S…`) for the Contrarian Fader persona (`contrarian-fader`). Trader is skipped if unset or invalid. |
| `TRADER_QUANT_SECRET` | _(none)_ | Stellar secret seed (`S…`) for the Quant Thresholder persona (`quant-thresholder`). Trader is skipped if unset or invalid. |
| `TRADER_MOMENTUM_PUBLIC` | _(derived)_ | Stellar public key (`G…`) for the Momentum Forecaster persona. Derived from secret key by wallet tooling. |
| `TRADER_CONTRA_PUBLIC` | _(derived)_ | Stellar public key (`G…`) for the Contrarian Fader persona. Derived from secret key by wallet tooling. |
| `TRADER_QUANT_PUBLIC` | _(derived)_ | Stellar public key (`G…`) for the Quant Thresholder persona. Derived from secret key by wallet tooling. |
| `GROQ_API_KEY` | _(none)_ | Groq API key used for trader LLM inference (`agents/traders/index.ts` sets `LLM_PROVIDER = "groq"`). |

## Demo seed claims

Preview the fixed demo claim set without a signer, contract id, or network access:

```bash
npm run seed:dry -- --at 2030-01-01T00:00:00Z
```

`--at` requires an explicit timezone and is accepted only with `--dry-run`; every
preview then has stable absolute deadlines. A live `npm run seed` uses the current
clock and requires `CREATOR_SECRET`, a configured Testnet market contract, and
sufficient creator USDC. It does not use `STELLAR_DEPLOYER_SECRET`: demo market
stakes must be signed by the dedicated creator wallet, not a deployment authority.

Live writes are chain-first and cannot be rolled back as a batch. The script reports
each failed transaction and continues, so inspect the resulting claim IDs/transactions
before rerunning to avoid duplicate markets. Cancel an untouched claim only when the
contract permits it; once challenged, resolve and settle it through the normal
contract flow rather than editing or deleting read-index data. Generated signer
seeds remain private in local environment files and must never be committed.

## Read-index cache backup / restore (devx)

The Neon read-index is a cache, so its backup workflow is deliberately
verifiable without any network credentials — that is what makes the safety
property testable on a clean checkout and in CI.

- **Backup** (`npm run backup:read-index -- --out backups/x.json`) needs only
  `DATABASE_URL`. It dumps the projection tables (`claims`, `challengers`,
  `sync_meta`, `market_settlements`, `fee_accruals`, `fee_claims`,
  `fee_policies`, `agent_revenue_attribution`) and refuses to emit a byte unless
  its own checksum and privacy invariants pass. No seeds, no RPC, no LLM keys.
- **Verify** (`npm run verify:cache-backup -- <file>`) is a pure SHA-256 +
  schema + privacy check (`lib/ops/cache-backup.ts`). Fail-closed findings:
  `BACKUP_INVALID`, `BACKUP_KIND_MISMATCH`, `BACKUP_SCHEMA_UNSUPPORTED`,
  `BACKUP_MISSING_TABLE`, `BACKUP_UNKNOWN_TABLE`, `BACKUP_EMPTY`,
  `BACKUP_CHECKSUM_MISMATCH`, `BACKUP_PRIVATE_CONTENT_LEAK`. A private claim's
  scrubbed content fields must stay `null` in the archive.
- **Restore** (`npm run restore:read-index -- <file> [--dry-run]`) requires
  `DATABASE_URL`. An unverified archive is refused before any write; writes run
  in one transaction so a failure rolls back; afterwards the cache is re-read
  and its fingerprint is compared against the archive's checksum.
- **Rollback**: restore any verified archive, or — because contract state is
  the source of truth — re-warm from chain (`npm run warm:vs-index` / `npm run
  sync`). Restoring never writes to the chain.
- **Adding a table/column to the projection**: update `TABLE_SPECS` in
  `lib/server/read-index-backup.ts` **and** the regression-pinned
  `READ_INDEX_TABLES` list in `lib/ops/cache-backup.ts`, then regenerate the
  `valid.json` fixture. A column added to Postgres but not to `TABLE_SPECS` is
  intentionally never backed up — this is a feature (a secret-shaped column
  cannot sneak into archives) and it fails loud if you forget to wire it.
- Never commit real archives to the repo. The committed fixture in
  `tests/fixtures/cache-backup/valid.json` is synthetic.

## Schema snapshot gate (devx)

The Postgres schema is the ordered `SCHEMA_STATEMENTS` list in `lib/db.ts`; there
is no separate migration runner, so a schema edit ships on merge. The gate makes
that change reviewable:

- **Verify** (`npm run check:schema-snapshot`) rebuilds the snapshot from
  `getSchemaStatements()` and compares it with
  `schemas/db-schema.snapshot.json` (`lib/ops/schema-snapshot.ts`). Pure — no
  `DATABASE_URL`, no network, no secrets. It is a CI gate.
- **Update** a schema, index, or `schema_migrations` row, then run
  `npm run check:schema-snapshot -- --write` and commit the snapshot in the same
  pull request. Fail-closed findings: `SNAPSHOT_MISSING`, `SNAPSHOT_INVALID`,
  `EMPTY_SCHEMA`, `FINGERPRINT_MISMATCH`, `TABLE_DRIFT`, `INDEX_DRIFT`,
  `MIGRATION_DRIFT`, `MIGRATION_DUPLICATE_VERSION`, `MIGRATION_UNREGISTERED`.
- **Rollback**: revert the schema change and the snapshot together, then rerun
  the check; reverting only one leaves the gate failing by design. The read index
  is disposable and can be rebuilt from chain (`npm run warm:vs-index`).
- Every new table or index must ship with a `schema_migrations` registration; a
  schema with no registered migration fails `MIGRATION_UNREGISTERED`.
- Policy: [`docs/SCHEMA_SNAPSHOTS.md`](./SCHEMA_SNAPSHOTS.md).

## Cross-tab wallet signing coordinator (`lib/wallet-signing-coordinator.ts`)

`lib/wallet-signing-coordinator.ts` coordinates wallet signing ownership across open browser tabs and within the same tab for `signTransaction`, `signAuthEntry`, `signMessage` (`lib/wallet.tsx`), and `ensureUsdcTrustline` (`lib/stellar-trustline.ts`).

- **Nonsecret operation identity**: Persisted storage (`mimir:wallet-signing-coordinator:v1`) and cross-tab `BroadcastChannel` payloads store only public metadata: `operationId`, normalized public `account`, `tabId`, `operationKind` (`"sign_transaction" | "sign_auth_entry" | "sign_message" | "enable_trustline"`), `status` (`"active" | "uncertain_recovery"`), `acquiredAt`, `heartbeatAt`, `expiresAt`, and optional recovery metadata (`uncertainAt`, `recoveryReason`). Unsigned/signed XDR, secret seeds, auth tokens, messages, and private notes are never stored.
- **Same-account mutual exclusion**: Only one active signing operation is allowed per normalized Stellar account at a time across tabs (`active_in_other_tab` / `active_in_same_tab`), while independent accounts can sign concurrently and sequential prompts proceed immediately after `release()`.
- **Heartbeat & bounded `uncertain_recovery`**: Active leases refresh via heartbeat (`heartbeat()` / 5 s interval, 30 s default TTL). If an owning tab unloads (`pagehide` / `beforeunload`) without releasing or its lease expires (`now > expiresAt`), the record transitions to bounded `status: "uncertain_recovery"` (capped by `maxRecords` and `recoveryRetentionMs`) instead of silently stealing ownership. Subsequent prompts for that account remain blocked until the user explicitly acknowledges recovery via `acknowledgeUncertainRecovery` / `dismissSigningRecovery` or opts into retry (`acknowledgeUncertainRecovery: true`).
- **Injectable test boundary & React integration**: `createWalletSigningCoordinator({ storage, channel, events, now, ... })` injects storage, channels, lifecycle events, and clock deterministically for Node tests without browser globals. `WalletProvider` (`lib/wallet.tsx`) wraps `signTransaction`, `signAuthEntry`, and `signMessage` and exposes non-breaking optional fields on `WalletContextValue` (`signingOwnership`, `signingBlockedByOtherTab`, `signingRecovery`, `acknowledgeSigningRecovery`, `dismissSigningRecovery`, `retryAfterSigningRecovery`). `ensureUsdcTrustline` (`lib/stellar-trustline.ts`) acquires an `"enable_trustline"` lease and unwraps the underlying signer via `resolveUncoordinatedSignTransaction` so it never self-deadlocks against `WalletProvider.signTransaction`.
