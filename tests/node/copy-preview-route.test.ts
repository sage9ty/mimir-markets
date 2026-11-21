import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../../app/api/copy/preview/route";

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const MIMIR = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const OWNER = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";

function payload() {
  return {
    permission: {
      permissionId: "preview-1", ownerWallet: OWNER, executionAgentId: "agent-b", signalAgentId: "agent-a",
      maxPerPositionUsdc: 5, dailyCapUsdc: 10, weeklyCapUsdc: 30, totalOpenExposureUsdc: 20,
      maxRealizedLossAtomic: "150000000", allowedCategories: ["crypto"], allowedModes: ["pool"],
      minConfidenceBps: 7000, minPayoutBps: 12000, expiresAt: Date.now() + 60_000,
      depth: 1, status: "active", spendPermission: {
        token: USDC, spender: MIMIR, allowanceAtomic: "100000000", periodSeconds: 86400,
      },
    },
    signal: {
      sourcePositionId: "pos-a-1", signalAgentId: "agent-a", sourceDepth: 0, claimId: 7,
      category: "crypto", mode: "pool", confidenceBps: 8000, payoutBps: 15000,
      stakeUsdc: 3, deadline: Date.now() + 30_000, remainingSlots: 2,
      availableLiquidityUsdc: 10, requiredLiquidityUsdc: 3, sourceAttributionId: "attr-a-1",
      marketState: "open",
    },
    context: {
      usage: { usedTodayUsdc: 0, usedThisWeekUsdc: 0, openExposureUsdc: 0, realizedLossAtomic: "0", principalAtRiskAtomic: "0" },
      existingClaimIds: [], ancestryAgentIds: ["agent-a"], configuredUsdc: USDC,
      configuredSpender: MIMIR, onchainAllowanceAtomic: "100000000",
    },
  };
}

function request(body: string): Request {
  return new Request("http://localhost/api/copy/preview", { method: "POST", body });
}

test("copy preview route exposes a hypothetical decision without an execution claim", async () => {
  const candidate = payload();
  const supplied = { ...candidate, context: { ...candidate.context,
    now: 1, simulation: { ok: true, blockNumber: "999" } } };
  const response = await POST(request(JSON.stringify(supplied)));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.policyEligible, true);
  assert.equal(body.stakeAtomic, "30000000");
  assert.equal(body.executionReady, false);
  assert.equal(body.transactionSubmitted, false);
  assert.equal(body.simulation, "not_run");
  assert.equal(body.stateSource, "supplied_snapshot");
  assert.equal("ownerWallet" in body, false);
  assert.equal("simulationBlock" in body, false);
});

test("copy preview route reports lifecycle blocks and rejects malformed or oversized input", async () => {
  assert.equal((await POST(request("{"))).status, 400);
  const expired = payload();
  expired.permission.expiresAt = Date.now() - 1;
  const expiredResponse = await POST(request(JSON.stringify(expired)));
  assert.equal(expiredResponse.status, 200);
  assert.equal((await expiredResponse.json()).reason, "permission_expired");
  const paused = payload();
  paused.permission.status = "paused";
  const pausedResponse = await POST(request(JSON.stringify(paused)));
  assert.equal(pausedResponse.status, 200);
  assert.equal((await pausedResponse.json()).reason, "permission_paused");
  const cancelled = payload();
  cancelled.signal.marketState = "cancelled";
  const cancelledResponse = await POST(request(JSON.stringify(cancelled)));
  assert.equal(cancelledResponse.status, 200);
  assert.equal((await cancelledResponse.json()).reason, "market_cancelled");
  const malformed = payload();
  malformed.context.onchainAllowanceAtomic = "1e7";
  assert.equal((await POST(request(JSON.stringify(malformed)))).status, 400);
  assert.equal((await POST(request(" ".repeat(16_385)))).status, 413);
});
