"use client";

/**
 * Positions from baskets you follow that you have not copied yet.
 *
 * One click each, signed by the follower. Mimir cannot place these for them: the
 * contract takes the stake from the account that authorised the call, and Mimir
 * holds no key for anyone else. Doing it any other way would mean custody, which
 * is exactly what following a basket is designed to avoid.
 *
 * So the queue is the product, not a workaround.
 *
 * ── What the Soroban move deleted from this file ─────────────────────────────
 *
 * The EVM version had a second path: create a Base Account **sub account**, keep a
 * scoped P256 key in browser storage, and batch `approve(USDC)` + the stake so a
 * mirror cost one confirmation instead of two.
 *
 * None of that is needed now, and the removal is a simplification rather than a
 * regression. Soroban authorises per invocation: `challenge_claim` carries auth
 * permitting exactly one USDC transfer of exactly the staked amount, so there is
 * no allowance to pre-grant and nothing to batch with. Every mirror is ONE
 * signature for every wallet, with no key held anywhere. The only setup left is
 * the account's USDC trustline, handled once by `UsdcTrustlineGate`.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { useWallet } from "@/lib/wallet";
import { challengeClaim } from "@/lib/contract";
import { formatMirrorAtomicUsdc } from "@/lib/baskets";
import { evaluateUsdcTrustlineGate } from "@/lib/usdcTrustlineGate";
import Link from "next/link";
import {
  UsdcTrustlineGate,
  useUsdcTrustline,
} from "@/components/wallet/UsdcTrustlineGate";

interface Mirror {
  basketId: string;
  basketName: string;
  claimId: number;
  question: string;
  agentId: string;
  agentName: string;
  memberStakeAtomic: string;
  mirrorAmountAtomic: string;
  side?: string;
  marketId?: string;
  weightBps: number;
  deadline: number;
}

export function PendingMirrors() {
  const t = useTranslations("wallet");
  const { address, isConnected, signer } = useWallet();
  const trustline = useUsdcTrustline();
  const trustlineGate = evaluateUsdcTrustlineGate({
    action: "mirror",
    status: trustline.status,
    loading: trustline.loading,
    stale: trustline.stale,
    isConnected,
    hasSigner: Boolean(signer),
  });
  const [mirrors, setMirrors] = useState<Mirror[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/baskets/mirrors?subscriber=${address}`);
      const payload = await response.json();
      setMirrors(Array.isArray(payload.mirrors) ? payload.mirrors : []);
    } catch {
      setMirrors([]);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mirror(item: Mirror) {
    if (!isConnected || !address || !signer) {
      setError(t(!isConnected || !address ? "connectWalletFirst" : "cannotSign"));
      return;
    }
    if (!trustlineGate.allowed) {
      setError(t(trustlineGate.messageKey));
      return;
    }
    setBusyId(item.claimId);
    setError(null);
    try {
      // One call, one signature. The auth entry inside it is what moves the USDC,
      // so there is no approve step to get wrong and no allowance left behind.
      const result = await challengeClaim(
        signer,
        item.claimId,
        Number(formatMirrorAtomicUsdc(item.mirrorAmountAtomic)),
      );
      setDone((current) => ({ ...current, [item.claimId]: result.txHash || "sent" }));
      // Refresh rather than splice: the queue is derived from chain state, and the
      // authoritative answer to "is it still pending" is the server's.
      void load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(
        /user rejected|denied|cancel/i.test(message)
          ? "Transaction rejected in your wallet."
          : message,
      );
    } finally {
      setBusyId(null);
    }
  }

  if (!isConnected) return null;
  if (!loading && mirrors.length === 0) return null;

  const blocked = !trustlineGate.allowed;

  return (
    <section className="border border-pv-emerald/35 bg-pv-emerald/[0.05] p-4">
      <div className="mb-2">
        <h3 className="font-mono text-[10px] uppercase tracking-wider text-pv-emerald">
          Waiting to mirror
        </h3>
        <p className="text-[11px] text-pv-muted">
          Baskets you follow took these positions. Each one is a stake you sign — no
          funds are held on your behalf.
        </p>
      </div>

      <UsdcTrustlineGate
        trustline={trustline}
        className="mb-3"
        onReady={() => void load()}
      />

      {loading && mirrors.length === 0 && (
        <p className="py-3 text-[12px] text-pv-muted">Checking…</p>
      )}

      <ul className="space-y-2">
        {mirrors.map((item) => (
          <li
            key={`${item.basketId}-${item.claimId}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border border-pv-ink/[0.1] bg-pv-surface/50 px-3 py-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-pv-text">
                #{item.claimId} {item.question}
              </span>
              <span className="block font-mono text-[10px] text-pv-muted">
                {item.basketName} · {item.agentName} staked{" "}
                {formatMirrorAtomicUsdc(item.memberStakeAtomic, 2)} · your weight{" "}
                {(item.weightBps / 100).toFixed(0)}%
              </span>
            </span>
            {done[item.claimId] ? (
              <span className="font-mono text-[11px] text-pv-emerald">mirrored ✓</span>
            ) : (
              <Link
                href={`/vs/${item.claimId}?side=${encodeURIComponent(
                  item.side ?? "yes",
                )}&amount=${encodeURIComponent(formatMirrorAtomicUsdc(item.mirrorAmountAtomic, 2))}`}
                className="btn-compact-primary shrink-0 px-3 py-1.5 text-[12px]"
              >
                Mirror {formatMirrorAtomicUsdc(item.mirrorAmountAtomic, 2)} USDC
              </Link>
            )}
          </li>
        ))}
      </ul>

      {error && <p className="mt-2 text-[12px] text-pv-danger">{error}</p>}

      <p className="mt-3 text-[11px] text-pv-muted">
        One signature per mirror, from your own wallet. Mimir holds no key for you on
        any server, so nothing fires while you are away — anything you skip waits here.
      </p>
    </section>
  );
}
