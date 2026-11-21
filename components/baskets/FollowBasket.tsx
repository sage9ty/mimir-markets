"use client";

/**
 * Follow a basket by mirroring it from your own wallet.
 *
 * Deliberately not called "deposit" or "invest": nothing is transferred here, and
 * calling it investing would promise custody Mimir does not offer and its own ADR
 * forbids. What the user signs says the same thing in the wallet prompt.
 */

import { useState } from "react";

import { FeeBreakdown } from "@/components/fees/FeeBreakdown";
import { useWallet } from "@/lib/wallet";
import { parsePerMarketUsdc, subscriptionMessage } from "@/lib/baskets";

/** How long a signed (un)subscribe stays acceptable; the server caps it at 5 min. */
const SIGNATURE_TTL_MS = 2 * 60_000;

type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      compositionId: string;
      affectedSuggestions: Array<{ id: string; marketId: string; side: string; proposedUsdc: number }>;
      marketStakeChanged: false;
      allowanceChanged: false;
    }
  | { status: "error"; message: string };

export function FollowBasket({
  basketId, creatorWallet,
}: { basketId: string; creatorWallet?: string }) {
  const { address, isConnected, connect, signMessage, canSignMessages } = useWallet();

  // Keep the raw string so the field can be cleared and retyped freely.
  const [perMarketInput, setPerMarketInput] = useState("2");
  const [perMarket, setPerMarket] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });

  // Your own basket charges you no basket fee, so say so before they pay attention
  // to the fee line rather than after. Exact comparison, not a lowercased one:
  // strkeys are case-sensitive.
  const isOwn = Boolean(address && creatorWallet && address.trim() === creatorWallet.trim());

  function commitInput(): number | null {
    const parsed = parsePerMarketUsdc(perMarketInput);
    if (!parsed.ok) {
      setInputError(parsed.error);
      return null;
    }
    setInputError(null);
    setPerMarket(parsed.value);
    setPerMarketInput(String(parsed.value));
    return parsed.value;
  }

  async function loadPreview(nextAmount: number, unsubscribe: boolean) {
    if (!address) return;
    setPreview({ status: "loading" });
    try {
      const params = new URLSearchParams({
        subscriber: address,
        perMarketUsdc: String(nextAmount),
        unsubscribe: String(unsubscribe),
      });
      const response = await fetch(`/api/baskets/${basketId}/subscribe/preview?${params}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "could not load preview");
      setPreview({
        status: "ready",
        compositionId: payload.compositionId,
        affectedSuggestions: payload.affectedSuggestions ?? [],
        marketStakeChanged: false,
        allowanceChanged: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPreview({ status: "error", message });
    }
  }

  async function toggle() {
    if (!address) return void connect();
    if (!canSignMessages) {
      setError(
        "This wallet cannot sign off-chain messages. Reconnect with Freughter, xBull or Hana to follow a basket.",
      );
      return;
    }

    // When following we care about the amount; when unfollowing it is always 0.
    let amount = 0;
    if (!following) {
      const committed = commitInput();
      if (committed === null) return;
      amount = committed;
    }

    setBusy(true);
    setError(null);
    try {
      const nonce = crypto.randomUUID();
      const expiresAt = Date.now() + SIGNATURE_TTL_MS;
      const signature = await signMessage(
        subscriptionMessage({
          action: following ? "unsubscribe" : "subscribe",
          basketId,
          subscriber: address,
          perMarketUsdc: amount,
          nonce,
          expiresAt,
        }),
      );
      const response = await fetch(`/api/baskets/${basketId}/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subscriber: address,
          perMarketUsdc: amount,
          unsubscribe: following,
          signature,
          nonce,
          expiresAt,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "could not update subscription");
      setFollowing(Boolean(payload.subscribed));
      setPreview({ status: "idle" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(/user rejected|denied/i.test(message) ? "Signature rejected in your wallet." : message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-pv-ink/[0.12] g-pv-surface/40 p-4">
      <h3 className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">Follow this basket</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-pv-muted">
        Mirror its members from your own wallet, up to the amount you set per market.
        Nothing is deposited and Mimir never holds your funds — each stake is a
        transaction you sign.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">Per market</span>
          <input
            type="number" min={1} max={100} step={1}
            value={perMarketInput}
            disabled={following}
            onChange={(e) => {
              setPerMarketInput(e.target.value);
              if (inputError) setInputError(null);
            }}
            onBlur={() => void commitInput()}
            aria-invalid={Boolean(inputError)}
            className="w-20 border border-pv-ink/[0.14] bg-pv-bg px-2 py-1.5 text-right font-mono text-[13px] text-pv-text outline-none focus:border-pv-emerald/50 disabled:opacity-50"
          />
          <span className="font-mono text-[11px] text-pv-muted">USDC</span>
        </label>
        <button
          type="button"
          onClick={() => void loadPreview(perMarket, following)}
          disabled={busy || !address || preview.status === "loading"}
          className="border border-pv-ink/[0.14] px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-pv-muted transition-colors hover:text-pv-text"
        >
          Preview changes
        </button>
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          className={following
            ? "border border-pv-ink/[0.14] px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-pv-muted transition-colors hover:text-pv-text"
            : "btn-compact-primary px-3.5 py-1.5 text-[12px]"}
        >
          {!isConnected ? "Connect to follow"
            : busy ? "Waiting for signature…"
            : following ? "Unfollow"
            : "Follow"}
        </button>
      </div>

      {inputError && <p className="mt-2 text-[12px] text-pv-danger">{inputError}</p>}
      {error && <p className="mt-2 text-[12px] text-pv-danger">{error}</p>}

      {preview.status === "loading" && (
        <p className="mt-2 text-[12px] text-pv-muted">Loading preview…</p>
      )}
      {preview.status === "error" && (
        <p className="mt-2 text-[12px] text-pv-danger">{preview.message}</p>
      )}
      {preview.status === "ready" && (
        <div className="mt-3 space-y-2 border-t border-pv-ink/[0.08] pt-3 text-[12px] text-pv-muted">
          <p className="font-mono text-[10px] uppercase tracking-wider">
            Composition <span className="text-pv-text">{preview.compositionId}</span>
          </p>
          {preview.affectedSuggestions.length === 0 ? (
            <p>No pending mirror suggestions would change.</p>
          ) : (
            <ul className="space-y-1">
              {preview.affectedSuggestions.map((s) => (
                <li key={s.id} className="font-mono text-[11px]">
                  {s.marketId} · {s.side} · {s.proposedUsdc} USDC
                </li>
              ))}
            </ul>
          )}
          <p>No market stake or allowance changes are made by this preview.</p>
        </div>
      )}

      <FeeBreakdown context="follow" isOwn={isOwn} />
    </div>
  );
}
