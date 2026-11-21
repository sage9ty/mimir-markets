/**
 * Deterministic coverage of x402 Stellar payment verification.
 *
 * Everything here runs against an in-memory Horizon fixture — no Testnet, no
 * secrets — and every negative case is built by mutating a proof that WOULD have
 * verified, so a refusal cannot be a "well, it was never valid anyway" false
 * positive. Positive, negative, failure and regression cases all live here;
 * sustained concurrency is the load suite (`x402-load.test.ts`).
 */

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  ExactStellarFacilitator,
  X402_FRESHNESS_POLICY_VERSION,
  defaultFreshnessPolicy,
} from "../../lib/x402/stellar-scheme";
import type { StellarHorizonReader } from "../../lib/x402/stellar-scheme";
import { X402_NETWORK } from "../../lib/x402/config";
import {
  FIXTURE_ASSET_CODE,
  FIXTURE_ASSET_ISSUER,
  FIXTURE_CONTRACT_PAYTO,
  FIXTURE_PAYER,
  FIXTURE_SECOND_PAYER,
  FIXTURE_SELLER_PUBLIC,
  fakeHorizonBackend,
  landedPayment,
  makeRequirements,
  nextTxHash,
  parsePaymentProof,
  proofPayer,
  runX402Load,
  settleFixtures,
  signedProof,
  toPaymentPayload,
  verifyWithBackend,
  type LandedPayment,
} from "./x402-fixtures";

const NOW = 1_800_000_000_000;
const MAX_AGE_MS = 5 * 60 * 1000;

type LandedPaymentOpts = NonNullable<Parameters<typeof landedPayment>[0]>;
type FixtureBackend = ReturnType<typeof fakeHorizonBackend>;

beforeEach(() => settleFixtures.reset());

function ready(overrides: LandedPaymentOpts = {}): { payment: LandedPayment; backend: FixtureBackend } {
  // A payment that satisfies the default quote, landed just now.
  const payment = landedPayment({ createdAtMs: NOW - 1_000, ...overrides });
  const backend = fakeHorizonBackend([payment]);
  return { payment, backend };
}

function verify(overrides: {
  requirements?: ReturnType<typeof makeRequirements>;
  proof?: ReturnType<typeof signedProof>;
  transaction?: string;
  backend?: StellarHorizonReader;
  maxAgeMs?: number;
  now?: number;
} = {}) {
  const requirements = overrides.requirements ?? makeRequirements();
  const fixture = ready();
  const backend = overrides.backend ?? fixture.backend;
  const proof =
    overrides.proof ??
    signedProof(overrides.transaction ?? fixture.payment.transaction, requirements);
  return verifyWithBackend(proof, requirements, backend, {
    maxAgeMs: overrides.maxAgeMs ?? MAX_AGE_MS,
    now: overrides.now ?? NOW,
  });
}

// ── Positive ──────────────────────────────────────────────────────────────────

test("a freshly signed proof for a just-landed payment verifies", async () => {
  const { payment, backend } = ready();
  const result = await verify({ transaction: payment.transaction, backend });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.transaction, payment.transaction);
  assert.equal(result.payer, FIXTURE_PAYER.publicKey());
  assert.equal(result.amountAtomic, 10_000n);
});

