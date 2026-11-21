import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import test from "node:test";

import {
  API_CONTRACT_FIXTURE_PATH,
  FIXTURE_SIGNATURE,
  FIXTURE_TRACE_ID,
  FIXTURE_WALLET,
  buildApiContractFixtures,
  fixtureReadSnapshot,
  renderApiContractFixtures,
} from "../../lib/api/contract-fixtures";
import { apiError, apiErrorCatalogue } from "../../lib/api/errors";
import {
  AGENT_API_REQUEST_SPEC,
  checkShape,
  resolveRequestVersion,
  validateAgentApiRequest,
  versioned,
} from "../../lib/api/schema";
import {
  MAX_SIGNED_REQUEST_PAYLOAD_BYTES,
  agentRequestMessage,
  validateAgentRequestEnvelope,
  type SignedAgentRequest,
} from "../../lib/agents/api";
import { runWithTrace } from "../../lib/ops/trace";
import { TRACE_HEADER } from "../../lib/ops/trace-http";
import { MIN_STAKE_ATOMIC } from "../../lib/usdc";
import { verifyStellarSignedMessage } from "../../lib/stellar-message";

type Suite = ReturnType<typeof buildApiContractFixtures>;
const fixtureText = readFileSync(new URL(`../../${API_CONTRACT_FIXTURE_PATH}`, import.meta.url), "utf8");
const fixtures = JSON.parse(fixtureText) as Suite;

test("published JSON fixtures match the generator byte for byte", () => {
  assert.equal(fixtureText, renderApiContractFixtures());
  assert.equal(fixtures.fixtureVersion, 1);
  assert.equal(fixtures.apiSchemaVersion, 1);
  const ids = fixtures.exchanges.map((exchange) => exchange.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 12);
});

