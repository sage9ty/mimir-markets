/**
 * Request and response schema versioning (§11).
 *
 * No Zod. The repo has no validation dependency and does not need one for this: a
 * field-shape check is about forty lines, and a dependency in the request path is
 * a supply-chain surface for the sake of syntax. What was actually missing is the
 * *versioning* — a client and a server disagreeing about a payload shape should
 * fail loudly at the boundary rather than produce a confusing 500 three layers in.
 *
 * The rules:
 *
 *  - **An unknown or newer client version is refused, not coerced.** A client
 *    speaking v2 to a v1 server is asking for behaviour that does not exist.
 *  - **A missing version is accepted for reads and refused for writes.** Existing
 *    read clients must keep working; a payment whose shape nobody pinned is not
 *    something to guess at.
 *  - **An unexpected extra field is reported, never silently ignored.** Silently
 *    dropping a field is how a caller believes it set a cap that never applied.
 *  - **Every response carries its version**, so a cached body can be identified
 *    later rather than guessed at from its keys.
 *
 * Pagination cursors are bound to the normalized query they were issued for
 * (see `bindCursor` / `verifyCursor`): a cursor minted under one sort or filter
 * selection is refused under any other, so a client cannot silently splice pages
 * from two different result sets together.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const API_SCHEMA_VERSION = 1;

/** Header a client uses to state the schema version it speaks. */
export const SCHEMA_VERSION_HEADER = "x-mimir-schema-version";

export interface VersionVerdict {
  ok: boolean;
  /** The version to apply. Present when ok. */
  version?: number;
  reason?: "unsupported_version" | "version_required" | "malformed_version";
  detail?: string;
}

/**
 * Decide which schema version a request is speaking.
 *
 * `mutating` requests must state it; reads may omit it and get the current
 * version, so existing clients keep working.
 */
export function resolveRequestVersion(
  raw: string | null | undefined,
  opts: { mutating?: boolean } = {},
): VersionVerdict {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    if (opts.mutating) {
      return {
        ok: false,
        reason: "version_required",
        detail: `${SCHEMA_VERSION_HEADER} is required for this operation`,
      };
    }
    return { ok: true, version: API_SCHEMA_VERSION };
  }
  // Digits only: "1.0", "v1" and "1 " with junk are all a client that has not
  // agreed on the format, and parseInt would silently accept "1abc" as 1.
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: "malformed_version", detail: trimmed };
  }
  const version = Number(trimmed);
  if (version !== API_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "unsupported_version",
      detail: `server speaks ${API_SCHEMA_VERSION}, client sent ${version}`,
    };
  }
  return { ok: true, version };
}

// ── Pagination cursors ────────────────────────────────────────────────────────

/**
 * Query parameters that determine which records a cursor walks through and in
 * what order. Anything that changes the result set or its ordering belongs here.
 */
export interface CursorQuery {
  sort?: string;
  order?: "asc" | "desc";
  filters?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * Canonical string form of a query: keys sorted, empty/undefined filters dropped,
 * values stringified. Two requests that mean the same selection normalize to the
 * same string regardless of parameter order or casing of the sort direction.
 */
export function normalizeCursorQuery(query: CursorQuery): string {
  const filters: Record<string, string> = {};
  for (const key of Object.keys(query.filters ?? {}).sort()) {
    const value = query.filters![key];
    if (value === undefined || value === null || value === "") continue;
    filters[key] = String(value);
  }
  return JSON.stringify({
    sort: query.sort ?? "",
    order: (query.order ?? "asc").toLowerCase(),
    filters,
  });
}

/** Payload carried inside a cursor. `b` binds it to a normalized query. */
export interface CursorPayload {
  /** Position: the last sort key and record id seen on the previous page. */
  k: string | number;
  i: string;
  /** Query binding: a digest of the normalized query the cursor was issued for. */
  b: string;
}

export type CursorVerdict =
  | { ok: true; payload: CursorPayload }
  | { ok: false; reason: "malformed_cursor" | "cursor_query_mismatch" };

function queryDigest(query: CursorQuery, secret: string): string {
  return createHmac("sha256", secret).update(normalizeCursorQuery(query)).digest("base64url").slice(0, 22);
}

/**
 * Mint an opaque cursor for the next page, bound to the query it was issued for.
 * `secret` is the server-side key; clients never learn the digest's preimage.
 */
export function bindCursor(
  position: { key: string | number; id: string },
  query: CursorQuery,
  secret: string,
): string {
  const payload: CursorPayload = { k: position.key, i: position.id, b: queryDigest(query, secret) };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode a cursor and check it was issued for `query`. A cursor minted under a
 * different sort or filter selection is refused rather than applied, since its
 * position is meaningless against the new result set.
 */
export function verifyCursor(cursor: string, query: CursorQuery, secret: string): CursorVerdict {
  let payload: CursorPayload;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as CursorPayload).b !== "string" ||
      typeof (parsed as CursorPayload).i !== "string" ||
      (typeof (parsed as CursorPayload).k !== "string" && typeof (parsed as CursorPayload).k !== "number")
    ) {
      return { ok: false, reason: "malformed_cursor" };
    }
    payload = parsed as CursorPayload;
  } catch {
    return { ok: false, reason: "malformed_cursor" };
  }

  const expected = Buffer.from(queryDigest(query, secret));
  const actual = Buffer.from(payload.b);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "cursor_query_mismatch" };
  }
  return { ok: true, payload };
}