test("a payment that overpays the quote still verifies, reporting what was paid", async () => {
  const { backend } = ready({ amountAtomic: 20_000n });
  const requirements = makeRequirements();
  const proof = signedProof(backend.records.values().next().value!.transaction, requirements);
  const result = await verifyWithBackend(proof, requirements, backend, {
    maxAgeMs: MAX_AGE_MS,
    now: NOW,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.amountAtomic, 20_000n);
});

test("two payment operations in one transaction sum, so a batched payment is not overcharged", async () => {
  const transaction = nextTxHash();
  const payment = landedPayment({
    transaction,
    createdAtMs: NOW - 1_000,
    operations: [
      {
        type: "payment",
        from: FIXTURE_PAYER.publicKey(),
        to: FIXTURE_SELLER_PUBLIC,
        asset_type: "credit_alphanum4",
        asset_code: FIXTURE_ASSET_CODE,
        asset_issuer: FIXTURE_ASSET_ISSUER,
        amount: "0.0005",
        transaction_successful: true,
      },
      {
        type: "payment",
        from: FIXTURE_PAYER.publicKey(),
        to: FIXTURE_SELLER_PUBLIC,
        asset_type: "credit_alphanum4",
        asset_code: FIXTURE_ASSET_CODE,
        asset_issuer: FIXTURE_ASSET_ISSUER,
        amount: "0.0005",
        transaction_successful: true,
      },
    ],
  });
  const backend = fakeHorizonBackend([payment]);
  const requirements = makeRequirements();
  const proof = signedProof(transaction, requirements);
  const result = await verifyWithBackend(proof, requirements, backend, {
    maxAgeMs: MAX_AGE_MS,
    now: NOW,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.amountAtomic, 10_000n);
});

test("the facilitator settles exactly once and books the quote, then refuses replay", async () => {
  const { payment } = ready();
  const backend = fakeHorizonBackend([payment]);
  const requirements = makeRequirements();
  const payload = toPaymentPayload(
    signedProof(payment.transaction, requirements),
    requirements,
  );
  const facilitator = new ExactStellarFacilitator(backend);

  const verified = await facilitator.verify(payload, requirements);
  assert.equal(verified.isValid, true);
  assert.equal(verified.payer, FIXTURE_PAYER.publicKey());

  const settled = await facilitator.settle(payload, requirements);
  assert.equal(settled.success, true);
  assert.equal(settled.transaction, payment.transaction);
  // `exact` books the quote, never the observed (possibly larger) amount.
  assert.equal(settled.amount, requirements.amount);

  const replay = await facilitator.settle(payload, requirements);
  assert.equal(replay.success, false);
  assert.equal(replay.errorReason, "already_settled");
  const replayVerify = await facilitator.verify(payload, requirements);
  assert.equal(replayVerify.isValid, false);
  assert.equal(replayVerify.invalidReason, "already_settled");
});

// ── Proof immutability (regression): a proof cannot be moved ──────────────────

test("the same payment cannot be moved to a dearer quote", async () => {
  const { payment } = ready({ amountAtomic: 10_000n });
  const quote = makeRequirements();
  const proof = signedProof(payment.transaction, quote);
  const dearer = makeRequirements({ amount: "20000" });
  const result = await verify({ proof, requirements: dearer });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_signature");
});

test("the same payment cannot be moved to another seller", async () => {
  const { payment } = ready();
  const quote = makeRequirements();
  const proof = signedProof(payment.transaction, quote);
  const elsewhere = makeRequirements({ payTo: FIXTURE_SECOND_PAYER.publicKey() });
  const result = await verify({ proof, requirements: elsewhere });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_signature");
});

test("a proof names the network, so it cannot be replayed on another one", async () => {
  const { payment } = ready();
  const quote = makeRequirements();
  const proof = signedProof(payment.transaction, quote);
  const wrongNetwork = { ...proof, network: "stellar:pubnet" };
  const result = await verify({ proof: wrongNetwork });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "network_mismatch");
});

// ── Negative ──────────────────────────────────────────────────────────────────

test("a forged signature is refused", async () => {
  const { backend } = ready();
  const requirements = makeRequirements();
  const proof = signedProof(backend.records.values().next().value!.transaction, requirements);
  const tampered = { ...proof, signature: Buffer.alloc(64, 7).toString("base64") };
  const result = await verify({ proof: tampered, backend });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_signature");
});

test("an account that did not pay cannot claim the payment even by signing a proof", async () => {
  const { backend } = ready();
  const requirements = makeRequirements();
  const transaction = backend.records.values().next().value!.transaction;
  const stolen = signedProof(transaction, requirements, FIXTURE_SECOND_PAYER);
  const result = await verify({ proof: stolen, backend });
  assert.equal(result.ok, false);
  // The signature is valid — but the ledger shows the fixture PAYER paid, not
  // the claimant, so there is no matching payment.
  assert.equal(result.reason, "no_matching_payment");
});

test("a proof whose payer field was swapped after signing is refused", async () => {
  const { backend } = ready();
  const requirements = makeRequirements();
  const proof = signedProof(backend.records.values().next().value!.transaction, requirements);
  const stolen = { ...proof, payer: FIXTURE_SECOND_PAYER.publicKey() };
  const result = await verify({ proof: stolen, backend });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_signature");
});

test("a quote for an unsupported asset is refused before any read", async () => {
  const { backend } = ready();
  const requirements = makeRequirements({ asset: "USDC:GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCVZPJELFFNQEXAMPLE" });
  const proof = signedProof(backend.records.values().next().value!.transaction, requirements);
  const result = await verify({ proof, requirements, backend });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported_asset");
});

test("a quote paying a contract address is refused — classic payments cannot target one", async () => {
  const requirements = makeRequirements({ payTo: FIXTURE_CONTRACT_PAYTO });
  const transaction = nextTxHash();
  const proof = signedProof(transaction, requirements);
  const result = await verify({ proof, requirements, backend: fakeHorizonBackend([]) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported_pay_to");
});

test("an invented transaction hash is refused as not on the ledger", async () => {
  const { backend } = ready();
  const requirements = makeRequirements();
  const proof = signedProof("f".repeat(64), requirements);
  const result = await verify({ proof, backend });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transaction_not_found");
});

test("a transaction that failed is refused even though it is on the ledger", async () => {
  const { backend } = ready({ successful: false });
  const requirements = makeRequirements();
  const proof = signedProof(backend.records.values().next().value!.transaction, requirements);
  const result = await verify({ proof, backend });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "transaction_failed");
});

test("a payment older than the freshness window is refused", async () => {
  const { backend } = ready({ createdAtMs: NOW - MAX_AGE_MS - 1_000 });
  const requirements = makeRequirements();
  const proof = signedProof(backend.records.values().next().value!.transaction, requirements);
  const result = await verify({ proof, backend, maxAgeMs: MAX_AGE_MS });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "payment_too_old");
});

test("a payment landing exactly at the window edge still passes", async () => {
  const { backend } = ready({ createdAtMs: NOW - MAX_AGE_MS });
  const requirements = makeRequirements();
  const proof = signedProof(backend.records.values().next().value!.transaction, requirements);
  const result = await verify({ proof, backend, maxAgeMs: MAX_AGE_MS });
  assert.equal(result.ok, true);
});

test("a payment to someone else does not pay this seller", async () => {
  const { backend } = ready({ to: FIXTURE_SECOND_PAYER.publicKey() });
  const requirements = makeRequirements();
  const proof = signedProof(backend.records.values().next().value!.transaction, requirements);
  const result = await verify({ proof, backend });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_matching_payment");
});

test("a native XLM payment cannot satisfy a USDC quote", async () => {
  const transaction = nextTxHash();
  const payment = landedPayment({
    transaction,
    createdAtMs: NOW - 1_000,
    operations: [{ type: "payment", from: FIXTURE_PAYER.publicKey(), to: FIXTURE_SELLER_PUBLIC, asset_type: "native", amount: "10" }],
  });
  const backend = fakeHorizonBackend([payment]);
  const requirements = makeRequirements();
  const proof = signedProof(transaction, requirements);
  const result = await verify({ proof, backend });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_matching_payment");
});

test("a payment below the quote is refused as insufficient", async () => {
  const { backend } = ready({ amountAtomic: 5_000n });
  const requirements = makeRequirements();
  const proof = signedProof(backend.records.values().next().value!.transaction, requirements);
  const result = await verify({ proof, backend });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient_amount");
});

test("a one-stroop payment still satisfies a one-stroop quote", async () => {
  const requirements = makeRequirements({ amount: "1" });
  const transaction = nextTxHash();
  const payment = landedPayment({ transaction, amountAtomic: 1n, createdAtMs: NOW - 1_000 });
  const backend = fakeHorizonBackend([payment]);
  const proof = signedProof(transaction, requirements);
  const result = await verify({ proof, requirements, backend });
  assert.equal(result.ok, true);
});

// ── Failure behaviour (fail closed, never guess) ──────────────────────────────

test("a payload that is not a stellar-payment proof is malformed, not free", async () => {
  const { backend } = ready();
  const requirements = makeRequirements();
  const result = await verifyWithBackend(
    { notA: "proof" },
    requirements,
    backend,
    { maxAgeMs: MAX_AGE_MS, now: NOW },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "malformed_proof");
});

test("an unreadable Horizon refuses verification instead of guessing", async () => {
  const { backend } = ready();
  const requirements = makeRequirements();
  const proof = signedProof(backend.records.values().next().value!.transaction, requirements);
  const down = fakeHorizonBackend(
    [backend.records.values().next().value!],
    true, // failReads
  );
  const result = await verify({ proof, backend: down });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "horizon_unavailable");
});

