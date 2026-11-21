/**
 * Package script contract verifier — fail-closed checks for `package.json`.
 *
 * Ensures every contributor, CI, and release script in `package.json`:
 *  1. Matches the reviewed script contract (no missing required scripts, no
 *     unreviewed extra scripts or silently altered commands).
 *  2. Parses cleanly into valid shell commands with no malformed quoting or
 *     dangling operators.
 *  3. Resolves every referenced repository file, test file, fixture, manifest,
 *     local `node_modules/.bin` CLI, system tool, and nested `npm run` /
 *     `npm:` target on disk.
 *  4. Preserves CLI argument forwarding (`npm run <script> -- ...`) where
 *     documented or required by CI/release tooling.
 *  5. Covers every `npm run <script>` referenced by `.github/workflows/ci.yml`
 *     and `CONTRIBUTING.md`.
 *
 * Pure over injected filesystem/document inputs so unit tests can exercise all
 * positive, boundary, and failure modes offline without mutating the repository.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type ReviewedScriptCategory =
  | "app"
  | "quality"
  | "test"
  | "contract"
  | "release"
  | "worker"
  | "ops"
  | "db";

export interface ReviewedScriptSpec {
  /** Exact reviewed command string in `package.json`. */
  command: string;
  /** Workflow area for grouping and diagnostics. */
  category: ReviewedScriptCategory;
  /** Whether `npm run <name> -- ...` must append arguments cleanly to a single command. */
  supportsArgForwarding: boolean;
}

/**
 * Canonical reviewed script contract for Mimir's contributor, CI, worker, and
 * release workflows. Adding, removing, or changing a script requires updating
 * this contract in the same pull request.
 */