/**
 * Deterministic ordering comparator for equal-ranked records: sort key first,
 * then record id as a stable tiebreak. Pages never skip or repeat records that
 * share a sort key, because the position is (key, id), not key alone.
 */
export function compareWithTiebreak(
  a: { key: string | number; id: string },
  b: { key: string | number; id: string },
  order: "asc" | "desc" = "asc",
): number {
  const sign = order === "desc" ? -1 : 1;
  if (a.key < b.key) return -1 * sign;
  if (a.key > b.key) return 1 * sign;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

// ── Minimal shape checking ────────────────────────────────────────────────────

export type FieldType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  /** Strings: maximum length. Numbers: maximum value. */
  max?: number;
  /** Strings: minimum length. Numbers: minimum value. */
  min?: number;
  /** Strings: allowed values. */
  oneOf?: readonly string[];
}

export type ShapeSpec = Record<string, FieldSpec>;

export interface ShapeResult {
  ok: boolean;
  errors: string[];
  /** Fields present in the payload that the spec does not declare. */
  unexpected: string[];
}

function typeOk(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      // Arrays are objects in JS and almost never what an "object" field means.
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export function checkShape(payload: unknown, spec: ShapeSpec): ShapeResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, errors: ["payload must be a JSON object"], unexpected: [] };
  }
  const record = payload as Record<string, unknown>;
  const errors: string[] = [];

  for (const [field, rule] of Object.entries(spec)) {
    const value = record[field];
    const present = value !== undefined && value !== null;
    if (!present) {
      if (rule.required) errors.push(`${field} is required`);
      continue;
    }
    if (!typeOk(value, rule.type)) {
      errors.push(`${field} must be a ${rule.type}`);
      continue;
    }
    if (typeof value === "string") {
      if (rule.min !== undefined && value.length < rule.min) {
        errors.push(`${field} must be at least ${rule.min} characters`);
      }
      if (rule.max !== undefined && value.length > rule.max) {
        errors.push(`${field} must be at most ${rule.max} characters`);
      }
      if (rule.oneOf && !rule.oneOf.includes(value)) {
        errors.push(`${field} must be one of: ${rule.oneOf.join(", ")}`);
      }
    }
    if (typeof value === "number") {
      if (rule.min !== undefined && value < rule.min) errors.push(`${field} must be >= ${rule.min}`);
      if (rule.max !== undefined && value > rule.max) errors.push(`${field} must be <= ${rule.max}`);
    }
  }

  // Reported, not an error by itself: an extra field is usually a client on a
  // newer shape, and the version check is the right place to refuse that. But
  // silently dropping it is how a caller believes it set a cap that never applied.
  const unexpected = Object.keys(record).filter((key) => !(key in spec));

  return { ok: errors.length === 0, errors, unexpected };
}

// ── Responses ─────────────────────────────────────────────────────────────────

export interface VersionedResponse<T> {
  schemaVersion: number;
  data: T;
}

/** Wrap a payload with the version that produced it. */
export function versioned<T>(data: T): VersionedResponse<T> {
  return { schemaVersion: API_SCHEMA_VERSION, data };
}

/** Header set on every response, so a cached body can be identified later. */
export function schemaVersionHeaders(): Record<string, string> {
  return { [SCHEMA_VERSION_HEADER]: String(API_SCHEMA_VERSION) };
}

// ── Agent API Drift Check ─────────────────────────────────────────────────────

/**
 * Define the expected shape of the Agent API request body for drift checking.
 *
 * This spec mirrors the JSON Schema in schemas/agent-api-v1.schema.json and the
 * runtime validation in lib/agents/api.ts. It ensures the contract-first approach
 * is enforced at the API boundary.
 */
export const AGENT_API_REQUEST_SPEC: ShapeSpec = {
  version: { type: "string", required: true, oneOf: ["v1"] },
  agentId: { type: "string", required: true, min: 3, max: 64 },
  action: { type: "string", required: true, oneOf: ["register", "heartbeat", "proposeMarket", "createMarket", "publishReasoning", "vote", "stake", "listPositions", "listEarnings", "revoke", "dryRun"] },
  idempotencyKey: { type: "string", required: true, min: 1, max: 128 },
  nonce: { type: "string", required: true, min: 1, max: 128 },
  signedAt: { type: "integer", required: true },
  body: { type: "object", required: true },
  signature: { type: "string", required: true, min: 16, max: 256 },
};

/**
 * Validate the agent API request against the defined schema spec.
 *
 * Returns a ShapeResult indicating validity, errors, and any unexpected fields.
 */
export function validateAgentApiRequest(payload: unknown): ShapeResult {
  return checkShape(payload, AGENT_API_REQUEST_SPEC);
}
