import { Buffer } from "node:buffer";
import { buildCopyExecutionDryRun, type CopyDryRunContext } from "@/lib/copy-execution-dry-run";
import { validateCopyPermission, type CopyPermission, type CopySignal } from "@/lib/copy-trading";
import { authorizeRequest } from "@/lib/api/policy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 16_384;
const decimal = /^(0|[1-9]\d*)$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown, limit: number): value is string[] =>
  Array.isArray(value) && value.length <= limit && value.every((item) => typeof item === "string" && item.length <= 128);
const numbers = (value: unknown, limit: number): value is number[] =>
  Array.isArray(value) && value.length <= limit && value.every((item) => Number.isSafeInteger(item) && item >= 0);
const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function parsePreviewInput(value: unknown, now: number): {
  permission: CopyPermission; signal: CopySignal; context: CopyDryRunContext;
} | null {
  if (!record(value) || !record(value.permission) || !record(value.signal) || !record(value.context)) return null;
  const p = value.permission;
  const spend = p.spendPermission;
  const s = value.signal;
  const c = value.context;
  const usage = c.usage;
  if (!record(spend) || !record(usage)) return null;
  if (![p.permissionId, p.ownerWallet, p.executionAgentId, p.signalAgentId,
        p.maxRealizedLossAtomic, spend.token, spend.spender].every((v) => typeof v === "string" && v.length <= 128) ||
      typeof spend.allowanceAtomic !== "string" || !decimal.test(spend.allowanceAtomic) ||
      !Number.isSafeInteger(spend.periodSeconds) ||
      ![p.maxPerPositionUsdc, p.dailyCapUsdc, p.weeklyCapUsdc, p.totalOpenExposureUsdc]
        .every(amount) ||
      ![p.minConfidenceBps, p.minPayoutBps, p.expiresAt].every(Number.isSafeInteger) ||
      p.depth !== 1 || !["active", "paused", "revoked"].includes(String(p.status)) ||
      !strings(p.allowedCategories, 100) || !strings(p.allowedModes, 10)) return null;

  const { signedPolicyHash: _ignored, ...draft } = p;
  const unsigned = {
    ...draft,
    spendPermission: { ...spend, allowanceAtomic: BigInt(spend.allowanceAtomic) },
  } as Omit<CopyPermission, "signedPolicyHash">;
  // Registration requires an active, unexpired policy. Previewing an existing
  // paused, revoked or expired one must instead return its lifecycle reason.
  if (validateCopyPermission({ ...unsigned, status: "active", expiresAt: Math.max(now + 1, unsigned.expiresAt) }, now)) return null;
  const permission: CopyPermission = { ...unsigned, signedPolicyHash: "" };

  if (![s.sourcePositionId, s.signalAgentId, s.category, s.mode, s.sourceAttributionId]
        .every((v) => typeof v === "string" && v.length <= 128) ||
      ![s.sourceDepth, s.claimId, s.confidenceBps, s.payoutBps, s.deadline, s.remainingSlots]
        .every(Number.isSafeInteger) ||
      ![s.stakeUsdc, s.availableLiquidityUsdc, s.requiredLiquidityUsdc].every(amount) ||
      !["open", "active", "resolved", "cancelled"].includes(String(s.marketState))) return null;
  const signal = s as unknown as CopySignal;

  if (!amount(usage.usedTodayUsdc) || !amount(usage.usedThisWeekUsdc) ||
      !amount(usage.openExposureUsdc) ||
      typeof usage.realizedLossAtomic !== "string" || !decimal.test(usage.realizedLossAtomic) ||
      typeof usage.principalAtRiskAtomic !== "string" || !decimal.test(usage.principalAtRiskAtomic) ||
      !numbers(c.existingClaimIds, 1000) || !strings(c.ancestryAgentIds, 16) ||
      typeof c.configuredUsdc !== "string" || typeof c.configuredSpender !== "string" ||
      typeof c.onchainAllowanceAtomic !== "string" || !decimal.test(c.onchainAllowanceAtomic)) return null;
  const context: CopyDryRunContext = {
    now,
    usage: usage as unknown as CopyDryRunContext["usage"],
    existingClaimIds: new Set(c.existingClaimIds),
    ancestryAgentIds: c.ancestryAgentIds,
    configuredUsdc: c.configuredUsdc,
    configuredSpender: c.configuredSpender,
    onchainAllowanceAtomic: BigInt(c.onchainAllowanceAtomic),
  };
  return { permission, signal, context };
}

export async function POST(req: Request): Promise<Response> {
  const gate = await authorizeRequest("public_read", {
    route: "/api/copy/preview",
    ip: req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
  });
  if (!gate.allowed) return Response.json({ error: gate.error }, { status: 429, headers: { "cache-control": "no-store" } });
  let input: unknown;
  try {
    const reader = req.body?.getReader();
    if (!reader) throw new Error("missing body");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return Response.json({ error: "preview body too large" }, { status: 413 });
      }
      chunks.push(value);
    }
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const parsed = parsePreviewInput(input, Date.now());
  if (!parsed) return Response.json({ error: "invalid copy preview input" }, { status: 400 });
  return Response.json(buildCopyExecutionDryRun(parsed), { headers: { "cache-control": "no-store" } });
}