export const REVIEWED_PACKAGE_SCRIPTS: Readonly<Record<string, ReviewedScriptSpec>> = Object.freeze({
  // App lifecycle
  dev: { command: "next dev", category: "app", supportsArgForwarding: true },
  "dev:clean": { command: "rm -rf .next && next dev", category: "app", supportsArgForwarding: false },
  clean: { command: "rm -rf .next", category: "app", supportsArgForwarding: false },
  build: { command: "next build", category: "app", supportsArgForwarding: true },
  start: { command: "next start", category: "app", supportsArgForwarding: true },

  // Typecheck, lint & repo hygiene
  typecheck: { command: "tsc --noEmit", category: "quality", supportsArgForwarding: true },
  "check:terms": {
    command: "node scripts/check-forbidden-terms.mjs",
    category: "quality",
    supportsArgForwarding: true,
  },
  lint: { command: "npm run check:terms", category: "quality", supportsArgForwarding: true },
  "check:locales": {
    command: "node scripts/check-locale-completeness.mjs",
    category: "quality",
    supportsArgForwarding: true,
  },
  "check:locales:strict": {
    command: "node scripts/check-locale-completeness.mjs --strict",
    category: "quality",
    supportsArgForwarding: true,
  },
  "check:driver-parity": {
    command: "node scripts/ci/check-driver-parity.mjs",
    category: "quality",
    supportsArgForwarding: true,
  },
  "ci:changed-paths": {
    command: "node scripts/ci/changed-paths.mjs",
    category: "quality",
    supportsArgForwarding: true,
  },
  "check:lockfile": {
    command: "git diff --exit-code package-lock.json",
    category: "quality",
    supportsArgForwarding: true,
  },
  "check:toolchains": {
    command: "tsx scripts/check-contract-toolchains.ts",
    category: "contract",
    supportsArgForwarding: true,
  },
  "check:schema-snapshot": {
    command: "tsx scripts/check-schema-snapshot.ts",
    category: "db",
    supportsArgForwarding: true,
  },
  "check:openapi": {
    command: "tsx scripts/generate-agent-openapi.ts",
    category: "quality",
    supportsArgForwarding: true,
  },
  "check:api-fixtures": {
    command: "node --import tsx scripts/check-api-contract-fixtures.ts",
    category: "quality",
    supportsArgForwarding: true,
  },
  "check:trace": {
    command: "tsx scripts/check-trace-correlation.ts",
    category: "quality",
    supportsArgForwarding: true,
  },
  "check:ledger-fixture": {
    command: "tsx scripts/replay-ledger-fixture.ts fixtures/ledger/funded-market-v1.json",
    category: "contract",
    supportsArgForwarding: true,
  },
  "replay:ledger": {
    command: "tsx scripts/replay-ledger-fixture.ts",
    category: "contract",
    supportsArgForwarding: true,
  },

  // Test & coverage runners
  "test:node": {
    command: "node scripts/run-node-tests.mjs",
    category: "test",
    supportsArgForwarding: true,
  },
  "test:node:coverage": {
    command: "node scripts/run-node-tests.mjs --coverage",
    category: "test",
    supportsArgForwarding: true,
  },
  "test:api-fixtures": {
    command: "node scripts/run-node-tests.mjs api-contract-fixtures",
    category: "test",
    supportsArgForwarding: true,
  },
  "test:smoke": {
    command: "node scripts/run-node-tests.mjs",
    category: "test",
    supportsArgForwarding: true,
  },
  "test:coverage": {
    command: "node scripts/run-coverage.mjs",
    category: "test",
    supportsArgForwarding: true,
  },
  "test:research": {
    command:
      "node --import tsx --test tests/node/research-adapters.test.ts tests/node/research-allowlist.test.ts tests/node/categories.test.ts tests/node/context-pack.test.ts tests/node/research-ssrf.test.ts tests/node/research-redirects.test.ts tests/node/source-fallback.test.ts tests/node/research-gateway.test.ts tests/node/x402-discovery.test.ts tests/node/evidence-fetcher-redirects.test.ts",
    category: "test",
    supportsArgForwarding: true,
  },
  "test:squad": {
    command: "node --import tsx --test tests/node/squad-view.test.ts tests/node/squad-pool.test.ts",
    category: "test",
    supportsArgForwarding: true,
  },
  "test:baskets": {
    command: "node --import tsx --test tests/node/baskets.test.ts",
    category: "test",
    supportsArgForwarding: true,
  },
  "test:risk": {
    command: "node --import tsx --test tests/node/oracle-risk.test.ts",
    category: "test",
    supportsArgForwarding: true,
  },
  "test:schema": {
    command:
      "node --import tsx --test tests/node/schema-backlog.test.ts tests/node/schema-snapshot.test.ts",
    category: "test",
    supportsArgForwarding: true,
  },
  "test:kill-switches": {
    command:
      "node --import tsx --test tests/node/incident-kill-switches.test.ts tests/node/ops-flags.test.ts",
    category: "test",
    supportsArgForwarding: true,
  },
  "test:migrations": {
    command: "node --import tsx --test tests/node/migrations.test.ts",
    category: "test",
    supportsArgForwarding: true,
  },
  "test:contracts": {
    command: "cargo test --manifest-path contracts-soroban/Cargo.toml --release",
    category: "contract",
    supportsArgForwarding: true,
  },
  "smoke:browser": {
    command: "node scripts/run-browser-smoke.mjs",
    category: "test",
    supportsArgForwarding: true,
  },

  // Release, security & verification gates
  "sbom:release": {
    command: "node scripts/generate-release-sbom.mjs",
    category: "release",
    supportsArgForwarding: true,
  },
  "audit:deps": {
    command: "node --import tsx scripts/check-npm-audit.ts",
    category: "release",
    supportsArgForwarding: true,
  },
  "rollback:rehearsal": {
    command: "tsx scripts/rollback-rehearsal.ts --fixture",
    category: "release",
    supportsArgForwarding: true,
  },
  "rollback:rehearsal:live": {
    command: "tsx --env-file-if-exists=.env.local scripts/rollback-rehearsal.ts",
    category: "release",
    supportsArgForwarding: true,
  },
  "fault:profile": {
    command: "tsx scripts/run-fault-injection-profile.ts",
    category: "ops",
    supportsArgForwarding: true,
  },
  "verify:deployment": {
    command: "tsx --env-file-if-exists=.env.local scripts/verify-deployment.ts",
    category: "release",
    supportsArgForwarding: true,
  },
  "verify:artifacts": {
    command: "tsx scripts/verify-artifact-provenance.ts",
    category: "release",
    supportsArgForwarding: true,
  },
  "verify:cache-backup": {
    command: "node --import tsx scripts/verify-cache-backup.ts",
    category: "release",
    supportsArgForwarding: true,
  },
  "verify:release-readiness": {
    command: "node --import tsx scripts/verify-release-readiness.ts",
    category: "release",
    supportsArgForwarding: true,
  },
  "verify:analytics": {
    command: "tsx scripts/check-analytics-gates.ts",
    category: "release",
    supportsArgForwarding: true,
  },
  "verify:status": {
    command: "tsx scripts/verify-operational-status.ts",
    category: "release",
    supportsArgForwarding: true,
  },
  "verify:package-scripts": {
    command: "node --import tsx scripts/verify-package-scripts.ts",
    category: "quality",
    supportsArgForwarding: true,
  },

  // Agent workers
  oracle: {
    command: "tsx --env-file-if-exists=.env.local agents/oracle/index.ts",
    category: "worker",
    supportsArgForwarding: true,
  },
  "oracle:challenge": {
    command: "AUTO_CHALLENGE=1 tsx --env-file-if-exists=.env.local agents/oracle/index.ts",
    category: "worker",
    supportsArgForwarding: true,
  },
  "market-creator": {
    command: "tsx --env-file-if-exists=.env.local agents/market-creator/index.ts",
    category: "worker",
    supportsArgForwarding: true,
  },
  council: {
    command: "tsx --env-file-if-exists=.env.local agents/council/index.ts",
    category: "worker",
    supportsArgForwarding: true,
  },
  sync: {
    command: "tsx --env-file-if-exists=.env.local agents/sync/index.ts",
    category: "worker",
    supportsArgForwarding: true,
  },
  traders: {
    command: "tsx --env-file-if-exists=.env.local agents/traders/index.ts",
    category: "worker",
    supportsArgForwarding: true,
  },
  workers: {
    command:
      'concurrently --names oracle,creator,council,sync,traders --kill-others-on-fail -c blue,magenta,green,cyan,yellow "npm:oracle" "npm:market-creator" "npm:council" "npm:sync" "npm:traders"',
    category: "worker",
    supportsArgForwarding: false,
  },

  // Agent fleet, Stellar, demo & live smoke scripts
  "agents:create-wallets": {
    command: "tsx scripts/create-agent-wallets.ts --write",
    category: "ops",
    supportsArgForwarding: true,
  },
  "agents:fund": {
    command: "tsx --env-file-if-exists=.env.local scripts/fund-agents.ts",
    category: "ops",
    supportsArgForwarding: true,
  },
  "agents:distribute": {
    command: "tsx --env-file-if-exists=.env.local scripts/fund-from-oracle.ts",
    category: "ops",
    supportsArgForwarding: true,
  },
  "agents:funding-plan": {
    command: "tsx --env-file-if-exists=.env.local scripts/fund-from-oracle.ts --dry-run",
    category: "ops",
    supportsArgForwarding: true,
  },
  "agents:balances": {
    command: "tsx --env-file-if-exists=.env.local scripts/check-agent-balances.ts",
    category: "ops",
    supportsArgForwarding: true,
  },
  "agents:gas": {
    command: "tsx --env-file-if-exists=.env.local scripts/distribute-gas.ts",
    category: "ops",
    supportsArgForwarding: true,
  },
  "demo:cycle": {
    command: "tsx --env-file-if-exists=.env.local scripts/demo-full-cycle.ts",
    category: "ops",
    supportsArgForwarding: true,
  },
  seed: {
    command: "tsx --env-file-if-exists=.env.local scripts/seed-claims.ts",
    category: "ops",
    supportsArgForwarding: true,
  },
  "seed:dry": {
    command: "tsx scripts/seed-claims.ts --dry-run",
    category: "ops",
    supportsArgForwarding: true,
  },
  "stellar:keys": {
    command: "tsx --env-file-if-exists=.env.local scripts/stellar-keys.ts",
    category: "contract",
    supportsArgForwarding: true,
  },
  "stellar:usdc": {
    command: "tsx --env-file-if-exists=.env.local scripts/stellar-usdc-faucet.ts",
    category: "contract",
    supportsArgForwarding: true,
  },
  "stellar:bindings": {
    command: "tsx --env-file-if-exists=.env.local scripts/stellar-bindings.ts",
    category: "contract",
    supportsArgForwarding: true,
  },
  "deploy:contract": {
    command: "tsx --env-file-if-exists=.env.local deploy/deploy.ts",
    category: "contract",
    supportsArgForwarding: true,
  },
  "smoke:x402": {
    command: "tsx --env-file-if-exists=.env.local scripts/x402-stellar-smoke.ts",
    category: "ops",
    supportsArgForwarding: true,
  },
  "smoke:x402:http": {
    command: "tsx --env-file-if-exists=.env.local scripts/x402-http-smoke.ts",
    category: "ops",
    supportsArgForwarding: true,
  },
  "smoke:onchain": {
    command: "tsx --env-file-if-exists=.env.local scripts/onchain-smoke.ts",
    category: "ops",
    supportsArgForwarding: true,
  },
  "smoke:onchain:full": {
    command: "tsx --env-file-if-exists=.env.local scripts/onchain-smoke.ts --resolve --squad",
    category: "ops",
    supportsArgForwarding: true,
  },
  "load:x402": {
    command: "tsx scripts/load-x402-verify.ts",
    category: "ops",
    supportsArgForwarding: true,
  },
  "load:rate-limit": {
    command: "tsx scripts/load-rate-limit.ts",
    category: "ops",
    supportsArgForwarding: true,
  },

  // Read-index cache & reversible migrations
  "warm:vs-index": {
    command: "tsx scripts/warm-vs-index.ts",
    category: "db",
    supportsArgForwarding: true,
  },
  "backup:read-index": {
    command: "tsx --env-file-if-exists=.env.local scripts/backup-read-index.ts",
    category: "db",
    supportsArgForwarding: true,
  },
  "restore:read-index": {
    command: "tsx --env-file-if-exists=.env.local scripts/restore-read-index.ts",
    category: "db",
    supportsArgForwarding: true,
  },
  "migrate:status": {
    command: "tsx scripts/migrate.ts status",
    category: "db",
    supportsArgForwarding: true,
  },
  "migrate:up": {
    command: "tsx scripts/migrate.ts up",
    category: "db",
    supportsArgForwarding: true,
  },
  "migrate:down": {
    command: "tsx scripts/migrate.ts down",
    category: "db",
    supportsArgForwarding: true,
  },
  "migrate:verify": {
    command: "tsx scripts/migrate.ts verify",
    category: "db",
    supportsArgForwarding: true,
  },
});

