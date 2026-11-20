import { sha256Hex } from "@/lib/content-hash";
import { checkWriteAllowed, type Pausable, type WriteGateResult } from "@/lib/ops/flags";

export const AGENT_API_VERSION = "v1";
export const AGENT_API_ACTIONS = [
  "register", "heartbeat", "proposeMarket", "createMarket", "publishReasoning",
  "vote", "stake", "listPositions", "listEarnings", "revoke", "dryRun",
  // Credential and budget management. issueKey/revokeKey/rotateKey and grantSpend
  // are owner-signed; the rest an agent may call with its own key.
  // rotateKey issues a fresh key and schedules the old one's expiry so both are
  // valid during the overlap window — callers have time to update their credential.
  "issueKey", "listKeys", "revokeKey", "rotateKey", "grantSpend", "revokeSpend", "spendStatus",
] as const;
export type AgentApiAction = (typeof AGENT_API_ACTIONS)[number];

/**
 * Actions that put an owner's USDC at risk, gated on `byoa_funded_actions` so the
 * launch-gate document and the code agree: until an operator enables it, an agent
 * can register, read and dry-run but cannot move money.
 *
 * Lives here, not in the route, because the published wire contract
 * (`lib/ops/agent-api-openapi.ts`) reads it from the same place the route does. A
 * second copy in the docs is a copy that drifts.
 */
export const AGENT_FUNDED_ACTIONS: readonly AgentApiAction[] = ["createMarket", "stake", "vote"];

/** The rollout flag every funded action additionally requires. */
export const AGENT_FUNDED_FEATURE = "byoa_funded_actions" as const;

/** The rollout flag that gates registration. */
export const AGENT_REGISTRY_FEATURE = "byoa_registry" as const;

/**
 * Actions that require an owner-signed envelope and cannot be called with an API
 * key. The server rejects these from bearer credentials; the SDK refuses to send
 * them locally so the failure is clear and never reaches the wire.
 */
export const AGENT_OWNER_SIGNED_ACTIONS: readonly AgentApiAction[] = [
  "issueKey", "revokeKey", "rotateKey", "grantSpend",
];

/** True when an action must be owner-signed. */
export function isOwnerSignedAction(action: AgentApiAction): boolean {
  return (AGENT_OWNER_SIGNED_ACTIONS as readonly string[]).includes(action);
}

export interface SignedAgentRequest<T = unknown> {
  version: typeof AGENT_API_VERSION;
  agentId: string;
  action: AgentApiAction;
  idempotencyKey: string;
  nonce: string;
  signedAt: number;
  body: T;
  /** Base64 Ed25519 signature over {@link agentRequestMessage}, as SEP-43 returns it. */
  signature: string;
}

/** Retain the previously exported spelling for existing type consumers. */
export type SignedAgentRequesT<T = unknown> = SignedAgentRequest<T>;

/**
 * The incident switch that stops each agent action. Anything absent has none on
 * purpose: reads, dry runs, proposals (they move no money) and every revocation,
 * which is how an owner contains an incident and so must work during one.
 */
export const AGENT_ACTION_PAUSE: Partial<Record<AgentApiAction, Pausable>> = {
  register: "agent_registration",
  createMarket: "create_market",
  stake: "stake",
  vote: "stake",
};

/** Pause gate for one agent action; `allowed: true` for actions with no switch. */
export function agentActionPauseGate(
  action: AgentApiAction,
  env: Record<string, string | undefined> = process.env,
): WriteGateResult {
  const capability = AGENT_ACTION_PAUSE[action];
  return capability ? checkWriteAllowed({ capability }, env) : { allowed: true };
}

export const AGENT_REQUEST_MAX_SKEW_MS = 5 * 60_000;

/**
 * Cap on the UTF-8 byte size of the signed request `body` field (JSON).
 *
 * The agent API is a money-moving surface; unbounded bodies let a caller force
 * expensive stable-stringify + hashing work before the envelope is rejected.
 * Reuses the same 64 KiB bound as {@link MAX_SIGNED_REQUEST_BODY_BYTES} in
 * `lib/api/signed-request.ts`.
 */
export const MAX_SIGNED_REQUEST_PAYLOAD_BYTES = 64 * 1024;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** UTF-8 byte length of a JSON-serialisable value (the body size we enforce). */
export function signedRequestPayloadBytes(body: unknown): number {
  const raw = body === undefined ? "null" : JSON.stringify(body);
  return new TextEncoder().encode(raw ?? "null").length;
}