test("generation ignores wall clock, environment and ambient request trace", (t) => {
  t.mock.method(Date, "now", () => 0);
  const name = "MIMIR_FIXTURE_CANARY";
  const previous = process.env[name];
  process.env[name] = "do-not-publish-this-value";
  try {
    const second = runWithTrace("mh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", renderApiContractFixtures);
    assert.equal(second, fixtureText);
    assert.equal(second.includes(process.env[name]), false);
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("header-version fixtures preserve read compatibility and reject invalid writes", () => {
  for (const example of fixtures.schemaVersions) {
    assert.deepEqual(resolveRequestVersion(example.raw, { mutating: example.mutating }), example.verdict, example.id);
  }
  assert.deepEqual(versioned({ claimId: 42 }), { schemaVersion: 1, data: { claimId: 42 } });
});

test("signed request fixtures validate with the existing envelope and shape helpers", () => {
  for (const exchange of fixtures.exchanges.filter((entry) => entry.request.method === "POST" && entry.response.status === 200)) {
    const payload = JSON.parse(exchange.request.body!) as SignedAgentRequest;
    assert.deepEqual(validateAgentRequestEnvelope(payload, fixtures.clockMs), [], exchange.id);
    assert.deepEqual(validateAgentApiRequest(payload), { ok: true, errors: [], unexpected: [] }, exchange.id);
  }
  for (const example of fixtures.envelopeCases) {
    assert.deepEqual(validateAgentRequestEnvelope(example.request, example.now), example.errors, example.id);
  }
  assert.equal(agentRequestMessage(fixtures.signingExample.request), fixtures.signingExample.message);
});

test("schema checks reject fixture corruption without echoing body contents", () => {
  const request = structuredClone(fixtures.signingExample.request);
  const sentinel = "private-synthetic-value-do-not-echo";
  const wrongType = checkShape({ ...request, signedAt: sentinel }, AGENT_API_REQUEST_SPEC);
  assert.deepEqual(wrongType.errors, ["signedAt must be a integer"]);
  assert.equal(JSON.stringify(wrongType).includes(sentinel), false);
  assert.deepEqual(validateAgentApiRequest({ ...request, body: [] }).errors, ["body must be a object"]);
  const extra = validateAgentApiRequest({ ...request, extra: sentinel });
  assert.equal(extra.ok, true);
  assert.deepEqual(extra.unexpected, ["extra"]);
  assert.equal(JSON.stringify(extra).includes(sentinel), false);
});

test("response fixtures validate their public shapes and reject corrupted atomic types", () => {
  const read = fixtures.exchanges.find((entry) => entry.id === "market-read")!;
  assert.equal(checkShape(read.response.body, {
    item: { type: "object", required: true },
    cache: { type: "object", required: true },
  }).ok, true);
  const snapshot = read.response.body as { item: Record<string, unknown>; cache: Record<string, unknown> };
  const marketSpec = {
    id: { type: "integer" as const, required: true, min: 1 },
    creator: { type: "string" as const, required: true },
    opponent: { type: "string" as const, required: true },
    question: { type: "string" as const, required: true },
    creator_position: { type: "string" as const, required: true },
    opponent_position: { type: "string" as const, required: true },
    resolution_url: { type: "string" as const, required: true },
    stake_amount: { type: "number" as const, required: true, min: 0 },
    deadline: { type: "integer" as const, required: true, min: 0 },
    state: { type: "string" as const, required: true, oneOf: ["open", "accepted", "resolved", "cancelled"] },
    winner: { type: "string" as const, required: true },
    resolution_summary: { type: "string" as const, required: true },
    category: { type: "string" as const, required: true },
  };
  assert.deepEqual(checkShape(snapshot.item, marketSpec), { ok: true, errors: [], unexpected: [] });
  assert.equal(checkShape({ ...snapshot.item, id: 0 }, marketSpec).ok, false);
  assert.equal(checkShape({ ...snapshot.item, stake_amount: "2" }, marketSpec).ok, false);
  assert.deepEqual(checkShape(snapshot.cache, {
    source: { type: "string", required: true, oneOf: ["index", "contract"] },
    status: { type: "string", required: true, oneOf: ["live", "cached", "stale"] },
    lastUpdatedAt: { type: "string" },
    ageMs: { type: "integer", min: 0 },
    freshnessWindowMs: { type: "integer", required: true, min: 1 },
  }), { ok: true, errors: [], unexpected: [] });
  const heartbeat = fixtures.exchanges.find((entry) => entry.id === "heartbeat")!;
  assert.equal(checkShape(heartbeat.response.body, {
    agentId: { type: "string", required: true },
    status: { type: "string", required: true, oneOf: ["active", "pending", "paused", "revoked"] },
    at: { type: "integer", required: true },
  }).ok, true);
  const atomicSpec = {
    currentAtomic: { type: "string" as const, required: true },
    requiredAtomic: { type: "string" as const, required: true },
    sufficient: { type: "boolean" as const, required: true },
    source: { type: "string" as const, required: true, oneOf: ["spendable_usdc_balance"] },
  };
  for (const exchange of fixtures.exchanges.filter((entry) => entry.spendableAtomic !== undefined)) {
    const body = exchange.response.body as { allowance: Record<string, unknown> };
    assert.deepEqual(checkShape(body.allowance, atomicSpec), { ok: true, errors: [], unexpected: [] });
    assert.equal(checkShape({ ...body.allowance, currentAtomic: 20_000_000 }, atomicSpec).ok, false);
  }
  for (const example of fixtures.errorCatalogue) {
    assert.equal(checkShape(example.response.body.error, {
      code: { type: "string", required: true, oneOf: apiErrorCatalogue().map((entry) => entry.code) },
      message: { type: "string", required: true },
      retryable: { type: "boolean", required: true },
      retryAfterSeconds: { type: "number" },
      trace_id: { type: "string" },
    }).ok, true);
  }
});

test("signed payload byte cap accepts the exact limit and rejects one byte more", () => {
  const request = fixtures.signingExample.request;
  // JSON.stringify({note:""}) consumes 11 UTF-8 bytes.
  const atLimit = { ...request, body: { note: "x".repeat(MAX_SIGNED_REQUEST_PAYLOAD_BYTES - 11) } };
  assert.deepEqual(validateAgentRequestEnvelope(atLimit, fixtures.clockMs), []);
  const overLimit = { ...request, body: { note: "x".repeat(MAX_SIGNED_REQUEST_PAYLOAD_BYTES - 10) } };
  assert.deepEqual(validateAgentRequestEnvelope(overLimit, fixtures.clockMs), [`payload exceeds ${MAX_SIGNED_REQUEST_PAYLOAD_BYTES} bytes`]);
});

test("every published error code retains its HTTP status, retry hint and headers", () => {
  const catalogue = apiErrorCatalogue();
  assert.deepEqual(fixtures.errorCatalogue.map(({ response: _response, ...spec }) => spec), catalogue);
  for (const example of fixtures.errorCatalogue) {
    const actual = runWithTrace(FIXTURE_TRACE_ID, () => apiError(example.code, `Fixture: ${example.code}`));
    assert.deepEqual(actual, example.response, example.code);
    assert.equal(example.response.status, example.status);
    assert.equal(example.response.body.error.retryable, example.retryable);
    const wait = example.retryAfterSeconds;
    assert.equal(example.response.headers["retry-after"], wait !== undefined && wait > 0 ? String(wait) : undefined);
  }
  for (const example of fixtures.retryOverrides) {
    const actual = runWithTrace(FIXTURE_TRACE_ID, () => apiError(example.code, "Fixture: rate_limited", { retryAfterSeconds: example.retryAfterSeconds }));
    assert.deepEqual(actual, example.response);
  }
});

test("synthetic fixture signatures and atomic amounts cannot be mistaken for funded state", () => {
  assert.equal(Buffer.from(FIXTURE_SIGNATURE, "base64").length, 64);
  assert.ok(Buffer.from(FIXTURE_SIGNATURE, "base64").every((byte) => byte === 0));
  assert.equal(verifyStellarSignedMessage({
    address: FIXTURE_WALLET,
    message: fixtures.signingExample.message,
    signature: FIXTURE_SIGNATURE,
  }), false);
  assert.equal(/\bS[A-Z2-7]{55}\b|-----BEGIN PRIVATE KEY-----|\bghp_[A-Za-z0-9]{36}\b/.test(fixtureText), false);
  const boundaries = fixtures.exchanges.filter((entry) => entry.spendableAtomic !== undefined);
  assert.deepEqual(boundaries.map((entry) => entry.spendableAtomic), [MIN_STAKE_ATOMIC.toString(), (MIN_STAKE_ATOMIC - 1n).toString()]);
  const responses = boundaries.map((entry) => entry.response.body as { allowed: boolean; allowance: { requiredAtomic: string } });
  assert.deepEqual(responses.map((body) => body.allowed), [true, false]);
  assert.ok(responses.every((body) => body.allowance.requiredAtomic === MIN_STAKE_ATOMIC.toString()));
});

test("HTTP fixtures match real routes with fake authentication, index and balances", async (t) => {
  t.mock.method(Date, "now", () => fixtures.clockMs);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Fixture tests must not access the network"); });
  const loader = Module as unknown as { _load: (request: string, parent: { filename?: string } | null, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  let balance = MIN_STAKE_ATOMIC;
  let writes = 0;
  let signatureChecks = 0;
  const fakeAgent = { agentId: "fixture-agent", status: "active", ownerWallet: FIXTURE_WALLET, operatorWallet: FIXTURE_WALLET, payoutWallet: FIXTURE_WALLET };
  const realUsdc = require("../../lib/usdc") as typeof import("../../lib/usdc");
  const stubs: Record<string, unknown> = {
    "@/lib/agents/authenticate": { authenticateAgentRequest: async () => ({ auth: { kind: "signature" } }), requiresOwnerSignature: () => false },
    "@/lib/agents/signature": { verifyAgentSignature: async (args: { address: string; message: string; signature: string }) => {
      signatureChecks += 1;
      assert.equal(args.address, FIXTURE_WALLET);
      assert.equal(args.signature, FIXTURE_SIGNATURE);
      assert.ok(args.message.startsWith("Mimir Agent API request\nversion: v1\n"));
      return true;
    } },
    "@/lib/agents/store": {
      loadAgent: async () => fakeAgent, loadIdempotentResponse: async () => null,
      auditAgentRequest: async () => { writes += 1; }, saveIdempotentResponse: async () => { writes += 1; },
    },
    "@/lib/agents/envelope-replay": { rejectReplayedSignedEnvelope: async () => null },
    "@/lib/api/policy": { authorizeRequest: async () => ({ allowed: true }) },
    "@/lib/agents/registry": { authorizeAction: () => ({ allowed: true }) },
    "@/lib/stellar": { isMarketConfigured: () => true },
    "@/lib/usdc": { ...realUsdc, getUsdcBalanceUnits: async () => balance },
    "@/lib/server/vs-index": { getVsDetailSnapshot: async (id: number) => id === 42 ? fixtureReadSnapshot() : { ...fixtureReadSnapshot(), item: null } },
    "@/lib/server/vs-cache": { VS_CACHE_HEADERS: { "Cache-Control": "s-maxage=15, stale-while-revalidate=60" } },
    "@/lib/contract": {}, "@/lib/db": {}, "@/lib/stellar-message": {},
    "@/lib/reasoning/publish": {}, "@/lib/agents/api-keys": {}, "@/lib/agents/spend-permissions": {},
    "@/lib/server/pause-registry": {}, "@/lib/research/gateway": {},
  };
  loader._load = function (request, parent, isMain) {
    const filename = parent?.filename?.replace(/\\/g, "/") ?? "";
    if ((filename.endsWith("/app/api/agents/v1/[action]/route.ts") || filename.endsWith("/app/api/vs/[id]/route.ts")) && Object.hasOwn(stubs, request)) {
      return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { GET } = require("../../app/api/vs/[id]/route") as { GET: (req: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };
    const { POST } = require("../../app/api/agents/v1/[action]/route") as { POST: (req: Request, context: { params: Promise<{ action: string }> }) => Promise<Response> };
    for (const exchange of fixtures.exchanges) {
      await t.test(exchange.id, async () => {
        writes = 0; signatureChecks = 0;
        balance = BigInt(exchange.spendableAtomic ?? MIN_STAKE_ATOMIC.toString());
        const req = new Request(`https://mimir.example${exchange.request.path}`, {
          method: exchange.request.method, headers: exchange.request.headers,
          ...(exchange.request.body !== null ? { body: exchange.request.body } : {}),
        });
        const lastPart = exchange.request.path.split("/").at(-1)!;
        const response = exchange.request.method === "GET"
          ? await GET(req, { params: Promise.resolve({ id: lastPart }) })
          : await POST(req, { params: Promise.resolve({ action: lastPart }) });
        assert.equal(response.status, exchange.response.status);
        assert.deepEqual(await response.json(), exchange.response.body);
        for (const [key, value] of Object.entries(exchange.response.headers)) assert.equal(response.headers.get(key), value, key);
        if (exchange.request.method === "GET") {
          assert.equal(response.headers.get("x-mimir-schema-version"), null);
        } else {
          assert.equal(response.headers.get(TRACE_HEADER), FIXTURE_TRACE_ID);
          if (exchange.response.status >= 400) {
            assert.equal(signatureChecks, 0, "invalid requests must be rejected before signature verification");
            assert.equal(writes, 0, "invalid requests must not reach persistence");
          } else {
            assert.equal(signatureChecks, 1);
            assert.equal(writes, 2);
          }
        }
      });
    }
  } finally {
    loader._load = originalLoad;
  }
});
