# Copy executor threat model

- Compromised executor key: it cannot raise signed limits, change token/spender,
  bypass the on-chain USDC allowance, or act after immediate revoke/global pause.
- Replay: permission/source-position uniqueness and execution IDs make a repeated
  signal a skip. Nonces protect signed API requests.
- Frontrun/race: the executor re-reads deadline, slots, liquidity, payout and
  allowance, then simulates against Soroban RPC at a recorded ledger immediately
  before submission.
- Stale odds: payout below the signed floor or an expired deadline is skipped.
- Copy loop: source depth is capped at one; self-copy and ancestry cycle checks
  reject A→B→A. Signal and execution agent IDs remain separate.
- Fee loop: one immutable `sourceAttributionId` follows the original signal.
  Downstream copies do not mint new fee ancestry, and recipient transfers are not
  interpreted as additional revenue.
- Changed spender: v1 permissions allow only the configured deployed Mimir contract
  id. A different `C…` target requires a new, visibly signed permission; UI/database
  allowlists alone are insufficient.
- Address fidelity: `G…`/`C…` strkeys are case-sensitive base32, so the token and
  spender are compared exactly. A `toLowerCase()` normalisation would silently
  break the match — and an allowlist written the wrong way round would break it
  *open*.
- Allowance shape: the on-chain leg is the USDC Stellar Asset Contract's SEP-41
  `approve(from, spender, amount, expiration_ledger)` — a single decreasing bucket
  with an expiry, which does not refresh. The rolling-period budget the follower
  actually signed for is Mimir's own accounting on top; both must pass, so
  exceeding either is a skip.

Every decision writes source position, permission, simulation ledger, attribution,
stake, fee lines, tx hash and status/skip reason to the audit ledger.

- Allowance reconciliation: `lib/copy-allowance-reconciliation.ts` compares the
  owner-signed copy policy, the authoritative Soroban SAC allowance (and
  optional `SpendPermissionRecord`), and observed rolling consumption to emit a
  read-only discrepancy report (`mode: "read_only"`, `remediationApplied: false`)
  before any remediation action is taken. Malformed or non-atomic inputs fail
  closed with a `malformed_input` critical discrepancy.