export function agentRequestMessage(request: Omit<SignedAgentRequest, "signature">): string {
  const bodyHash = sha256Hex(stable(request.body));
  return [
    "Mimir Agent API request", `version: ${request.version}`, `agent: ${request.agentId}`,
    `action: ${request.action}`, `idempotency: ${request.idempotencyKey}`,
    `nonce: ${request.nonce}`, `signedAt: ${request.signedAt}`, `bodyHash: ${bodyHash}`,
  ].join("\n");
}

/**
 * Domain separator for the register action's SECOND signature.
 *
 * `register` needs two proofs: the owner grants the record, and the operator
 * proves it controls the hot key it is about to be handed. They are separate
 * messages because they are separate claims — one signature must never satisfy
 * both — and the leading `Mimir …' line is the domain separation that keeps a
 * proof harvested from another surface from verifying here.
 *
 * Exported so the published wire contract carries the exact bytes an operator has
 * to sign; the route and the generator must not each hold their own copy.
 */
export const AGENT_OPERATOR_PROOF_DOMAIN = "Mimir agent operator proof";

export function operatorProofMessage(agentId: string, operatorWallet: string): string {
  // NOT lowercased. A strdk is case-sensitive base32; folding the case names a
  // wallet that does not exist.
  return `${AGENT_OPERATOR_PROOF_DOMAIN}\nagent: ${agentId}\noperator: ${operatorWallet.trim()}`;
}

/**
 * Validate the envelope.
 *
 * `requireSignature: false` is for API-key callers: the server fills the nonce and
 * timestamp itself for them, so demanding a signed, clock-synced envelope would be
 * demanding proof of something the key already established. The signed path keeps
 * every check, because there the envelope IS the credential.
 */
export function validateAgentRequestEnvelope(
  request: SignedAgentRequest,
  now = Date.now(),
  opts: { requireSignature?: boolean } = {},
): string[] {
  const requireSignature = opts.requireSignature ?? true;
  const errors: string[] = [];
  if (!requireSignature) {
    if (request.version !== AGENT_API_VERSION) errors.push("unsupported version");
    if (!(AGENT_API_ACTIONS as readonly string[]).includes(request.action)) errors.push("unknown action");
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(request.agentId)) errors.push("invalid agentId");
    if (request.idempotencyKey && request.idempotencyKey.length > 128) errors.push("invalid idempotencyKey");
    if (signedRequestPayloadBytes(request.body) > MAX_SIGNED_REQUEST_PAYLOAD_BYTES) {
      errors.push(`payload exceeds ${MAX_SIGNED_REQUEST_PAYLOAD_BYTES} bytes`);
    }
    return errors;
  }
  if (request.version !== AGENT_API_VERSION) errors.push("unsupported version");
  if (!(AGENT_API_ACTIONS as readonly string[]).includes(request.action)) errors.push("unknown action");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(request.agentId)) errors.push("invalid agentId");
  if (!request.idempotencyKey || request.idempotencyKey.length > 128) errors.push("invalid idempotencyKey");
  if (!request.nonce || request.nonce.length > 128) errors.push("invalid nonce");
  if (!Number.isFinite(request.signedAt) || Math.abs(now - request.signedAt) > AGENT_REQUEST_MAX_SKEW_MS) {
    errors.push("signed timestamp outside allowed window");
  }
  // Base64, as SEP-43 `signMessage` returns it. An Ed25519 signature is always
  // 64 bytes, which is 86 base64 characters plus padding — but the length is
  // checked where the bytes are decoded (`verifyStellarSignedMessage`), because
  // that is where a wrong length can be reported as a failed verification rather
  // than as a malformed envelope. This is only a cheap "did the client send
  // anything credential-shaped" gate.
  if (!/^[A-Za-z0-9+/]{16,86}={0,2}$/.test(request.signature)) {
    errors.push("invalid signature encoding");
  }
  if (signedRequestPayloadBytes(request.body) > MAX_SIGNED_REQUEST_PAYLOAD_BYTES) {
    errors.push(`payload exceeds ${MAX_SIGNED_REQUEST_PAYLOAD_BYTES} bytes`);
  }
  return errors;
}
