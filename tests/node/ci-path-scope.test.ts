/**
 * Pins the fail-closed contract of `lib/ci/path-scope.ts`.
 *
 * The one property that matters: a changed path either maps to a known tier or
 * it is UNKNOWN, and UNKNOWN never silently enables nothing. Every test here
 * guards a way the filter could regress into failing open — a new directory
 * nobody classified, a root file that skips the suites it affects, a doc file
 * treated as scoped, or a fan-out file that stops fanning out.
 *
 * Keep in sync with `scripts/ci/changed-paths.mjs` (checked by
 * `npm run check:driver-parity`, not by this file).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  allTiers,
  scopeOf,
  scopesForPaths,
} from "../../lib/ci/path-scope";

const TIERS = ["app", "agents", "contracts", "tests"] as const;

function tiersOf(...paths: string[]): string[] {
  const scope = scopesForPaths(paths);
  assert.equal(scope.kind, "scoped", `expected ${JSON.stringify(paths)} to be scoped`);
  return [...scope.tiers].sort();
}

// Tier lists come back sorted; use this for whole-tier expectations.
const ALL_TIERS_SORTED = [...TIERS].sort();

function isUnknown(...paths: string[]): boolean {
  return scopesForPaths(paths).kind === "unknown";
}

test("every tier prefix classifies into exactly its own tier", () => {
  const byTier: Record<string, string[]> = {
    app: ["app/api/x.ts", "components/ui/Button.tsx", "hooks/usePools.ts", "i18n/locale.ts", "messages/en.json", "public/logo.svg", "examples/demo.ts", "sdk/index.ts"],
    agents: ["agents/oracle/index.ts", "deploy/deploy.ts"],
    contracts: ["contracts-soroban/mimir-market/src/lib.rs"],
    tests: ["tests/node/ci-path-scope.test.ts", "scripts/ci/changed-paths.mjs", ".github/workflows/ci.yml"],
  };
  for (const [tier, paths] of Object.entries(byTier)) {
    for (const p of paths) {
      const scope = scopeOf(p);
      assert.equal(scope.kind, "scoped", `${p} must be scoped`);
      if (scope.kind === "scoped") {
        assert.deepEqual([...scope.tiers], [tier], `${p} must scope to ${tier} only`);
      }
    }
  }
  // proxy.ts is deliberately claimed by both the app and agents tiers: it is
  // loaded by both the Next.js server and the worker entry points.
  assert.deepEqual(tiersOf("proxy.ts"), ["agents", "app"]);
});

test("shared lib/ code fans out to the three Node tiers", () => {
  // lib/ is imported by the Next.js server, the workers and the node tests
  // alike; contracts shares nothing with it and keeps its own toolchain.
  for (const p of ["lib/ci/path-scope.ts", "lib/fees.ts", "lib/server/settlement-index.ts", "lib/x402/stellar-scheme.ts"]) {
    assert.deepEqual(tiersOf(p), ["agents", "app", "tests"], `${p} must enable app, agents and tests`);
  }
});

test("shared files fan out to every tier", () => {
  for (const shared of [".env.example", ".nvmrc", ".gitattributes", ".gitignore"]) {
    assert.deepEqual(tiersOf(shared), ALL_TIERS_SORTED, `${shared} must enable all tiers`);
    // Even alongside doc-only changes, the shared file keeps everything on.
    assert.deepEqual(tiersOf(shared, "README.md", "docs/note.md"), ALL_TIERS_SORTED);
  }
});

test("root manifests fan out to every tier that claims them", () => {
  // The contracts tier has its own toolchain (Cargo), so it does not claim the
  // root manifests — but the three Node tiers all do.
  for (const file of ["package.json", "package-lock.json", "npm-shrinkwrap.json"]) {
    assert.deepEqual(tiersOf(file), ["agents", "app", "tests"], `${file} must enable app, agents and tests`);
  }
  // tsconfig.json is claimed by app and agents only.
  assert.deepEqual(tiersOf("tsconfig.json"), ["agents", "app"]);
});

test("doc-only changes enable nothing but never fail the path job", () => {
  for (const doc of ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE", "docs/STELLAR_NETWORK.md", "docs/ops/runbook.md"]) {
    const scope = scopesForPaths([doc]);
    assert.equal(scope.kind, "doc", `${doc} must classify as doc`);
  }
  // A doc change mixed into a scoped change must not widen the scope…
  assert.deepEqual(tiersOf("README.md", "app/api/x.ts"), ["app"]);
  // …and a purely doc-only change set is `doc`, not `unknown`.
  assert.equal(isUnknown("README.md", "LICENSE"), false);
});

test("unclassified paths are UNKNOWN — the fail-closed core", () => {
  // A brand-new top-level directory is exactly the change a filter forgets.
  assert.equal(isUnknown("brand-new-dir/file.ts"), true);
  // A brand-new root config (a manifest, a script, an env file) can alter how
  // every tier builds and runs, so root-level entries are strictest.
  assert.equal(isUnknown("new-root-config.json"), true);
  assert.equal(isUnknown("new-root-script.mjs"), true);
  // A new dotfile at the root is not exempt either.
  assert.equal(isUnknown(".new-dotfile"), true);
  // Unknown propagates across the whole change set, even next to scoped paths.
  assert.equal(isUnknown("app/api/x.ts", "mystery/thing.txt"), true);
});

test("near-miss paths do not ride a prefix they merely resemble", () => {
  // Not a prefix match: `appx/` must not count as `app/`.
  assert.equal(isUnknown("appx/file.ts"), true);
  // `docs2/` is not `docs/`; `github/` is not `.github/`.
  assert.equal(isUnknown("docs2/x.md"), true);
  assert.equal(isUnknown("github/workflows/ci.yml"), true);
  // Directory-like entries keep their classification; only unknowns trip it.
  assert.equal(isUnknown("tests/"), false);
});

test("allTiers matches the matrix the workflow builds from", () => {
  assert.deepEqual([...allTiers()].sort(), ALL_TIERS_SORTED);
});

test("empty and doc-only sets are not unknown", () => {
  // scopesForPaths of nothing is `doc` (nothing to run), never `unknown`.
  const empty = scopesForPaths([]);
  assert.equal(empty.kind, "doc");
});