export const REVIEWED_SCRIPT_NAMES: readonly string[] = Object.freeze(
  Object.keys(REVIEWED_PACKAGE_SCRIPTS),
);

export const DEFAULT_DOCUMENT_SOURCES: readonly string[] = Object.freeze([
  ".github/workflows/ci.yml",
  "CONTRIBUTING.md",
]);

export const ALLOWLISTED_SYSTEM_BINARIES: ReadonlySet<string> = new Set([
  "node",
  "npm",
  "cargo",
  "git",
  "rm",
]);

export type PackageScriptFindingCode =
  | "INVALID_PACKAGE_JSON"
  | "MISSING_SCRIPTS_FIELD"
  | "MISSING_REVIEWED_SCRIPT"
  | "UNREVIEWED_SCRIPT"
  | "REVIEWED_COMMAND_MISMATCH"
  | "EMPTY_COMMAND"
  | "MALFORMED_COMMAND"
  | "MISSING_TARGET_PATH"
  | "MISSING_BINARY"
  | "MISSING_NESTED_SCRIPT"
  | "ARG_FORWARDING_UNSUPPORTED"
  | "DOC_SCRIPT_MISSING";

export interface PackageScriptFinding {
  code: PackageScriptFindingCode;
  severity: "error";
  scriptName?: string;
  source?: string;
  message: string;
}

