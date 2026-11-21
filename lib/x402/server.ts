/**
 * Seller side of Mimir's paid resources — x402 v2 over `@x402/next`.
 *
 * Mimir declares what a route costs and who is paid; the Stellar scheme in
 * `./stellar-scheme.ts` does verification and settlement by reading the buyer's
 * payment back off Horizon. There is no facilitator hop and no third party in the
 * loop — see that module's header for why Stellar does not need one, and
 * {@link settlementIdentifier} for how replay is handled.
 *
 * Usage in a route handler:
 *   export const GET = paidRoute("premiumPrice", handler);
 *
 * For routes whose recipient depends on the request (a council persona is paid
 * directly), pass a dynamic payTo:
 *   export const GET = paidRoute("councilVote", handler, { payTo: resolvePersona });
 */

import "server-only";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withX402, x402ResourceServer } from "@x402/next";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { DynamicPayTo, HTTPRequestContext } from "@x402/core/http";

import {
  PRICES,
  RESOURCE_META,
  X402_NETWORK,
  X402_SCHEME,
  X402_SETTLEMENT_SOURCE,
  sellerAddress,
  type PriceKey,
} from "./config";
import {
  ExactStellarScheme,
  LocalStellarFacilitatorClient,
  proofPayer,
} from "./stellar-scheme";
import { recordPayment } from "../paid-revenue";
import { sellingPausedResponse } from "./kill-switch";

/**
 * A settled payment lands here exactly once per request. Awaited by the SDK, so
 * the serverless function stays alive until the ledger row is written — a
 * fire-and-forget insert would be dropped when the response returns.
 */
let _server: x402ResourceServer | null = null;

export function getResourceServer(): x402ResourceServer {
  if (_server) return _server;

  // In-process, not an HTTP client: verify/settle are Horizon reads. The object
  // is still required — x402ResourceServer.initialize() builds its supported-kinds
  // map from facilitators and throws when that map is empty.
  _server = new x402ResourceServer(new LocalStellarFacilitatorClient([X402_NETWORK]))
    .register(X402_NETWORK, new ExactStellarScheme())
    .onAfterSettle(async ({ result, requirements, paymentPayload, transportContext }) => {
      if (!result.success) return;
      const extra = (result.extra ?? {}) as Record<string, unknown>;
      await recordPayment({
        resource: settledResource(transportContext, paymentPayload.resource?.url),
        scheme: requirements.scheme,
        network: result.network,
        assetAddress: requirements.asset,
        // `upto` settles a different amount than it authorized; `exact` does not.
        amountAtomic: BigInt(result.amount ?? requirements.amount),
        payer: result.payer ?? payerFromPayload(paymentPayload.payload),
        seller: requirements.payTo,
        transactionHash: result.transaction || null,
        paymentIdentifier: settlementIdentifier(result.transaction, paymentPayload.payload),
        facilitator: X402_SETTLEMENT_SOURCE(),
        settledAt: Date.now(),
        observedAt: typeof extra.observedAt === "number" ? extra.observedAt : undefined,
        policy: extra.policy as any,
        explanation: typeof extra.explanation === "string" ? extra.explanation : undefined,
      });
    });

  return _server;
}

/** Which endpoint earned this payment — the request path, e.g. /api/oracle. */
function settledResource(transportContext: unknown, resourceUrl?: string): string {
  const path = (transportContext as { request?: { path?: string } } | undefined)?.request?.path;
  if (path) return path;
  if (!resourceUrl) return "";
  try {
    return new URL(resourceUrl).pathname;
  } catch {
    return resourceUrl;
  }
}

/**
 * The paying `G…` account, carried in the proof.
 *
 * Only reached as a fallback: the Stellar facilitator returns `payer` on the
 * settle response, because it has verified the account signed the proof. Reading
 * it back off the payload here is the same value, one step less authenticated.
 */
function payerFromPayload(payload: Readonly<Record<string, unknown>>): string | null {
  return proofPayer(payload);
}

/**
 * Stable per-payment id for the ledger's unique index.
 *
 * The Stellar transaction hash, always — a payment cannot settle without one, so
 * unlike the EVM path there is no off-chain-settlement case needing a nonce
 * fallback. Note this is the ledger's IDEMPOTENCY key, not the replay defence:
 * `insertPayment` is `ON CONFLICT DO NOTHING` and runs after the paid response
 * was already produced, so it deduplicates ACCOUNTING rows and nothing more.
 * Denying a replayed proof happens earlier, in the scheme's settle step (see
 * `consumeSettlement` in ./stellar-scheme.ts).
 */
function settlementIdentifier(
  transaction: string,
  _payload: Readonly<Record<string, unknown>>,
): string {
  if (transaction) return transaction.toLowerCase();
  throw new Error("x402 settlement returned no Stellar transaction hash");
}

/**
 * The buyer's address, read from the `PAYMENT-SIGNATURE` the paywall already
 * verified. Null on a request that reached the handler without paying (a council
 * pass).
 *
 * Safe to trust in a handler precisely BECAUSE the paywall ran first: the same
 * header was checked against Horizon and against the payer's own Ed25519
 * signature before the handler was invoked. Returned exactly as it appears —
 * strkeys are case-sensitive base32, so the `toLowerCase()` this used to do would
 * corrupt the address.
 */
