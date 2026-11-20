/** Offline wire examples for clients that do not use the TypeScript SDK. */
import {
  AGENT_API_VERSION,
  AGENT_REQUEST_MAX_SKEW_MS,
  agentRequestMessage,
  type SignedAgentRequest,
} from "../agents/api";
import { buildAgentDryRun } from "../agents/dry-run";
import { ZERO_ADDRESS } from "../constants";
import { runWithTrace } from "../ops/trace";
import { TRACE_HEADER } from "../ops/trace-http";
import { MIN_STAKE_ATOMIC, MIN_STAKE_USDC } from "../usdc";
import { apiError, apiErrorCatalogue, type ApiErrorCode } from "./errors";
import { API_SCHEMA_VERSION, schemaVersionHeaders } from "./schema";

export const API_CONTRACT_FIXTURE_PATH = "fixtures/api-contract/v1.json";
export const FIXTURE_NOW_MS = 1_755_200_000_000;
export const FIXTURE_TRACE_ID = "mh_00000000000000000000000000000001";
// Same synthetic public address as the existing OpenAPI examples; no seed.
export const FIXTURE_WALLET = "GB7RICBT3KM36Z5VDUFC63BYHTVZXM6IQZMWJ3LRNSM5RM63TRTJARRK";
export const FIXTURE_SIGNATURE = Buffer.alloc(64).toString("base64");

export interface FixtureResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface ApiContractExchange {
  id: string;
  description: string;
  request: {
    method: "GET" | "POST";
    path: string;
    headers: Record<string, string>;
    /** Exact HTTP body bytes, including deliberately invalid JSON. */
    body: string | null;
  };
  response: FixtureResponse;
  /** Fake upstream input; never a production balance or signing key. */
  spendableAtomic?: string;
}

function envelope(action: "heartbeat" | "dryRun", nonce: string): SignedAgentRequest {
  return {
    version: AGENT_API_VERSION,
    agentId: "fixture-agent",
    action,
    idempotencyKey: `fixture-${action}-${nonce.length}`,
    nonce,
    signedAt: FIXTURE_NOW_MS,
    body: action === "dryRun"
      ? { principalUsdc: MIN_STAKE_USDC, grossPayoutUsdc: MIN_STAKE_USDC * 2, stakeUsdc: MIN_STAKE_USDC }
      : {},
    signature: FIXTURE_SIGNATURE,
  };
}

export function fixtureMarket() {
  return {
    id: 42,
    creator: FIXTURE_WALLET,
    opponent: ZERO_ADDRESS,
    question: "Will the synthetic observation exceed ten?",
    creator_position: "Above ten",
    opponent_position: "Ten or below",
    resolution_url: "https://example.com/fixture-observation",
    stake_amount: MIN_STAKE_USDC,
    deadline: Math.floor(FIXTURE_NOW_MS / 1000) + 86_400,
    state: "open" as const,
    winner: ZERO_ADDRESS,
    resolution_summary: "",
    category: "custom",
  };
}

export function fixtureReadSnapshot() {
  return {
    item: fixtureMarket(),
    cache: {
      source: "index" as const,
      status: "live" as const,
      lastUpdatedAt: new Date(FIXTURE_NOW_MS).toISOString(),
      ageMs: 0,
      freshnessWindowMs: 15_000,
    },
  };
}

function writeResponse(body: unknown, status = 200): FixtureResponse {
  return {
    status,
    headers: { "cache-control": "no-store", ...schemaVersionHeaders(), [TRACE_HEADER]: FIXTURE_TRACE_ID },
    body,
  };
}

