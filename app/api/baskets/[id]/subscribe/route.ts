/*
 * Follow a basket by mirroring it, not by depositing into it.
 *
 * ADR-0008 forbids taking funds into a basket before audit and legal review, and
 * that boundary is the point rather than an inconvenience: nothing here custodies
 * anyone's money. A subscription records an intent — "mirror this basket's members
 * at N USDC per market, from my own wallet" — and every resulting stake is signed
 * by the subscriber.
 *
 * So the worst case of a bug here is a subscription row nobody asked for, not a
 * balance nobody can withdraw.
 *
 * A `preview` request returns the affected pending mirror suggestions and the
 * composition identity for a prospective subscription change. It performs no
 * market stake or allowance change and writes nothing.
 */

import { NextResponse, type NextRequest } from "next/server";

import { isStellarAccount, verifyStellarSignedMessage } from "@/lib/stellar-message";
import { apiError } from "@/lib/api/errors";
import { authorizeRequest } from "@/lib/api/policy";
import { clientIpFrom } from "@/lib/api/origin";
import { findAnyBasketDefinition } from "@/lib/server/basket-directory";
import { subscribeToBasket, unsubscribeFromBasket } from "@/lib/db";
import { subscriptionMessage } from "@/lib/baskets";
import { validateSignedWindow } from "@/lib/signed-window";
import { consumeNonce } from "@/lib/server/nonce-store";
import { listPendingMirrorSuggestionsForBasket } from "@/lib/server/mirror-queue";

export const dynamic = "force-dynamic";

/** A mirror that can drain an account is not a feature anyone asked for. */
const MAX_PER_MARKET_USDC = 100;

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const gate = await authorizeRequest("public_read", { route: "/api/baskets/subscribe", ip: clientIpFrom(req.headers) });
  if (!gate.allowed && gate.error) {
    return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
  }

  let body: {
    subscriber?: string; perMarketUsdc?: number; signature?: string; unsubscribe?: boolean;
    nonce?: string; expiresAt?: number; preview?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    const err = apiError("invalid_request", "invalid JSON");
    return NextResponse.json(err.body, { status: err.status });
  }

  // Trimmed, never lowercased — see subscriptionMessage in lib/baskets.
  const subscriber = String(body.subscriber ?? "").trim();
  if (!isStellarAccount(subscriber)) {
    const err = apiError("invalid_request", "subscriber must be a Stellar account address");
    return NextResponse.json(err.body, { status: err.status });
  }

  const basket = await findAnyBasketDefinition(id).catch(() => null);
  if (!basket) {
    const err = apiError("not_found", "no such basket");
    return NextResponse.json(err.body, { status: err.status });
  }

  const perMarketUsdc = Number(body.perMarketUsdc ?? 0);
  if (!body.unsubscribe && (!Number.isFinite(perMarketUsdc) || perMarketUsdc <= 0 || perMarketUsdc > MAX_PER_MARKET_USDC)) {
    const err = apiError("invalid_request", `per-market amount must be between 0 and ${MAX_PER_MARKET_USDC} USDC`);
    return NextResponse.json(err.body, { status: err.status });
  }

  const signature = String(body.signature ?? "").trim();
  if (!signature) {
    const err = apiError("invalid_signature", "subscriber signature is required");
    return NextResponse.json(err.body, { status: err.status });
  }
  const window = validateSignedWindow(body.nonce, body.expiresAt);
  if (!window.ok) {
    const err = apiError(window.code, window.message, { field: window.field });
    return NextResponse.json(err.body, { status: err.status });
  }
  const action = body.unsubscribe ? "unsubscribe" : "subscribe";
  // Ed25519 verification takes the public key as an INPUT — unlike EIP-191, there
  // is no recovery step and therefore no "recovered a different address" branch
  // to get wrong. The address checked is the one the row will be written under.
  const valid = verifyStellarSignedMessage({
    address: subscriber,
    message: subscriptionMessage({
      action, basketId: id, subscriber, perMarketUsdc,
      nonce: window.nonce, expiresAt: window.expiresAt,
    }),
    signature,
  });
  if (!valid) {
    const err = apiError("invalid_signature", "signature rejected");
    return NextResponse.json(err.body, { status: err.status });
  }

  // Consumed after verification so a forged request cannot burn a real nonce.
  if (!(await consumeNonce(`basket-subscription:${subscriber}`, `basket-subscription:${window.nonce}`))) {
    const err = apiError("conflict", "nonce already used; sign a fresh authorisation");
    return NextResponse.json(err.body, { status: err.status });
  }

  if (body.preview) {
    // Read-only: list the pending mirror suggestions this change would affect.
    // No stake, no allowance change, no subscription write.
    const suggestions = await listPendingMirrorSuggestionsForBasket(id, subscriber);
    return NextResponse.json(
      {
        preview: true,
        action,
        basketId: id,
        subscriber,
        perMarketUsdc: body.unsubscribe ? null : perMarketUsdc,
        compositionId: basket.compositionId ?? null,
        affectedSuggestions: suggestions.map((s) => ({
          suggestionId: s.id,
          marketId: s.marketId,
          pendingUsdc: s.pendingUsdc,
          status: s.status,
        })),
        note: "Preview only. No stake or allowance has changed.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (body.unsubscribe) {
    await unsubscribeFromBasket(id, subscriber, Date.now());
    return NextResponse.json({ subscribed: false }, { headers: { "cache-control": "no-store" } });
  }

  await subscribeToBasket({ basketId: id, subscriber, perMarketUsdc, at: Date.now() });
  return NextResponse.json(
    {
      subscribed: true,
      perMarketUsdc,
      note: "Mimir holds no funds. Each mirrored stake is a transaction you sign.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