test("an operations read failure after the transaction read refuses too", async () => {
  const { payment } = ready();
  const requirements = makeRequirements();
  const proof = signedProof(payment.transaction, requirements);
  const flaky = {
    getTransaction: async () => ({ createdAtMs: NOW - 1_000, successful: true }),
    getPaymentOperations: async () => {
      throw new Error("ops page timed out");
    },
  };
  const result = await verify({ proof, backend: flaky });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "horizon_unavailable");
});

test("an unreachable replay ledger fails open to the in-process set", async () => {
  // With no DATABASE_URL the durable layer is simply absent; a fresh hash must
  // still settle exactly once and be refused immediately afterwards.
  settleFixtures.reset();
  assert.equal(await settleFixtures.consume(X402_NETWORK, "a".repeat(64)), true);
  assert.equal(await settleFixtures.inspect(X402_NETWORK, "a".repeat(64)), true);
  assert.equal(await settleFixtures.consume(X402_NETWORK, "a".repeat(64)), false);
});

// ── Wire-format regressions ───────────────────────────────────────────────────

test("the wire parser narrows only well-formed proofs", () => {
  const requirements = makeRequirements();
  const proof = signedProof(nextTxHash(), requirements);
  assert.deepEqual(parsePaymentProof(proof), proof);
  assert.equal(parsePaymentProof(null), null);
  assert.equal(parsePaymentProof({ kind: "other" }), null);
  assert.equal(parsePaymentProof({ ...proof, transaction: "zzzz" }), null);
  assert.equal(parsePaymentProof({ ...proof, payer: "not-an-address" }), null);
  assert.equal(proofPayer(proof), FIXTURE_PAYER.publicKey());
  assert.equal(proofPayer({}), null);
});