/** Pure data: no env, clock, randomness, network, database, or signing. */
export function buildApiContractFixtures() {
  // Replace any ambient request trace so generation is the same in every caller.
  return runWithTrace(FIXTURE_TRACE_ID, () => {
    const heartbeat = envelope("heartbeat", "fixture-heartbeat-1");
    const boundary = envelope("heartbeat", "n".repeat(128));
    const dryRun = envelope("dryRun", "fixture-dry-run-1");
    const headers = { "content-type": "application/json", [TRACE_HEADER]: FIXTURE_TRACE_ID };
    const heartbeatBody = { agentId: "fixture-agent", status: "active", at: FIXTURE_NOW_MS };
    const write = (
      id: string, description: string, payload: unknown, response: FixtureResponse,
      action = "heartbeat", spendableAtomic?: string,
    ): ApiContractExchange => ({
      id, description,
      request: { method: "POST", path: `/api/agents/v1/${action}`, headers, body: JSON.stringify(payload) },
      response,
      ...(spendableAtomic !== undefined ? { spendableAtomic } : {}),
    });
    // Public GET routes are untraced. Do not add trace fields they never send.
    const invalidId = runWithTrace({ traceId: "", source: "generated" }, () => apiError("invalid_request", "Invalid VS id", { field: "id" }));
    const notFound = runWithTrace({ traceId: "", source: "generated" }, () => apiError("not_found", "VS not found"));
    const exchanges: ApiContractExchange[] = [
      {
        id: "market-read", description: "Unversioned public read retains the existing plain JSON response.",
        request: { method: "GET", path: "/api/vs/42", headers: {}, body: null },
        response: { status: 200, headers: { "cache-control": "s-maxage=15, stale-while-revalidate=60" }, body: fixtureReadSnapshot() },
      },
      {
        id: "market-invalid-id", description: "Zero is outside the positive claim ID boundary.",
        request: { method: "GET", path: "/api/vs/0", headers: {}, body: null },
        response: invalidId,
      },
      {
        id: "market-not-found", description: "Missing and inaccessible claims return the same stable error.",
        request: { method: "GET", path: "/api/vs/99", headers: {}, body: null },
        response: notFound,
      },
      write("heartbeat", "Complete synthetic signed envelope; authentication is faked only in tests.", heartbeat, writeResponse(heartbeatBody)),
      write("nonce-at-limit", "A 128-character nonce remains supported.", boundary, writeResponse(heartbeatBody)),
      write("nonce-over-limit", "A 129-character nonce keeps the existing message-only 400 response.", { ...boundary, nonce: "n".repeat(129) }, writeResponse({ error: { message: "invalid nonce" } }, 400)),
      write("write-version-unsupported", "Unsupported envelope version keeps the existing rejection.", { ...heartbeat, version: "v2" }, writeResponse({ error: { message: "unsupported version" } }, 400)),
      write("write-extra-field", "The route rejects unexpected top-level fields after shape checking.", { ...heartbeat, extra: true }, writeResponse({ error: { message: "unexpected fields in request", details: ["extra"] } }, 400)),
      write("write-body-not-object", "The existing shape helper rejects an array body.", { ...heartbeat, body: [] }, writeResponse({ error: { message: "schema validation failed", details: ["body must be a object"] } }, 400)),
      {
        id: "write-invalid-json", description: "Malformed JSON retains a message-only failure.",
        request: { method: "POST", path: "/api/agents/v1/heartbeat", headers, body: "{" },
        response: writeResponse({ error: { message: "invalid JSON" } }, 400),
      },
      ...[MIN_STAKE_ATOMIC, MIN_STAKE_ATOMIC - 1n].map((balance) => write(
        balance === MIN_STAKE_ATOMIC ? "dry-run-exact-balance" : "dry-run-one-atomic-short",
        "Fake spendable balance compared with the required stake in integer atomic USDC; no transaction is sent.",
        dryRun,
        writeResponse(buildAgentDryRun({
          principalUsdc: MIN_STAKE_USDC, grossPayoutUsdc: MIN_STAKE_USDC * 2,
          outcome: "creator_wins", allowanceAtomic: balance, requiredAtomic: MIN_STAKE_ATOMIC,
          platformFeeBps: 0, agentOwnerFeeBps: 0,
          platformRecipient: FIXTURE_WALLET, ownerRecipient: FIXTURE_WALLET,
          policy: { allowed: true },
        })),
        "dryRun", balance.toString(),
      )),
    ];
    // Expectations are explicit so changes in negotiation require review.
    const versionInputs = [
      { id: "read-no-version", raw: null, mutating: false },
      { id: "write-no-version", raw: null, mutating: true },
      { id: "read-current", raw: "1", mutating: false },
      { id: "write-current", raw: "1", mutating: true },
      { id: "write-whitespace", raw: " 1 ", mutating: true },
      { id: "read-leading-zero", raw: "01", mutating: false },
      { id: "read-newer-version", raw: "2", mutating: false },
      { id: "read-older-version", raw: "0", mutating: false },
      { id: "read-malformed", raw: "1abc", mutating: false },
      { id: "write-empty-version", raw: " ", mutating: true },
    ];
    const versionVerdicts = [
      { ok: true, version: 1 },
      { ok: false, reason: "version_required", detail: "x-mimir-schema-version is required for this operation" },
      { ok: true, version: 1 },
      { ok: true, version: 1 },
      { ok: true, version: 1 },
      { ok: true, version: 1 },
      { ok: false, reason: "unsupported_version", detail: "server speaks 1, client sent 2" },
      { ok: false, reason: "unsupported_version", detail: "server speaks 1, client sent 0" },
      { ok: false, reason: "malformed_version", detail: "1abc" },
      { ok: false, reason: "version_required", detail: "x-mimir-schema-version is required for this operation" },
    ];
    const schemaVersions = versionInputs.map((input, index) => ({ ...input, verdict: versionVerdicts[index]! }));
    const envelopeCases = [
      { id: "signed-fresh", now: FIXTURE_NOW_MS, request: heartbeat, errors: [] },
      { id: "signed-skew-at-limit", now: FIXTURE_NOW_MS + AGENT_REQUEST_MAX_SKEW_MS, request: heartbeat, errors: [] },
      { id: "signed-skew-over-limit", now: FIXTURE_NOW_MS + AGENT_REQUEST_MAX_SKEW_MS + 1, request: heartbeat, errors: ["signed timestamp outside allowed window"] },
      { id: "signed-future-at-limit", now: FIXTURE_NOW_MS - AGENT_REQUEST_MAX_SKEW_MS, request: heartbeat, errors: [] },
      { id: "signed-future-over-limit", now: FIXTURE_NOW_MS - AGENT_REQUEST_MAX_SKEW_MS - 1, request: heartbeat, errors: ["signed timestamp outside allowed window"] },
    ];
    const errorCatalogue = apiErrorCatalogue().map((spec) => ({
      ...spec,
      response: apiError(spec.code, `Fixture: ${spec.code}`),
    }));
    const retryOverrides = [0, 2.2].map((retryAfterSeconds) => ({
      code: "rate_limited" as ApiErrorCode, retryAfterSeconds,
      response: apiError("rate_limited", "Fixture: rate_limited", { retryAfterSeconds }),
    }));
    return {
      fixtureVersion: 1,
      apiSchemaVersion: API_SCHEMA_VERSION,
      clockMs: FIXTURE_NOW_MS,
      traceId: FIXTURE_TRACE_ID,
      exchanges, schemaVersions, envelopeCases, errorCatalogue, retryOverrides,
      signingExample: { request: heartbeat, message: agentRequestMessage(heartbeat) },
    };
  });
}

export function renderApiContractFixtures(): string {
  return `${JSON.stringify(buildApiContractFixtures(), null, 2)}\n`;
}