export interface DocumentScriptReference {
  source: string;
  scripts: string[];
}

export interface PackageScriptContractReport {
  ok: boolean;
  scriptCount: number;
  reviewedCount: number;
  checkedReferences: DocumentScriptReference[];
  findings: PackageScriptFinding[];
}

export interface ParsedSubcommand {
  envAssignments: string[];
  tokens: string[];
}

export interface TokenizedCommand {
  subcommands: ParsedSubcommand[];
  operators: string[];
}

export interface VerifyPackageScriptsOptions {
  /** Absolute repository root used when reading files or binaries from disk. */
  repoRoot?: string;
  /** Parsed `package.json` value; when omitted, read from `<repoRoot>/package.json`. */
  packageJson?: unknown;
  /** Reviewed script registry to enforce; defaults to `REVIEWED_PACKAGE_SCRIPTS`. */
  reviewedScripts?: Readonly<Record<string, ReviewedScriptSpec>>;
  /** Enforce reviewed membership (missing/unreviewed/command mismatch). Default: true. */
  strictReviewed?: boolean;
  /** Enforce exact command equality with `reviewedScripts`. Default: true. */
  verifyReviewedCommands?: boolean;
  /** Document contents keyed by repo-relative path (defaults to CI + CONTRIBUTING.md). */
  documents?: Readonly<Record<string, string>>;
  /** Optional filesystem existence override for unit tests. */
  existingPaths?: ReadonlySet<string>;
  /** Optional `node_modules/.bin` binary override for unit tests. */
  existingBinaries?: ReadonlySet<string>;
  /** Optional system binary override for unit tests. */
  systemBinaries?: ReadonlySet<string>;
}

const REPO_PATH_PREFIXES = [
  "scripts/",
  "agents/",
  "deploy/",
  "tests/",
  "fixtures/",
  "contracts-soroban/",
  "lib/",
  "schemas/",
  "docs/",
  "app/",
  "components/",
  "hooks/",
  "i18n/",
  "messages/",
  "examples/",
  "sdk/",
  "./",
];

