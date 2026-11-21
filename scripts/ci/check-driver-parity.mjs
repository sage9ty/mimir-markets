#!/usr/bin/env node
/**
 * Guards the two implementations of the CI path classification from drifting:
 * `lib/ci/path-scope.ts` (TypeScript, under test) and
 * `scripts/ci/changed-paths.mjs` (plain Node, drives the workflow).
 *
 * The contract is fail-closed path filtering: a path either maps to a known
 * tier or it is UNKNOWN and the path job fails. If either side silently gains
 * or loses a scope, one of the checks below fails — the suites would otherwise
 * be selected by two different rules and a green check could mean different
 * things depending on which file answered.
 *
 * Both sides classify the same corpus through their own public surface and the
 * verdicts are compared as JSON. The corpus deliberately includes near-misses
 * (`appx/`, `docs2/`, `github/`) and unclassifiable paths: those must stay
 * `unknown` on BOTH sides or the filter has started to fail open.
 *
 * Run: npm run check:driver-parity
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const driverPath = path.join(root, "scripts", "ci", "changed-paths.mjs");

// Paths both implementations must agree on. Order matters only for readability.
const corpus = [
  "app/api/claims/route.ts",
  "components/MarketCard.tsx",
  "hooks/useClaimFeed.ts",
  "i18n/request.ts",
  "messages/en.json",
  "public/mimir-logo-preview.png",
  "examples/demo-full-cycle.ts",
  "sdk/index.ts",
  "proxy.ts",
  "tsconfig.json",
  "next.config.js",
  "tailwind.config.ts",
  "postcss.config.js",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "agents/oracle/index.ts",
  "agents/council/index.ts",
  "deploy/deploy.ts",
  "lib/ci/path-scope.ts",
  "lib/fees.ts",
  "lib/server/settlement-index.ts",
  "contracts-soroban/mimir-market/src/lib.rs",
  "contracts-soroban/mimir-squad/Cargo.toml",
  "tests/node/ci-path-scope.test.ts",
  "scripts/ci/changed-paths.mjs",
  ".github/workflows/ci.yml",
  ".env.example",
  ".nvmrc",
  ".gitattributes",
  ".gitignore",
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "docs/STELLAR_NETWORK.md",
  // Fail-closed probes: no side may classify these as scoped or doc.
  "brand-new-dir/file.ts",
  "appx/file.ts",
  "docs2/x.md",
  "github/workflows/ci.yml",
  "new-root-config.json",
  ".new-dotfile",
  "mystery/thing.txt",
];

function verdictOf(scope, tiers) {
  if (scope === "doc") return "doc";
  if (scope === undefined || scope === null) return "unknown";
  return [...tiers].sort();
}

// ── TS side: classify the corpus inside a tsx child ───────────────────────────

const tsRaw = (() => {
  const script = [
    "import { scopeOf } from './lib/ci/path-scope.ts';",
    `const corpus = ${JSON.stringify(corpus)};`,
    "const verdicts = {};",
    "for (const p of corpus) {",
    "  const s = scopeOf(p);",
    "  verdicts[p] = s.kind === 'scoped' ? [...s.tiers].sort() : s.kind;",
    "}",
    "console.log(JSON.stringify(verdicts));",
  ].join("\n");
  try {
    return execFileSync(
      process.execPath,
      ["--import", "tsx", "--eval", script],
      { cwd: root, encoding: "utf8" },
    );
  } catch (err) {
    console.error("check-driver-parity: could not classify via lib/ci/path-scope.ts (tsx)");
    console.error(err.stderr || err.message);
    process.exit(1);
  }
})();

const tsVerdicts = JSON.parse(tsRaw);

// ── Driver side: classify the corpus through its exported scope function ──────

const driver = await import(driverPath);
const driverVerdicts = {};
for (const p of corpus) {
  const scope = driver.scopesForPath(p);
  driverVerdicts[p] = verdictOf(scope, scope);
}

// ── Compare ───────────────────────────────────────────────────────────────────

let failures = 0;
for (const p of corpus) {
  if (JSON.stringify(tsVerdicts[p]) !== JSON.stringify(driverVerdicts[p])) {
    console.error(`✗ ${p}\n    path-scope.ts:      ${JSON.stringify(tsVerdicts[p])}\n    changed-paths.mjs:  ${JSON.stringify(driverVerdicts[p])}`);
    failures++;
  }
}

// The fail-closed probes must be unknown on the TS side too — if they ever
// classify, the allowlist has grown without a reviewed decision.
for (const p of ["brand-new-dir/file.ts", "appx/file.ts", "docs2/x.md", "github/workflows/ci.yml", "new-root-config.json", ".new-dotfile", "mystery/thing.txt"]) {
  if (tsVerdicts[p] !== "unknown") {
    console.error(`✗ ${p} is ${JSON.stringify(tsVerdicts[p])} in path-scope.ts but must stay unknown (fail closed)`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\ncheck-driver-parity: ${failures} divergence(s) between the CI driver and the tested module.`);
  process.exit(1);
}

console.log(`✓ changed-paths.mjs matches path-scope.ts (${corpus.length} path probes)`);
