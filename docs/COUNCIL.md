# The Mimir Council

**Ten AI personas. Ten local Stellar keypairs. One prediction market on Stellar.**

The Mimir Council is a group of ten autonomous AI personas that read the same on-chain claims and place real **USDC** stakes on Stellar Testnet — each through its own locally held `S…` seed. Together with the oracle (settler) and the market-creator, they bring Mimir's economic actor count to twelve.

The point isn't to find a single "best" trader. It's the opposite: by giving ten personas distinct worldviews, evaluation styles, and category filters, the council surfaces real disagreement on every market. Where one persona stakes, another abstains. Where the contrarian fights the crowd, the whale-watcher copies it.

---

## Table of contents

- [Why a council](#why-a-council)
- [The council persona roster](#the-council-persona-roster)
- [Architecture](#architecture)
- [Decision pipeline](#decision-pipeline)
- [Self-resolving settlement](#self-resolving-settlement)
- [Rate-limit strategy](#rate-limit-strategy)
- [Local setup](#local-setup)
- [Production deploy](#production-deploy)
- [Configuration reference](#configuration-reference)
- [Where the council shows up in the UI](#where-the-council-shows-up-in-the-ui)

---

## Why a council

A single oracle that decides everything is a single point of failure — and a single voice. Real prediction markets get their information density from heterogenous opinions. The Mimir Council is the in-protocol version of that: a deliberate spread of strategies so the market always has multiple AI views to react to.

Each persona is, by design, *wrong sometimes*. The Optimist over-weights positive outcomes. The Contrarian ignores evidence entirely and only fights pool imbalance. The Doomer assumes worst-case. None of them is a settlement oracle (that's still the dedicated oracle agent's job) — they're **bettors**, putting USDC on the line with their own bias.

---

## The council persona roster

The council is organized into two jury tracks: the 10 classic personas in `agents/council/personas.ts` and the 10 philosopher personas in `agents/council/philosophers.ts`.

### Key Derivation & Wallet Environment Naming

Key derivations follow `lib/agent-wallets.ts` via `councilEnvSlug`, `councilSecretEnv`, and `councilPublicEnv`:
- **Secret seed (`S…`):** `COUNCIL_<SLUG>_SECRET` (worker-only, holds local signing keypair).
- **Public key (`G…`):** `COUNCIL_<SLUG>_PUBLIC` (web-server safe, used for UI display, routing, and payment verification).

### Council persona roster and wallet environments

| Slug | Display Name | Rule / LLM | Category Filter | Secret Env | Public Env |
|---|---|---|---|---|---|
| `optimist` | 🌞 The Optimist | LLM-based | All | `COUNCIL_OPTIMIST_SECRET` | `COUNCIL_OPTIMIST_PUBLIC` |
| `pessimist` | 🌧️ The Pessimist | LLM-based | All | `COUNCIL_PESSIMIST_SECRET` | `COUNCIL_PESSIMIST_PUBLIC` |
| `contrarian` | 🔁 The Contrarian | Rule-based | All | `COUNCIL_CONTRARIAN_SECRET` | `COUNCIL_CONTRARIAN_PUBLIC` |
| `statistician` | 📊 The Statistician | LLM-based | All | `COUNCIL_STATISTICIAN_SECRET` | `COUNCIL_STATISTICIAN_PUBLIC` |
| `whale-watcher` | 🐋 The Whale-Watcher | Rule-based | All | `COUNCIL_WHALE_WATCHER_SECRET` | `COUNCIL_WHALE_WATCHER_PUBLIC` |
| `crypto-maxi` | ₿ Crypto Maximalist | LLM-based | crypto, defi, token | `COUNCIL_CRYPTO_MAXI_SECRET` | `COUNCIL_CRYPTO_MAXI_PUBLIC` |
| `sports-pundit` | 🏈 Sports Pundit | LLM-based | sports, soccer, nba, nfl, tennis, f1 | `COUNCIL_SPORTS_PUNDIT_SECRET` | `COUNCIL_SPORTS_PUNDIT_PUBLIC` |
| `weatherman` | 🌤️ The Weatherman | LLM-based | weather, climate | `COUNCIL_WEATHERMAN_SECRET` | `COUNCIL_WEATHERMAN_PUBLIC` |
| `doomer` | 💀 The Doomer | LLM-based | All | `COUNCIL_DOOMER_SECRET` | `COUNCIL_DOOMER_PUBLIC` |
| `yapper` | 🗣️ The Yapper | LLM-based | All | `COUNCIL_YAPPER_SECRET` | `COUNCIL_YAPPER_PUBLIC` |
| `socrates` | 🏛️ Socrates | LLM-based | All | `COUNCIL_SOCRATES_SECRET` | `COUNCIL_SOCRATES_PUBLIC` |
| `ada` | ⚙️ Ada Lovelace | LLM-based | All | `COUNCIL_ADA_SECRET` | `COUNCIL_ADA_PUBLIC` |
| `feynman` | 🔬 Richard Feynman | LLM-based | All | `COUNCIL_FEYNMAN_SECRET` | `COUNCIL_FEYNMAN_PUBLIC` |
| `kahneman` | 🧠 Daniel Kahneman | LLM-based | All | `COUNCIL_KAHNEMAN_SECRET` | `COUNCIL_KAHNEMAN_PUBLIC` |
| `taleb` | 🎲 Nassim Taleb | LLM-based | All | `COUNCIL_TALEB_SECRET` | `COUNCIL_TALEB_PUBLIC` |
| `munger` | 🔄 Charlie Munger | LLM-based | All | `COUNCIL_MUNGER_SECRET` | `COUNCIL_MUNGER_PUBLIC` |
| `machiavelli` | 🗝️ Niccolò Machiavelli | LLM-based | All | `COUNCIL_MACHIAVELLI_SECRET` | `COUNCIL_MACHIAVELLI_PUBLIC` |
| `meadows` | 🔗 Donella Meadows | LLM-based | All | `COUNCIL_MEADOWS_SECRET` | `COUNCIL_MEADOWS_PUBLIC` |
| `aurelius` | 🛡️ Marcus Aurelius | LLM-based | All | `COUNCIL_AURELIUS_SECRET` | `COUNCIL_AURELIUS_PUBLIC` |
| `lao-tzu` | ☯️ Lao Tzu | LLM-based | All | `COUNCIL_LAO_TZU_SECRET` | `COUNCIL_LAO_TZU_PUBLIC` |

**Rule-based vs LLM-based personas:**
- **Rule-based (`contrarian`, `whale-watcher`):** Derive stakes purely from on-chain pool imbalance or top-staker positions. They never call an LLM, keeping them fast, deterministic, and free of API rate limits.
- **LLM-based:** All other personas (including the entire philosopher jury track) query Gemini with specific persona framing, bias modifiers, or multi-step reasoning rubrics.

### Disabling philosophers (`COUNCIL_PHILOSOPHERS=0`)

By default, the council worker runs both the classic personas and the philosopher jury track. Set `COUNCIL_PHILOSOPHERS=0` in the environment to disable the philosopher track entirely and run only the classic council personas. You can also specify an optional comma-separated list of philosopher slugs via `COUNCIL_PHILOSOPHERS_ACTIVE` to activate only selected philosophers.

---

## Architecture

```mermaid
flowchart LR
    subgraph keys[Local agent seeds - worker env only]
        EOAs[Stellar keypairs<br/>oracle + creator + 10 personas]
    end

    subgraph worker[Council worker - Railway]
        LOOP[Poll loop<br/>every 180s default]
        CACHE[Per-cycle evidence cache<br/>1 fetch per claim, shared by all personas]
        GAP[Decision gap<br/>30s default]
        TH[LLM throttle<br/>8s between calls]
    end

    subgraph chain[Stellar Testnet]
        CT[mimir-market · Soroban]
    end

    subgraph llm[LLM]
        GEM[Gemini 2.5 Flash<br/>or Anthropic / Groq / OpenRouter]
    end

    LOOP -->|read claim count<br/>per-claim get_claim| CT
    LOOP --> CACHE
    LOOP -->|persona-by-persona<br/>serial within cycle| GAP
    GAP --> TH
    TH -->|biased prompt| GEM
    TH -->|stake decision| EOAs
    EOAs -->|challenge_claim<br/>auth entry, no allowance| CT

    classDef no-llm stroke-dasharray: 4 4
    LOOP -.->|"Contrarian + Whale-Watcher<br/>(rule-based, no LLM)"| EOAs
```

Three independent runtime tiers:

1. **Worker tier (Railway)** — single Node process boots all ten personas. They poll sequentially within a cycle to keep LLM-call volume bounded.
2. **Signer tier (local seeds)** — each persona has `COUNCIL_<SLUG>_SECRET` (an `S…` seed). Seeds never leave the worker env. The web server only knows public `COUNCIL_<SLUG>_PUBLIC` (`G…`) values for payment routing and UI.
3. **Settlement tier (`mimir-market`)** — personas only call `challenge_claim`. Resolution stays exclusively with the oracle keypair (`get_oracle`), and market creation stays with the market-creator (`get_owner`).

---

## Decision pipeline

For every (persona, claim) pair, the runner walks this sequence:

```
1. Skip if claim is private, self-created, full, or persona already staked.
2. Skip if persona has a category filter and the claim is out of scope.
3. Check the persona's USDC balance — need 2x base stake as buffer.
4. Branch on archetype:
   ├── rule-based  → evaluate from on-chain pool (no LLM)
   └── llm/specialist/micro → fetch evidence (cached) → throttled LLM call
5. If decision is "stake":
   ├── LLM personas apply Kelly sizing capped at 10% of bankroll
   └── Rule personas use their spec's base stake unchanged
6. Submit challenge_claim with the persona's local seed; log council-<slug>-<claimId>.
```

The verdict from the LLM is the same schema the oracle uses (`CREATOR_WINS` / `CHALLENGERS_WIN` / `DRAW` / `UNRESOLVABLE`). A persona that decides `CREATOR_WINS` simply abstains — `challenge_claim` is the only on-chain action available to a non-creator, so personas can only ever join the challenger side.

There is no approval step before the stake: Soroban authorises per invocation, so
`challenge_claim` carries an authorisation entry permitting exactly one USDC transfer
of exactly the staked amount. Each persona's account funds its own sub-cent XLM fee.

---

## Self-resolving settlement

Beyond trading, the eligible personas also act as a paid **settlement jury**. The baseline mode (`COUNCIL_SETTLEMENT=1`) buys every eligible persona's verdict in parallel-blind fashion and settles by majority tally. The upgraded mode (`COUNCIL_SELF_RESOLVING=1`) turns that jury into a **self-resolving prediction market**, adapting [Srinivasan, Karger & Chen (arXiv:2306.04305)](https://arxiv.org/abs/2306.04305):

```mermaid
flowchart LR
    P0["prior<br/>q0 = 0.5"] --> J1
    subgraph jury[Sequential jury — shuffled order]
        J1["Juror 1<br/>reports q1"] -->|"history"| J2["Juror 2<br/>reports q2"]
        J2 -->|"α-coin: stop?"| JN["Juror n<br/>reports qn"]
    end
    JN --> REF["Oracle terminal report qT<br/>independent evidence + full history"]
    REF -->|"settles claim"| CHAIN["resolve_claim()<br/>evidence_hash ⊃ {q-chain, qT, scores}"]
    REF -->|"CE score vs qT"| BONUS["bonus pool split<br/>USDC transfer → positive scorers"]
```

1. **Sequential reports with visible history.** Jurors are shuffled, then vote one at a time through the paid `GET /api/council/vote` endpoint.
2. **Probability, not just a verdict.** Each `verdict + confidence` maps to `q = P(challengers win)`.
3. **Random termination.** Once `COUNCIL_QUORUM` decisive reports exist, each further vote happens only with probability `1 − COUNCIL_ALPHA`.
4. **Terminal reference.** The oracle makes the final assessment from its own independently fetched evidence *plus* the full juror history.
5. **Cross-entropy payouts.** Positive scorers split the `COUNCIL_BONUS_USDC` pool via USDC transfers into their own wallets after settlement. The flat $0.001 vote fee stays as the participation floor.
6. **Auditability.** The q-chain, `qT`, and per-juror scores are serialized into the payload whose SHA-256 is committed on chain as `evidence_hash`.

The mechanism lives in `agents/oracle/council-vote.ts` (pure scoring math is unit-tested in `tests/node/self-resolving.test.ts`); the oracle wiring is in `agents/oracle/index.ts` (`settle()`).

| Variable | Default | Effect |
|---|---|---|
| `COUNCIL_SELF_RESOLVING` | off | `1` enables the mechanism (requires `COUNCIL_SETTLEMENT=1`) |
| `COUNCIL_QUORUM` | `3` | Min decisive votes before council settles; invalid values normalize to 3 (see `lib/council/quorum.ts`) |
| `COUNCIL_ALPHA` | `0.25` | Per-vote stop probability after quorum |
| `COUNCIL_BONUS_USDC` | `0.01` | Total cross-entropy bonus pool per settlement; `0` pauses bonuses, maximum `1`, exact 7-decimal USDC |

### Bonus payout safety and operations

The oracle pays bonuses only after a fresh Soroban read confirms the claim is
`resolved` with the expected outcome and evidence hash. A pending transaction,
cancelled/stale claim, or unavailable RPC withholds bonuses without changing
the market's funded settlement. Only jurors with a paid vote and a response
wallet matching the worker's configured `COUNCIL_<SLUG>_PUBLIC` address qualify.
The pool is split in atomic 7-decimal USDC; dust remains with the oracle.

Bonus transfers are separate classic Stellar payments from the oracle wallet,
not claims on the market escrow. The worker checks its USDC balance, then
reserves each `(network, contract, claim, juror)` payout in Postgres before
submitting. `DATABASE_URL` must be available for bonuses; a database failure
withholds them but never rolls back the already-final market settlement. A
duplicate reservation is skipped. A transfer or receipt-update failure leaves
the row in `review` or `reserved`, **not** eligible for automatic retry: the
operator must inspect the settlement hash, intended recipient/amount, and
Horizon transaction history before reconciling it. Do not reset the row or
replay a payment solely because no receipt was logged.

For rollback, set `COUNCIL_BONUS_USDC=0` before deploying an older worker;
otherwise an older build bypasses the reservation ledger and can double-pay.
Keep the `council_bonus_payouts` table for audit and manual reconciliation.
No schema migration or contract redeploy is needed for the funded market
state; the new table is created by the existing database bootstrap.

### Quorum policy revision

Every aggregate council decision records the quorum policy revision under
which it was computed. The revision is a stable reference to the quorum
policy (its threshold and normalization rules) and does not change when
policy defaults are edited, so historical decisions remain interpretable.
Replaying captured ballots against the recorded revision reproduces the
original result deterministically; ballots are never re-scored under a
newer policy default.

---

## Council policy comparison runner

The policy comparison runner replays **captured council ballots** against two
quorum/confidence policies and reports which settlement decisions would change.
It evaluates both policies on identical fixtures, makes no model-provider calls,
and writes results only to a temporary state directory.


---

## Rate-limit strategy

LLM providers can 429 if the council rushes a crowded market. The worker is intentionally calm by default: it focuses on one deadline-prioritized claim per cycle and spaces persona decisions apart.

| Guard | Where | Effect |
|---|---|---|
| **Per-cycle evidence cache** | `agents/council/shared/evidence-cache.ts` | Each claim's resolution URL is fetched at most once per cycle. |
| **`COUNCIL_MAX_CLAIMS`** | `agents/council/index.ts` | Caps work at the N claims closest to their deadline. Defaults to 1. |
| **`COUNCIL_DECISION_DELAY_MS`** | `agents/council/index.ts` | Spaces persona decisions/stakes. Defaults to 30,000ms. |
| **LLM throttle** | `agents/council/shared/persona-runner.ts` | Extra serial gap of `COUNCIL_LLM_THROTTLE_MS` (default 8000ms). |
| **Peer reads** | `agents/council/shared/peer-reasoning.ts` | Optional HTTP 402 council-to-council reasoning buys. Enable with `COUNCIL_PEER_READS=1`. |

Rule-based personas (`contrarian`, `whale-follow`) and out-of-category specialists never trigger the throttle.

The market-creator can buy council opinions before opening a market via `POST /api/council/preflight`. Those preflight calls pay into each persona's wallet just like settlement votes do.

When `COUNCIL_PEER_READS=1`, each buyer persona pays selected seller personas through `GET /api/council/reasoning`, so revenue lands directly in the seller persona's wallet and appears on `/revenue`.

---

## Local setup

```bash
# 1. Provision all agent keypairs (oracle + creator + 10 personas). Idempotent.
npm run agents:create-wallets

# 2. Fund from a master account. Each persona needs test USDC for stakes plus a
#    little XLM for the account reserve and its own ledger fees.
#    XLM:  Friendbot — https://lab.stellar.org/account/fund
#    USDC: https://faucet.circle.com
npm run agents:fund

# 3. Run the council worker.
npm run council
```

To run the oracle, market-creator, and council together:

```bash
npm run workers
```

---

## Production deploy

`railway.json` points at `npm run workers`. Add the council env vars below on Railway; the worker starts a third process alongside the oracle and market-creator.

To scale the council down temporarily, leave some `COUNCIL_<SLUG>_SECRET` vars unset — the worker skips any persona missing its key at boot and warns once.

---

## Configuration reference

Wallet pairs are generated by `scripts/create-agent-wallets.ts` and written into `.env.local` automatically.

| Variable | Purpose |
|---|---|
| `COUNCIL_<SLUG>_SECRET` / `_PUBLIC` | Secret seed (`S…`) and public key (`G…`) for each persona (see roster table above) |
| `COUNCIL_PHILOSOPHERS` | Set to `0` to disable philosopher jury track (default: `1`) |
| `COUNCIL_PHILOSOPHERS_ACTIVE` | Optional CSV subset of philosopher slugs to run |
| `COUNCIL_POLL_INTERVAL_MS` | Cycle interval in ms (default 180_000). |
| `COUNCIL_MAX_CLAIMS` | Max claims evaluated per cycle (default 1). |
| `COUNCIL_DECISION_DELAY_MS` | Min ms between persona decisions/stakes (default 30000). |
| `COUNCIL_LLM_THROTTLE_MS` | Min ms between LLM calls (default 8000). |
| `COUNCIL_PASS_TTL_MS` | Council pass lifetime in ms (default `600000`, capped at `86400000`). Malformed values fall back to the default — see `lib/council/pass-ttl.ts`. |
| `COUNCIL_PEER_READS` | `1` to buy peer reasoning before deciding. |
| `COUNCIL_PEER_READ_CAP_USDC` | Max accepted HTTP 402 quote per peer read (default `0.003`). |
| `MARKET_CREATOR_PREFLIGHT` | `1` to force paid council preflight for market creation. |
| `MARKET_CREATOR_PREFLIGHT_CAP_USDC` | Max accepted quote per preflight read (default `0.005`). |

LLM credentials (`GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / etc.) are shared with the oracle and market-creator.

---

## Where the council shows up in the UI

| Page | What it shows |
|---|---|
| `/council` | Full roster — persona card per member with bio, archetype badge, balance, total staked, and last four bets. |
| `/agents` | Council members appear as agent events with their persona pill in the live feed. |
| `/stats` | "Unique stakers" KPI splits human / council / other. Agent vault shows oracle + creator XLM fee balances. |
| `/vs/[id]` | A `Council verdict` card under the settlement explanation. Data from `/api/vs/[id]/council` (pure on-chain read). |

The widget on `/vs/[id]` only reflects what's already on chain — it doesn't ask personas to evaluate on demand.

---

## A note on bias

Each persona's prompt explicitly tells the model: *"Never invent evidence. Cite what you actually saw above."* The biases are mood/style modifiers, not licenses to hallucinate. When the evidence is empty or contradictory, every persona — even the Yapper — is expected to return `UNRESOLVABLE`. The runner respects that; an UNRESOLVABLE verdict is always an abstention, never a stake.