const REPO_FILE_EXTENSIONS = /\.(ts|tsx|mjs|cjs|js|json|toml|ya?ml|sql|sh)$/i;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const NPM_RUN_REF_RE = /\bnpm\s+run\s+([a-zA-Z0-9][a-zA-Z0-9:._-]*)/g;
const NODE_VALUE_FLAGS = new Set([
  "--import",
  "--loader",
  "--experimental-loader",
  "--require",
  "-r",
  "--conditions",
  "-C",
  "--env-file",
  "--env-file-if-exists",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-name-pattern",
  "--test-shard",
]);
const TSX_VALUE_FLAGS = new Set([
  "--env-file",
  "--env-file-if-exists",
  "--tsconfig",
  "--import",
  "--conditions",
  "-C",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRelPath(target: string): string {
  return target.replace(/^\.\//, "");
}

function isLikelyRepoPath(token: string): boolean {
  if (!token || token.startsWith("-")) return false;
  if (REPO_PATH_PREFIXES.some((prefix) => token.startsWith(prefix))) return true;
  return REPO_FILE_EXTENSIONS.test(token);
}

/**
 * Tokenize a shell command string into chained subcommands (`&&`, `||`, `;`)
 * while rejecting unclosed quotes, dangling operators, empty subcommands, and
 * unreviewed shell redirections/pipes.
 */
export function tokenizeShellCommand(command: string): TokenizedCommand {
  if (typeof command !== "string") {
    throw new Error("command must be a string");
  }
  const trimmed = command.trim();
  if (trimmed === "") {
    throw new Error("command is empty");
  }

  const subcommands: ParsedSubcommand[] = [];
  const operators: string[] = [];

  let currentTokens: string[] = [];
  let tokenBuffer = "";
  let tokenActive = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flushToken = (): void => {
    if (!tokenActive) return;
    currentTokens.push(tokenBuffer);
    tokenBuffer = "";
    tokenActive = false;
  };

  const flushSubcommand = (operator: string | null): void => {
    flushToken();
    if (currentTokens.length === 0) {
      throw new Error(
        operator
          ? `empty subcommand before "${operator}"`
          : "trailing operator with no following command",
      );
    }
    const envAssignments: string[] = [];
    let index = 0;
    while (index < currentTokens.length && ENV_ASSIGNMENT_RE.test(currentTokens[index])) {
      envAssignments.push(currentTokens[index]);
      index += 1;
    }
    const tokens = currentTokens.slice(index);
    if (tokens.length === 0) {
      throw new Error("subcommand sets environment variables without an executable");
    }
    subcommands.push({ envAssignments, tokens });
    currentTokens = [];
    if (operator) operators.push(operator);
  };

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    const next = trimmed[i + 1];

    if (escaped) {
      tokenBuffer += ch;
      tokenActive = true;
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaped = true;
      tokenActive = true;
      continue;
    }

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        tokenBuffer += ch;
      }
      tokenActive = true;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      tokenActive = true;
      continue;
    }

    if (/\s/.test(ch)) {
      flushToken();
      continue;
    }

    if (ch === "&" && next === "&") {
      flushSubcommand("&&");
      i += 1;
      continue;
    }

    if (ch === "|" && next === "|") {
      flushSubcommand("||");
      i += 1;
      continue;
    }

    if (ch === ";") {
      flushSubcommand(";");
      continue;
    }

    if (ch === "|" || ch === "&" || ch === ">" || ch === "<" || ch === "`") {
      throw new Error(`unsupported shell operator "${ch}"`);
    }

    if (ch === "$" && next === "(") {
      throw new Error('unsupported command substitution "$("');
    }

    tokenBuffer += ch;
    tokenActive = true;
  }

  if (escaped) {
    throw new Error("dangling trailing escape character");
  }
  if (quote !== null) {
    throw new Error(`unclosed ${quote === "'" ? "single" : "double"} quote`);
  }

  flushSubcommand(null);

  return { subcommands, operators };
}

/**
 * Validate whether a script command safely forwards trailing arguments passed
 * via `npm run <script> -- <args...>`.
 */
export function validateArgumentForwarding(
  scriptName: string,
  command: string,
  supportsArgForwarding: boolean,
): PackageScriptFinding[] {
  if (!supportsArgForwarding) return [];

  let parsed: TokenizedCommand;
  try {
    parsed = tokenizeShellCommand(command);
  } catch {
    // Structural errors are already reported by command tokenization.
    return [];
  }

  const findings: PackageScriptFinding[] = [];
  if (parsed.subcommands.length !== 1 || parsed.operators.length > 0) {
    findings.push({
      code: "ARG_FORWARDING_UNSUPPORTED",
      severity: "error",
      scriptName,
      message: `script "${scriptName}" chains multiple commands and cannot reliably forward trailing CLI arguments`,
    });
    return findings;
  }

  const [{ tokens }] = parsed.subcommands;
  if (tokens[tokens.length - 1] === "--") {
    findings.push({
      code: "ARG_FORWARDING_UNSUPPORTED",
      severity: "error",
      scriptName,
      message: `script "${scriptName}" ends with "--", which swallows flag forwarding`,
    });
  }

  return findings;
}

/**
 * Simulate how `npm run <script> -- <forwardedArgs...>` composes the final
 * command tokens for single-command forwardable scripts.
 */
export function buildForwardedTokens(
  command: string,
  forwardedArgs: readonly string[],
): string[] {
  const parsed = tokenizeShellCommand(command);
  if (parsed.subcommands.length !== 1 || parsed.operators.length > 0) {
    throw new Error("cannot forward arguments to a chained shell command");
  }
  const [{ tokens }] = parsed.subcommands;
  return [...tokens, ...forwardedArgs];
}

/** Extract every `npm run <script>` name referenced in a markdown or workflow file. */
export function extractNpmScriptReferences(content: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of content.matchAll(NPM_RUN_REF_RE)) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }
  return ordered;
}

