/*
 * Payments revenue ledger — tracks the x402 USDC settlements Mimir's paid
 * endpoints earn.
 *
 * Accounting is done on atomic integers (`amount_atomic`, USDC 7dp). Decimal
 * conversion happens in the API/UI layer only — never in the ledger, never in
 * the SUMs. Durable in Neon (payments_v2); falls back to an in-memory ring
 * buffer (last 1000 events) when DATABASE_URL is unset, so serving never breaks.
 */

import {
  getMarketRevenueSummary,
  insertPayment,
  getPaymentsRevenueSummary,
  type PaymentsRevenueSummary,
} from "./db";
import { USDC_DECIMALS, USDC_SYMBOL, unitsToUsdc } from "./usdc";
import type { VerificationTrace } from "./x402/decision-trace";

export interface PaymentEvent {
  /** Which endpoint earned it (e.g. /api/premium/price). */
  resource: string;
  scheme: string;
  /**
   * CAIP-2, e.g. `stellar:testnet` — the value `X02_NETWORK` resolves to in
   * `lib/x402/config.ts`, handed straight through by the `onAfterSettle` hook in
   * `lib/x402/server.ts` as `result.network`.
   */
  network: string;
  assetAddress: string;
  /** Settled amount in atomic token units. */
  amountAtomic: bigint;
  payer: string | null;
  seller: string | null;
  transactionHash: string | null;
  /** x402 authorization/settlement id — the idempotency key. */
  paymentIdentifier: string;
  facilitator: string;
  settledAt: number;
  /**
   * Optional privacy-safe verification decision trace. Never persisted to the
   * durable store; only surfaced on the in-memory view.
   */
  verificationTrace?: VerificationTrace;
}

const MAX = 1000;
const events: PaymentEvent[] = [];

/**
 * Record a settled payment. Never throws — accounting must not break serving.
 * Returns the durable-write promise so callers can `await` it: on Vercel the
 * serverless function is frozen right after the response returns, which drops
 * any fire-and-forget insert still in flight.
 */
export function recordPayment(e: PaymentEvent): Promise<void> {
  // In-memory mirror (instant, and the only store when no DB is configured).
  try {
    if (!events.some((x) => x.paymentIdentifier === e.paymentIdentifier)) {
      events.push(e);
      if (events.length > MAX) events.splice(0, events.length - MAX);
    }
  } catch {
    /* ignore */
  }
  // Durable write — swallow errors (e.g. DB not configured) but log them. The
  // unique (network, payment_identifier) index makes a retry idempotent.
  return insertPayment({
    resource: e.resource,
    scheme: e.scheme,
    network: e.network,
    asset_address: e.assetAddress,
    asset_symbol: USDC_SYMBOL,
    asset_decimals: USDC_DECIMALS,
    amount_atomic: e.amountAtomic,
    payer: e.payer,
    seller: e.seller,
    transaction_hash: e.transactionHash,
    payment_identifier: e.paymentIdentifier,
    facilitator: e.facilitator,
    settled_at: e.settledAt,
    created_at: Date.now(),
  }).catch((err) => {
    console.warn("[payments] durable write failed:", err instanceof Error ? err.message : err);
  });
}

/** One recent payment, decimals applied for display. */
export interface RevenuePaymentView {
  resource: string;
  network: string;
  assetSymbol: string;
  amountUsdc: number;
  payer: string | null;
  seller: string | null;
  transactionHash: string | null;
  at: number;
  /** Privacy-safe verification decision, present only for in-memory events. */
  verification?: VerificationTrace;
}

export interface RevenueSummary {
  totalCalls: number;
  /** Portion of totalCalls carried over from an earlier deployment (0 when unset). */
  baselineCalls: number;
  totalUsdc: number;
  /** Portion of totalUsdc carried over from an earlier deployment (0 when unset). */
  baselineUsdc: number;
  uniquePayers: number;
  uniqueSellers: number;
  byResource: Array<{ resource: string; calls: number; usdc: number }>;
  bySeller: Array<{ seller: string; calls: number; usdc: number }>;
  recent: RevenuePaymentView[];
  market: {
    settledMarkets: number;
    grossVolumeUsdc: number;
    payoutUsdc: number;
    platformFeeUsdc: number;
    agentOwnerFeeUsdc: number;
    dustUsdc: number;
    unclaimedUsdc: number;
  };
}

const EMPTY_MARKET: RevenueSummary["market"] = {
  settledMarkets: 0,
  grossVolumeUsdc: 0,
  payoutUsdc: 0,
  platformFeeUsdc: 0,
  agentOwnerFeeUsdc: 0,
  dustUsdc: 0,
  unclaimedUsdc: 0,
};

/**
 * Volume served before a database reset. Those rows may be gone, so displayed
 * totals resume on top of these figures instead of restarting at zero. Left
 * unset for the Stellar migration — the counter starts fresh on testnet USDC.
 */
