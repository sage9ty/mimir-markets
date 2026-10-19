import { Link } from "@/i18n/navigation";

import { TIME_WINDOWS, type TimeWindow } from "@/lib/agents/performance";
import { unitsToUsdc } from "@/lib/usdc";

/** Signed USDC, always with its sign, so a loss never reads as a gain at a glance. */
export function SignedUsdc({ atomic, className = "" }: { atomic: bigint; className?: string }) {
  const value = unitsToUsdc(atomic);
  const tone = atomic > 0n ? "text-pv-emerald" : atomic < 0n ? "text-pv-danger" : "text-pv-muted";
  return (
    <span className={`font-mono tabular-nums ${tone} ${className}`}>
      {atomic > 0n ? "+" : ""}{value.toFixed(2)}
    </span>
  );
}

export function Bps({ bps, suffix = "%" }: { bps: number; suffix?: string }) {
  const tone = bps > 0 ? "text-pv-emerald" : bps < 0 ? "text-pv-danger" : "text-pv-muted";
  return (
    <span className={`font-mono tabular-nums ${tone}`}>
      {bps > 0 ? "+" : ""}{(bps / 100).toFixed(2)}{suffix}
    </span>
  );
}

export function StatBlock({
  label, children, hint,
}: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="border border-pv-ink/[0.1] bg-pv-surface/40 px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">{label}</div>
      <div className="mt-1 font-display text-xl font-bold text-pv-text">{children}</div>
      {hint && <div className="mt-0.5 text-[11px] text-pv-muted">{hint}</div>}
    </div>
  );
}

const WINDOW_LABELS: Record<TimeWindow, string> = {
  "24h": "24h", "7d": "7d", "30d": "30d", all: "All",
};

/**
 * Window switcher as plain links rather than client state: the page is server
 * rendered per window anyway, and a link is shareable and works without JS.
 */
export function TimeWindowTabs({
  active, basePath,
}: { active: TimeWindow; basePath: string }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Time window">
      {TIME_WINDOWS.map((window) => (
        <Link
          key={window}
          href={window === "all" ? basePath : `${basePath}?window=${window}`}
          aria-current={window === active ? "page" : undefined}
          className={`border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${window === active
              ? "border-pv-emerald/45 bg-pv-emerald/[0.1] text-pv-text"
              : "border-pv-ink/[0.12] text-pv-muted hover:border-pv-ink/[0.25] hover:text-pv-text"
          }`}
        >
          {WINDOW_LABELS[window]}
        </Link>
      ))}
    </div>
  );
}

export const TRACK_LABELS: Record<string, string> = {
  byoa: "BYOA",
  council: "Council",
  philosopher: "Philosopher",
  core: "Mimir",
};

export function TrackTag({ track }: { track: string }) {
  return (
    <span className="shrink-0 border border-pv-ink/[0.14] px-1.5 py-px font-mono text-[9px] uppercase tracking-wider text-pv-muted">
      {TRACK_LABELS[track] ?? track}
    </span>
  );
}