function createPathChecker(
  repoRoot: string,
  existingPaths?: ReadonlySet<string>,
): (relPath: string) => boolean {
  if (existingPaths) {
    return (relPath) => existingPaths.has(normalizeRelPath(relPath));
  }
  return (relPath) => existsSync(path.resolve(repoRoot, normalizeRelPath(relPath)));
}

function createBinaryChecker(
  repoRoot: string,
  existingBinaries?: ReadonlySet<string>,
  systemBinaries: ReadonlySet<string> = ALLOWLISTED_SYSTEM_BINARIES,
): (binName: string) => boolean {
  return (binName) => {
    if (systemBinaries.has(binName)) return true;
    if (existingBinaries) return existingBinaries.has(binName);
    const binDir = path.join(repoRoot, "node_modules", ".bin");
    return (
      existsSync(path.join(binDir, binName)) ||
      existsSync(path.join(binDir, `${binName}.cmd`))
    );
  };
}

function validateNodeOrTsxInvocation(
  scriptName: string,
  tokens: readonly string[],
  binary: "node" | "tsx",
  pathExists: (relPath: string) => boolean,
  binaryExists: (binName: string) => boolean,
): PackageScriptFinding[] {
  const findings: PackageScriptFinding[] = [];
  const valueFlags = binary === "node" ? NODE_VALUE_FLAGS : TSX_VALUE_FLAGS;
  const positional: string[] = [];

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      positional.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith("-")) {
      const [flagName, inlineValue] = token.split("=", 2);
      if (binary === "node" && (flagName === "--import" || flagName === "--loader" || flagName === "--experimental-loader")) {
        const loaderTarget = inlineValue ?? tokens[i + 1];
        if (!loaderTarget) {
          findings.push({
            code: "MALFORMED_COMMAND",
            severity: "error",
            scriptName,
            message: `script "${scriptName}" uses "${flagName}" without a module argument`,
          });
          return findings;
        }
        if (loaderTarget === "tsx" && !binaryExists("tsx")) {
          findings.push({
            code: "MISSING_BINARY",
            severity: "error",
            scriptName,
            message: `script "${scriptName}" requires "tsx" for "${flagName} tsx", but node_modules/.bin/tsx was not found`,
          });
        } else if (isLikelyRepoPath(loaderTarget) && !pathExists(loaderTarget)) {
          findings.push({
            code: "MISSING_TARGET_PATH",
            severity: "error",
            scriptName,
            message: `script "${scriptName}" loader path "${loaderTarget}" does not exist`,
          });
        }
        if (inlineValue === undefined) i += 1;
        continue;
      }

      if (inlineValue === undefined && valueFlags.has(flagName)) {
        if (i + 1 >= tokens.length) {
          findings.push({
            code: "MALFORMED_COMMAND",
            severity: "error",
            scriptName,
            message: `script "${scriptName}" uses flag "${flagName}" without a value`,
          });
          return findings;
        }
        i += 1;
      }
      continue;
    }

    positional.push(token);
  }

  if (positional.length === 0) {
    findings.push({
      code: "MALFORMED_COMMAND",
      severity: "error",
      scriptName,
      message: `script "${scriptName}" invokes "${binary}" without a target script path`,
    });
    return findings;
  }

  const entryScript = positional[0];
  if (!pathExists(entryScript)) {
    findings.push({
      code: "MISSING_TARGET_PATH",
      severity: "error",
      scriptName,
      message: `script "${scriptName}" target "${entryScript}" does not exist`,
    });
  }

  for (const extra of positional.slice(1)) {
    if (isLikelyRepoPath(extra) && !pathExists(extra)) {
      findings.push({
        code: "MISSING_TARGET_PATH",
        severity: "error",
        scriptName,
        message: `script "${scriptName}" target path "${extra}" does not exist`,
      });
    }
  }

  return findings;
}