function positiveEnvNumber(key: string): number {
  const n = Number(process.env[key] ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function baselineCalls(): number {
  return Math.floor(positiveEnvNumber("PAYMENTS_BASELINE_CALLS"));
}

export function baselineUsdc(): number {
  return Math.round(positiveEnvNumber("PAYMENTS_BASELINE_USDC") * 1e6) / 1e6;
}

function fromDbSummary(s: PaymentsRevenueSummary): RevenueSummary {
  return {
    totalCalls: s.totalCalls,
    baselineCalls: 0,
    baselineUsdc: 0,
    totalUsdc: unitsToUsdc(s.totalAtomic),
    uniquePayers: s.uniquePayers,
    uniqueSellers: s.uniqueSellers,
    byResource: s.byResource.map((r) => ({
      resource: r.resource,
      calls: r.calls,
      usdc: unitsToUsdc(r.amountAtomic),
    })),
    bySeller: s.bySeller.map((r) => ({
      seller: r.seller,
      calls: r.calls,
      usdc: unitsToUsdc(r.amountAtomic),
    })),
    recent: s.recent.map((r) => ({
      resource: r.resource,
      network: r.network,
      assetSymbol: r.asset_symbol,
      amountUsdc: unitsToUsdc(r.amount_atomic),
      payer: r.payer,
      seller: r.seller,
      transactionHash: r.transaction_hash,
      at: r.settled_at,
    })),
    market: EMPTY_MARKET,
  };
}

function inMemorySummary(limit: number, offset: number): RevenueSummary {
  const byResource = new Map<string, { calls: number; atomic: bigint }>();
  const bySeller = new Map<string, { calls: number; atomic: bigint }>();
  const payers = new Set<string>();
  const sellers = new Set<string>();
  let totalAtomic = 0n;
  for (const e of events) {
    totalAtomic += e.amountAtomic;
    // Grouped on the exact string. Folding case here did not merely mis-key the
    // map: `bySeller` is keyed by this value and the key is what /revenue renders,
    // so a lowercased `G…` was surfaced to the UI as the seller's address.
    if (e.payer) payers.add(e.payer);
    if (e.seller) {
      const seller = e.seller;
      sellers.add(seller);
      const s = bySeller.get(seller) ?? { calls: 0, atomic: 0n };
      s.calls += 1;
      s.atomic += e.amountAtomic;
      bySeller.set(seller, s);
    }
    const r = byResource.get(e.resource) ?? { calls: 0, atomic: 0n };
    r.calls += 1;
    r.atomic += e.amountAtomic;
    byResource.set(e.resource, r);
  }
  return {
    totalCalls: events.length,
    baselineCalls: 0,
    baselineUsdc: 0,
    totalUsdc: unitsToUsdc(totalAtomic),
    uniquePayers: payers.size,
    uniqueSellers: sellers.size,
    byResource: [...byResource.entries()]
      .map(([resource, v]) => ({ resource, calls: v.calls, usdc: unitsToUsdc(v.atomic) }))
      .sort((a, b) => b.usdc - a.usdc),
    bySeller: [...bySeller.entries()]
      .map(([seller, v]) => ({ seller, calls: v.calls, usdc: unitsToUsdc(v.atomic) }))
      .sort((a, b) => b.usdc - a.usdc),
    recent: events
      .slice()
      .reverse()
      .slice(offset, offset + limit)
      .map((e) => ({
        resource: e.resource,
        network: e.network,
        assetSymbol: USDC_SYMBOL,
        amountUsdc: unitsToUsdc(e.amountAtomic),
        payer: e.payer,
        seller: e.seller,
        transactionHash: e.transactionHash,
        at: e.settledAt,
        ...(e.verificationTrace ? { verification: e.verificationTrace } : {}),
      })),
    market: EMPTY_MARKET,
  };
}

/** Durable summary from Neon; falls back to the in-memory buffer on any error. */
export async function getRevenueSummary(limit = 25, offset = 0): Promise<RevenueSummary> {
  const withBaseline = (s: RevenueSummary): RevenueSummary => {
    const calls = baselineCalls();
    const usdc = baselineUsdc();
    if (calls === 0 && usdc === 0) return s;
    return {
      ...s,
      totalCalls: s.totalCalls + calls,
      baselineCalls: calls,
      totalUsdc: Math.round((s.totalUsdc + usdc) * 1e6) / 1e6,
      baselineUsdc: usdc,
    };
  };
  try {
    const [payments, market] = await Promise.all([
      getPaymentsRevenueSummary(limit, offset),
      getMarketRevenueSummary(),
    ]);
    return {
      ...withBaseline(fromDbSummary(payments)),
      market: {
        settledMarkets: market.settledMarkets,
        grossVolumeUsdc: unitsToUsdc(market.grossVolumeAtomic),
        payoutUsdc: unitsToUsdc(market.payoutAtomic),
        platformFeeUsdc: unitsToUsdc(market.platformFeeAtomic),
        agentOwnerFeeUsdc: unitsToUsdc(market.agentOwnerFeeAtomic),
        dustUsdc: unitsToUsdc(market.dustAtomic),
        unclaimedUsdc: unitsToUsdc(market.unclaimedAtomic),
      },
    };
  } catch {
    return withBaseline(inMemorySummary(limit, offset));
  }
}