test("a proof for a transaction hash that fails the shape checks is malformed", () => {
  const requirements = makeRequirements();
  const proof = signedProof(nextTxHash(), requirements);
  const payload = { ...proof, transaction: "not-hex".padEnd(64, "e") };
  assert.equal(parsePaymentProof(payload), null);
});

// ── Load smoke: a small, deterministic run must stay green ────────────────────

test("200 concurrent, distinct verifications all read their own payment", async () => {
  const stats = await runX402Load({ count: 200, concurrency: 40, now: NOW, maxAgeMs: MAX_AGE_MS });
  assert.equal(stats.verifiedOk, 200);
  assert.equal(stats.settledOk, 200);
  assert.equal(stats.replaysRefused, 200);
  // Two Horizon reads per verification — every proof was checked against its own
  // landed payment, not a shared fixture.
  assert.equal(stats.txReads, 200);
  assert.equal(stats.opsReads, 200);
  assert.equal(stats.consumedAfter, 200);
});

// ── Freshness policy versioning & explanation ─────────────────────────────────

test("successful verification returns applied policy, observation time, and explanation", async () => {
  const { payment, backend } = ready();
  const requirements = makeRequirements();
  const proof = signedProof(payment.transaction, requirements);
  const result = await verifyWithBackend(proof, requirements, backend, {
    maxAgeMs: MAX_AGE_MS,
    now: NOW,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.observedAt, NOW);
  assert.deepEqual(result.policy, {
    version: X402_FRESHNESS_POLICY_VERSION,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.ok(result.explanation);
  assert.ok(result.explanation.includes(X402_FRESHNESS_POLICY_VERSION));
  assert.ok(result.explanation.includes("is within window"));
});

test("ExactStellarFacilitator verify and settle propagate policy, observedAt, and explanation in extra", async () => {
  const { payment } = ready();
  const backend = fakeHorizonBackend([payment]);
  const requirements = makeRequirements();
  const payload = toPaymentPayload(
    signedProof(payment.transaction, requirements),
    requirements,
  );
  const facilitator = new ExactStellarFacilitator(backend);

  const verified = await facilitator.verify(payload, requirements);
  assert.equal(verified.isValid, true);
  assert.ok(verified.extra);
  assert.equal(typeof verified.extra.observedAt, "number");
  assert.deepEqual(verified.extra.policy, {
    version: X402_FRESHNESS_POLICY_VERSION,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.ok(typeof verified.extra.explanation === "string");

  const settled = await facilitator.settle(payload, requirements);
  assert.equal(settled.success, true);
  assert.ok(settled.extra);
  assert.equal(typeof settled.extra.observedAt, "number");
  assert.deepEqual(settled.extra.policy, {
    version: X402_FRESHNESS_POLICY_VERSION,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.ok(typeof settled.extra.explanation === "string");
  assert.ok(settled.extra.explanation.includes("is within window"));
});

test("verification failure on payment_too_old includes observedAt, policy, and failure explanation", async () => {
  const { backend } = ready({ createdAtMs: NOW - MAX_AGE_MS - 5_000 });
  const requirements = makeRequirements();
  const proof = signedProof(backend.records.values().next().value!.transaction, requirements);
  const result = await verifyWithBackend(proof, requirements, backend, {
    maxAgeMs: MAX_AGE_MS,
    now: NOW,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "payment_too_old");
  assert.equal(result.observedAt, NOW);
  assert.deepEqual(result.policy, {
    version: X402_FRESHNESS_POLICY_VERSION,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.ok(result.explanation);
  assert.ok(result.explanation.includes("exceeds window"));
  assert.ok(result.explanation.includes(X402_FRESHNESS_POLICY_VERSION));
});

test("ExactStellarFacilitator.getExtra advertises policyVersion and default freshness policy", () => {
  const facilitator = new ExactStellarFacilitator();
  const extra = facilitator.getExtra("stellar:testnet");
  assert.ok(extra);
  assert.equal(extra.policyVersion, X402_FRESHNESS_POLICY_VERSION);
  assert.deepEqual(extra.policy, {
    version: X402_FRESHNESS_POLICY_VERSION,
    maxAgeMs: MAX_AGE_MS,
  });
});