function validateSubcommandTargets(
  scriptName: string,
  subcommand: ParsedSubcommand,
  allScripts: Readonly<Record<string, unknown>>,
  pathExists: (relPath: string) => boolean,
  binaryExists: (binName: string) => boolean,
): PackageScriptFinding[] {
  const findings: PackageScriptFinding[] = [];
  const { tokens } = subcommand;
  const executable = tokens[0];

  if (!binaryExists(executable)) {
    findings.push({
      code: "MISSING_BINARY",
      severity: "error",
      scriptName,
      message: `script "${scriptName}" executable "${executable}" does not exist in node_modules/.bin or allowlisted system tools`,
    });
    return findings;
  }

  if (executable === "node" || executable === "tsx") {
    findings.push(
      ...validateNodeOrTsxInvocation(scriptName, tokens, executable, pathExists, binaryExists),
    );
    return findings;
  }

  if (executable === "npm") {
    if (tokens[1] !== "run" || !tokens[2] || tokens[2].startsWith("-")) {
      findings.push({
        code: "MALFORMED_COMMAND",
        severity: "error",
        scriptName,
        message: `script "${scriptName}" must specify "npm run <script>"`,
      });
      return findings;
    }
    const targetScript = tokens[2];
    if (targetScript === scriptName || !(targetScript in allScripts)) {
      findings.push({
        code: "MISSING_NESTED_SCRIPT",
        severity: "error",
        scriptName,
        message:
          targetScript === scriptName
            ? `script "${scriptName}" recursively invokes itself`
            : `script "${scriptName}" invokes missing nested script "${targetScript}"`,
      });
    }
    return findings;
  }

  if (executable === "concurrently") {
    const npmRefs = tokens
      .slice(1)
      .map((t) => t.match(/^npm:([a-zA-Z0-9][a-zA-Z0-9:._-]*)$/)?.[1])
      .filter((name): name is string => Boolean(name));
    if (npmRefs.length === 0) {
      findings.push({
        code: "MALFORMED_COMMAND",
        severity: "error",
        scriptName,
        message: `script "${scriptName}" invokes concurrently without any "npm:<script>" targets`,
      });
      return findings;
    }
    for (const ref of npmRefs) {
      if (ref === scriptName || !(ref in allScripts)) {
        findings.push({
          code: "MISSING_NESTED_SCRIPT",
          severity: "error",
          scriptName,
          message:
            ref === scriptName
              ? `script "${scriptName}" recursively invokes itself`
              : `script "${scriptName}" references missing worker script "${ref}"`,
        });
      }
    }
    return findings;
  }

  if (executable === "cargo") {
    const manifestIdx = tokens.indexOf("--manifest-path");
    if (manifestIdx >= 0) {
      const manifestPath = tokens[manifestIdx + 1];
      if (!manifestPath || manifestPath.startsWith("-")) {
        findings.push({
          code: "MALFORMED_COMMAND",
          severity: "error",
          scriptName,
          message: `script "${scriptName}" uses "--manifest-path" without a file path`,
        });
      } else if (!pathExists(manifestPath)) {
        findings.push({
          code: "MISSING_TARGET_PATH",
          severity: "error",
          scriptName,
          message: `script "${scriptName}" Cargo manifest "${manifestPath}" does not exist`,
        });
      }
    }
    return findings;
  }

  if (executable === "rm") {
    const hasTarget = tokens.slice(1).some((token) => !token.startsWith("-"));
    if (!hasTarget) {
      findings.push({
        code: "MALFORMED_COMMAND",
        severity: "error",
        scriptName,
        message: `script "${scriptName}" invokes "rm" without a target path`,
      });
    }
    return findings;
  }

  for (const token of tokens.slice(1)) {
    if (isLikelyRepoPath(token) && !pathExists(token)) {
      findings.push({
        code: "MISSING_TARGET_PATH",
        severity: "error",
        scriptName,
        message: `script "${scriptName}" target path "${token}" does not exist`,
      });
    }
  }

  return findings;
}

function loadDefaultDocuments(repoRoot: string): Record<string, string> {
  const docs: Record<string, string> = {};
  for (const rel of DEFAULT_DOCUMENT_SOURCES) {
    const fullPath = path.resolve(repoRoot, rel);
    if (existsSync(fullPath)) {
      docs[rel] = readFileSync(fullPath, "utf8");
    }
  }
  return docs;
}

/**
 * Verify a `package.json` `"scripts"` map against the reviewed script contract,
 * local filesystem targets, binaries, argument forwarding rules, and CI /
 * contributor documentation references.
 */