export function paymentPayer(req: NextRequest): string | null {
  const header = req.headers.get("payment-signature");
  if (!header) return null;
  try {
    return proofPayer(decodePaymentSignatureHeader(header).payload);
  } catch {
    return null;
  }
}

export interface PaidRouteOptions {
  /**
   * Per-request recipient — council personas are paid into their own wallets.
   * Receives the x402 HTTP request context; read query params via
   * `ctx.adapter.getQueryParam(name)`.
   */
  payTo?: DynamicPayTo;
  /** Skip the paywall entirely (e.g. a valid council pass). */
  skipPayment?: (req: NextRequest) => Promise<boolean> | boolean;
  /**
   * Refuse a request before the paywall quotes a 402.
   *
   * A dynamic `payTo` that cannot resolve — a council persona with a missing or
   * malformed `COUNCIL_<SLUG>_PUBLIC` — must not produce a quote: the buyer would
   * pay into an address nobody controls. Returning a response short-circuits the
   * request with that response (a 503, for the council routes); `null` continues.
   */
  beforeQuote?: (req: NextRequest) => NextResponse | null | Promise<NextResponse | null>;
}

/**
 * Read a single query param from an x402 request context. getQueryParam is
 * optional on the adapter interface, so fall back to parsing the URL.
 */
export function queryParam(ctx: HTTPRequestContext, name: string): string {
  const raw = ctx.adapter.getQueryParam?.(name);
  if (raw !== undefined) return (Array.isArray(raw) ? raw[0] : raw).toString();
  try {
    return new URL(ctx.adapter.getUrl()).searchParams.get(name) ?? "";
  } catch {
    return "";
  }
}

/**
 * Wrap a route handler in the x402 paywall. Unpaid requests get a
 * `PAYMENT-REQUIRED` 402; a valid `PAYMENT-SIGNATURE` retry runs the handler and
 * the response carries `PAYMENT-RESPONSE` settlement metadata.
 */
export function paidRoute<T>(
  priceKey: PriceKey,
  handler: (req: NextRequest) => Promise<NextResponse<T>>,
  opts: PaidRouteOptions = {},
): (req: NextRequest) => Promise<NextResponse<T>> {
  const meta = RESOURCE_META[priceKey];

  const guarded = withX402(
    handler,
    {
      accepts: {
        scheme: X402_SCHEME,
        network: X402_NETWORK,
        price: PRICES[priceKey],
        // Always a function: resolving SELLER_ADDRESS at module scope would make
        // the route fail to even load (and `next build` fail to collect page
        // data) in any environment where the var isn't set yet.
        payTo: async (ctx: HTTPRequestContext) =>
          sellerAddress(opts.payTo ? await opts.payTo(ctx) : undefined),
      },
      description: meta.description,
      mimeType: meta.mimeType,
      serviceName: meta.serviceName,
      tags: meta.tags,
      // Bazaar discovery: agents can enumerate these services and their shapes.
      extensions: declareDiscoveryExtension(
        priceKey === "premiumPrice" || priceKey === "councilReasoning" || priceKey === "councilVote"
          ? { input: (meta.example?.input ?? {}) as Record<string, unknown>, output: { example: meta.example?.output } }
          : { bodyType: "json", input: (meta.example?.input ?? {}) as Record<string, unknown>, output: { example: meta.example?.output } },
      ),
    } as never,
    getResourceServer(),
  );

  // x402 selling pauses independently of the rest of the app: if Horizon is
  // degraded we stop selling — a verifier that cannot read the ledger must refuse
  // rather than guess — while market settlement and withdrawal keep working.
  //
  // Quotes expire before verification to preserve contract-first accounting,
  // clear market semantics, and safe agent operations. The `withX402` wrapper
  // enforces this by rejecting stale proofs during the scheme's settle step.
  const withKillSwitch = async (req: NextRequest): Promise<NextResponse<T>> => {
    const paused = sellingPausedResponse();
    if (paused) {
      return NextResponse.json(paused.body, {
        status: paused.status,
        headers: paused.headers,
      }) as NextResponse<T>;
    }
    // Before quoting: an unresolvable recipient is a configuration error, not a
    // payment the buyer can complete. Refusing here means no 402 is ever issued
    // for an address that failed validation.
    const refusal = await opts.beforeQuote?.(req);
    if (refusal) return refusal as NextResponse<T>;
    const { authorizeRequest } = await import("@/lib/api/policy");
    const { verifyBrowserOrigin } = await import("@/lib/api/origin");
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
    const wallet = paymentPayer(req) || undefined;
    const tier = wallet ? "authenticated_user" : "public_read";

    // We assume non-GET methods mutate value. If an endpoint requires an idempotency key,
    // it will be enforced by the policy.
    const mutatesValue = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
    const originValid = verifyBrowserOrigin(req);

    const rlGate = await authorizeRequest(tier, {
      route: req.nextUrl.pathname,
      ip,
      wallet,
      mutatesValue,
      originValid,
    });
    if (!rlGate.allowed && rlGate.error) {
      return NextResponse.json(rlGate.error.body, { status: rlGate.error.status, headers: rlGate.error.headers }) as NextResponse<T>;
    }
    return guarded(req);
  };

  if (!opts.skipPayment) return withKillSwitch;

  return async (req: NextRequest) =>
    (await opts.skipPayment!(req)) ? handler(req) : withKillSwitch(req);
}
