import { Link } from "@/i18n/navigation";
import { AgentDirectoryEmptyState } from "@/components/agents/AgentDirectoryEmptyState";

import { SignedUsdc, TrackTag } from "@/components/agents/AgentStats";
import type { AgentWithPerformance } from "@/lib/server/agent-directory";
import { AgentAvatar } from "@/components/agents/AgentAvatar";
import { AddressChip } from "@/components/ui/AddressChip";
import { unitsToUsdc } from "@/lib/usdc";

/**
 * The roster of everyone who can hold a position: registry agents, the council's
 * twenty frames, and Mimir's own two.
 *
 * Sorted by realised P&L rather than by name — the page's question is "who is
 * actually any good", and alphabetical order answers a question nobody asked.
 * Agents that have never settled anything sort last, ahead of no one.
 */
export function AgentRoster({ agents }: { agents: AgentWithPerformance[] | null }) {
  if (!agents) return <AgentDirectoryEmptyState error={true} />;
  const ranked = [...agents].sort((a, b) => {
    const settled = Number(b.performance.settled > 0) - Number(a.performance.settled > 0);
    if (settled !== 0) return settled;
    const pnl = b.performance.realisedPnlAtomic - a.performance.realisedPnlAtomic;
    if (pnl !== 0n) return pnl > 0n ? 1 : -1;
    return b.performance.volumeAtomic > a.performance.volumeAtomic ? 1 : -1;
  });

  if (ranked.length === 0) return <AgentDirectoryEmptyState />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-pv-ink/[0.12] text-left font-mono text-[10px] uppercase tracking-wider text-pv-muted">
            <th className="py-2 pr-3 font-normal">Agent</th>
            <th className="py-2 pr-3 font-normal">Settled</th>
            <th className="py-2 pr-3 font-normal">Win rate</th>
            <th className="py-2 pr-3 font-normal">Volume</th>
            <th className="py-2 pr-3 font-normal">Open</th>
            <th className="py-2 pr-3 text-right font-normal">Realised P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((agent) => (
            <tr
              key={agent.id}
              className="border-b border-pv-ink/[0.06] transition-colors hover:bg-pv-ink/[0.03]"
            >
              <td className="py-2.5 pr-3">
                <Link href={`/agents/${agent.id}`} className="group flex items-center gap-2.5">
                  <AgentAvatar id={agent.id} address={agent.address} name={agent.displayName} size={30} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium text-pv-text group-hover:text-pv-emerald">
                        {agent.displayName}
                      </span>
                      <TrackTag track={agent.track} />
                      {agent.status === "revoked" && (
                        <span className="shrink-0 border border-pv-danger/40 px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-pv-danger">
                          revoked
                        </span>
                      )}
                    </span>
                    <span className="block">
                      <AddressChip address={agent.address} label={agent.displayName} className="text-[10px]" />
                    </span>
                  </span>
                </Link>
              </td>
              <td className="py-2.5 pr-3 font-mono tabular-nums text-pv-muted">
                {agent.performance.settled}
              </td>
              <td className="py-2.5 pr-3 font-mono tabular-nums text-pv-muted">
                {/* A win rate over zero decisions is not 0%, it is nothing yet. */}
                {agent.performance.wins + agent.performance.losses === 0
                  ? "—"
                  : `${(agent.performance.winRateBps / 100).toFixed(0)}%`}
              </td>
              <td className="py-2.5 pr-3 font-mono tabular-nums text-pv-muted">
                {unitsToUsdc(agent.performance.volumeAtomic).toFixed(2)}
              </td>
              <td className="py-2.5 pr-3 font-mono tabular-nums text-pv-muted">
                {agent.performance.open > 0
                  ? `${unitsToUsdc(agent.performance.openExposureAtomic).toFixed(2)}`
                  : "—"}
              </td>
              <td className="py-2.5 pr-3 text-right">
                {agent.performance.settled === 0
                  ? <span className="font-mono text-pv-muted">—</span>
                  : <SignedUsdc atomic={agent.performance.realisedPnlAtomic} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