export function verifyPackageScripts(
  options: VerifyPackageScriptsOptions = {},
): PackageScriptContractReport {
  const repoRoot = options.repoRoot ?? process.cwd();
  const reviewedScripts = options.reviewedScripts ?? REVIEWED_PACKAGE_SCRIPTS;
  const strictReviewed = options.strictReviewed ?? true;
  const verifyReviewedCommands = options.verifyReviewedCommands ?? true;
  const pathExists = createPathChecker(repoRoot, options.existingPaths);
  const binaryExists = createBinaryChecker(
    repoRoot,
    options.existingBinaries,
    options.systemBinaries,
  );

  const findings: PackageScriptFinding[] = [];
  const reviewedNames = Object.keys(reviewedScripts);

  let rawPkg = options.packageJson;
  if (rawPkg === undefined) {
    const pkgPath = path.join(repoRoot, "package.json");
    if (!existsSync(pkgPath)) {
      return {
        ok: false,
        scriptCount: 0,
        reviewedCount: reviewedNames.length,
        checkedReferences: [],
        findings: [
          {
            code: "INVALID_PACKAGE_JSON",
            severity: "error",
            message: "package.json is missing",
          },
        ],
      };
    }
    try {
      rawPkg = JSON.parse(readFileSync(pkgPath, "utf8")) as unknown;
    } catch (error) {
      return {
        ok: false,
        scriptCount: 0,
        reviewedCount: reviewedNames.length,
        checkedReferences: [],
        findings: [
          {
            code: "INVALID_PACKAGE_JSON",
            severity: "error",
            message: `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  if (!isPlainObject(rawPkg)) {
    return {
      ok: false,
      scriptCount: 0,
      reviewedCount: reviewedNames.length,
      checkedReferences: [],
      findings: [
        {
          code: "INVALID_PACKAGE_JSON",
          severity: "error",
          message: "package.json root must be a JSON object",
        },
      ],
    };
  }

  if (!isPlainObject(rawPkg.scripts)) {
    return {
      ok: false,
      scriptCount: 0,
      reviewedCount: reviewedNames.length,
      checkedReferences: [],
      findings: [
        {
          code: "MISSING_SCRIPTS_FIELD",
          severity: "error",
          message: 'package.json must contain a plain-object "scripts" map',
        },
      ],
    };
  }

  const scripts = rawPkg.scripts;
  const actualNames = Object.keys(scripts);

  if (strictReviewed) {
    for (const reviewedName of reviewedNames) {
      if (!(reviewedName in scripts)) {
        findings.push({
          code: "MISSING_REVIEWED_SCRIPT",
          severity: "error",
          scriptName: reviewedName,
          message: `package.json is missing reviewed script "${reviewedName}"`,
        });
      }
    }
    for (const actualName of actualNames) {
      if (!(actualName in reviewedScripts)) {
        findings.push({
          code: "UNREVIEWED_SCRIPT",
          severity: "error",
          scriptName: actualName,
          message: `package.json defines unreviewed script "${actualName}" not present in REVIEWED_PACKAGE_SCRIPTS`,
        });
      }
    }
  }

  for (const [scriptName, command] of Object.entries(scripts)) {
    if (typeof command !== "string") {
      findings.push({
        code: "MALFORMED_COMMAND",
        severity: "error",
        scriptName,
        message: `script "${scriptName}" command must be a string`,
      });
      continue;
    }
    if (command.trim() === "") {
      findings.push({
        code: "EMPTY_COMMAND",
        severity: "error",
        scriptName,
        message: `script "${scriptName}" command cannot be empty`,
      });
      continue;
    }

    const reviewed = reviewedScripts[scriptName];
    if (strictReviewed && verifyReviewedCommands && reviewed && command !== reviewed.command) {
      findings.push({
        code: "REVIEWED_COMMAND_MISMATCH",
        severity: "error",
        scriptName,
        message: `script "${scriptName}" command "${command}" differs from reviewed contract "${reviewed.command}"`,
      });
    }

    let parsed: TokenizedCommand;
    try {
      parsed = tokenizeShellCommand(command);
    } catch (error) {
      findings.push({
        code: "MALFORMED_COMMAND",
        severity: "error",
        scriptName,
        message: `script "${scriptName}" is malformed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    for (const subcommand of parsed.subcommands) {
      findings.push(
        ...validateSubcommandTargets(
          scriptName,
          subcommand,
          scripts,
          pathExists,
          binaryExists,
        ),
      );
    }

    if (reviewed) {
      findings.push(
        ...validateArgumentForwarding(
          scriptName,
          command,
          reviewed.supportsArgForwarding,
        ),
      );
    }
  }

  const documents = options.documents ?? loadDefaultDocuments(repoRoot);
  const checkedReferences: DocumentScriptReference[] = [];
  for (const [source, content] of Object.entries(documents)) {
    const referenced = extractNpmScriptReferences(content);
    checkedReferences.push({ source, scripts: referenced });
    for (const refName of referenced) {
      if (!(refName in scripts)) {
        findings.push({
          code: "DOC_SCRIPT_MISSING",
          severity: "error",
          scriptName: refName,
          source,
          message: `${source} references "npm run ${refName}", which is missing from package.json`,
        });
      }
    }
  }

  return {
    ok: findings.length === 0,
    scriptCount: actualNames.length,
    reviewedCount: reviewedNames.length,
    checkedReferences,
    findings,
  };
}

/** Verify the repository's live `package.json`, CI workflow, and `CONTRIBUTING.md`. */
export function verifyRepoPackageScripts(
  repoRoot: string = process.cwd(),
): PackageScriptContractReport {
  return verifyPackageScripts({ repoRoot });
}

/** Render a concise human-readable verification report. */
export function formatPackageScriptReport(
  report: PackageScriptContractReport,
): string {
  const lines: string[] = [];
  lines.push(
    `package script contract: ${report.ok ? "PASS" : "FAILED"} ` +
      `(${report.scriptCount} scripts, ${report.reviewedCount} reviewed, ${report.findings.length} finding(s))`,
  );
  for (const ref of report.checkedReferences) {
    lines.push(`  · checked ${ref.scripts.length} reference(s) in ${ref.source}`);
  }
  for (const finding of report.findings) {
    lines.push(`  ✗ ${finding.code}: ${finding.message}`);
  }
  return lines.join("\n");
}
