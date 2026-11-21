#!/usr/bin/env node
/**
 * Fail-closed changed-path detection for CI.
 *
 * Contract (see `lib/ci/path-scope.ts` for the tested version of these rules):
 *   - CI decides what to run from an allowlist. A path either matches a known
 *     scope or it is UNKNOWN. Unknown paths FAIL this script — they never
 *     silently skip the suites they were invisible to.
 *   - Docs are the only thing that enables nothing (and still emit outputs).
 *   - Any failure to *determine* the change set (no event payload, no git
 *     merge-base, missing tool) also fails closed: every tier runs and
 *     unknown=1 is reported.
 *
 * Usage: node scripts/ci/changed-paths.mjs [--base <ref>] [--base-repo <url>]
 *   - PR context: the workflow passes the trigger's head/base refs and the
 *     event payload path; this script resolves them against git and emits
 *     GITHUB_OUTPUT lines for the matrix.
 *   - Local: `node scripts/ci/changed-paths.mjs --base <ref>` to test.
 *   - No base resolvable: fail closed (all tiers, unknown=1), exit 1.
 *
 * Keep in sync with `lib/ci/path-scope.ts` (same lists, same rules) — the node
 * tests pin the TS side and `check:driver-parity` pins the lists.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Classification lists — keep in sync with lib/ci/path-scope.ts ─────────────

const PREFIX_SCOPES = [
  ["app/", "app"],
  ["components/", "app"],
  ["hooks/", "app"],
  ["i18n/", "app"],
  ["messages/", "app"],
  ["public/", "app"],
  ["examples/", "app"],
  ["sdk/", "app"],

  // Shared code: imported by the Next.js server, the workers and the node
  // tests alike, so a change here enables all three Node tiers (contracts has
  // its own Rust toolchain and shares nothing with lib/).

  ["lib/", "app"],
  ["lib/", "agents"],
  ["lib/", "tests"],

  ["agents/", "agents"],
  ["deploy/", "agents"],

  ["contracts-soroban/", "contracts"],

  ["tests/", "tests"],
  ["scripts/", "tests"],
  // Replay and contract fixtures are read by node tests and release readiness.
  ["fixtures/", "tests"],
  [".github/", "tests"],
];

const FILE_SCOPES = [
  ["proxy.ts", "app"],

  ["tsconfig.json", "app"],
  ["next.config.js", "app"],
  ["tailwind.config.ts", "app"],
  ["postcss.config.js", "app"],

  ["package.json", "app"],
  ["package-lock.json", "app"],
  ["npm-shrinkwrap.json", "app"],

  ["tsconfig.json", "agents"],
  ["package.json", "agents"],
  ["package-lock.json", "agents"],
  ["npm-shrinkwrap.json", "agents"],

  ["package.json", "tests"],
  ["package-lock.json", "tests"],
  ["npm-shrinkwrap.json", "tests"],

  ["proxy.ts", "agents"],
];

const SHARED_FILES = new Set([
  ".env.example",
  ".nvmrc",
  ".gitattributes",
  ".gitignore",
]);

const DOC_ONLY = new Set(["LICENSE", "README.md", "CHANGELOG.md", "CONTRIBUTING.md"]);

const DOC_ONLY_PREFIXES = ["docs/"];

const ALL_TIERS = ["app", "agents", "contracts", "tests"];

// Test hook: parity and classification tests import these directly.
export { PREFIX_SCOPES, FILE_SCOPES, SHARED_FILES, DOC_ONLY, DOC_ONLY_PREFIXES, ALL_TIERS, classify, scopesForPath };

// ── Classification — mirrors scopeOf/scopesForPaths in path-scope.ts ─────────

function scopesForPath(p) {
  if (SHARED_FILES.has(p)) return new Set(ALL_TIERS);
  const isRootLevel = !p.includes("/");
  if (isRootLevel && DOC_ONLY.has(p)) return "doc";
  for (const prefix of DOC_ONLY_PREFIXES) {
    if (p.startsWith(prefix)) return "doc";
  }
  const tiers = new Set();
  for (const [prefix, tier] of PREFIX_SCOPES) {
    if (p.startsWith(prefix)) tiers.add(tier);
  }
  for (const [file, tier] of FILE_SCOPES) {
    if (p === file) tiers.add(tier);
  }
  return tiers.size > 0 ? tiers : undefined;
}

/**
 * Classify the whole change set.
 * Returns { tiers: string[] } | { doc: true } | { unknown: true, path?: string }.
 */
function classify(paths) {
  const tiers = new Set();
  for (const p of paths) {
    const scope = scopesForPath(p);
    if (scope === undefined) return { unknown: true, path: p };
    if (scope === "doc") continue;
    for (const t of scope) tiers.add(t);
  }
  if (tiers.size === 0) return { doc: true };
  return { tiers: ALL_TIERS.filter((t) => tiers.has(t)) };
}

// ── Git plumbing ──────────────────────────────────────────────────────────────

function git(args, { allowFailure = false } = {}) {
  const res = execFileSync("git", args, { cwd: root, encoding: "utf8" });
  return res;
}

function gitMayFail(args) {
  try {
    return { ok: true, out: git(args) };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Ensure both ends of a range exist locally; fetch just what is missing. */
function ensureCommits(shaA, shaB, baseRepo) {
  const missing = [shaA, shaB].filter(
    (sha) => !gitMayFail(["cat-file", "-e", `${sha}^{commit}`]).ok,
  );
  if (missing.length === 0) return;
  const source = baseRepo || "origin";
  // Minimal, scoped fetch: only the missing commit SHAs from the base repo.
  git(["fetch", "--no-tags", "--depth=1", source, ...missing]);
}

function mergeBaseOf(shaA, shaB) {
  const res = gitMayFail(["merge-base", shaA, shaB]);
  if (!res.ok) return undefined;
  return res.out.trim() || undefined;
}

function changedFilesBetween(fromExclusive, toInclusive) {
  // -z: NUL-delimited, so filenames containing newlines cannot split records.
  const out = git(["diff", "--name-only", "-z", `${fromExclusive}..${toInclusive}`]);
  return out.split("\0").filter(Boolean);
}

function headSha() {
  const res = gitMayFail(["rev-parse", "HEAD"]);
  return res.ok ? res.out.trim() : undefined;
}

function commitShaOf(ref) {
  const res = gitMayFail(["rev-parse", "--verify", `${ref}^{commit}`]);
  return res.ok ? res.out.trim() : undefined;
}

// ── Base resolution ───────────────────────────────────────────────────────────

/**
 * Resolve the merge-base commit for the change set. Returns
 * { base, baseRepo, baseRef } or undefined when nothing can be resolved —
 * the caller then fails closed.
 */
function resolveBase({ baseRef, baseRepo }) {
  const head = headSha();
  if (!head) return undefined;

  // Explicit --base wins (local testing, and the workflow's direct-push path).
  if (baseRef) {
    const sha = commitShaOf(baseRef);
    if (!sha) return undefined;
    return { base: sha, baseRepo, baseRef };
  }

  // PR context: the workflow hands us the event payload. Read the base SHA
  // from the trigger that actually ran instead of re-deriving it from branch
  // names, which forks and force-pushes invalidate.
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8"));
      const pr = event.pull_request;
      if (pr?.base?.sha) {
        return { base: pr.base.sha, baseRepo: pr.base.repo?.clone_url, baseRef: pr.base.ref };
      }
    } catch {
      // fall through to fail-closed
    }
  }

  return undefined;
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Only drive the workflow when executed directly. When imported (parity checks,
// classification tests) the lists and classify() above are the surface.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

export function main() {
  const argv = process.argv.slice(2);
  let baseRef;
  let baseRepo;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") baseRef = argv[++i];
    else if (argv[i] === "--base-repo") baseRepo = argv[++i];
  }

  const outputs = {};
  let exitCode = 0;

  const resolved = resolveBase({ baseRef, baseRepo });
  let result;

  if (!resolved) {
    // Fail closed: the change set cannot be determined, so run everything.
    console.error(
      "changed-paths: could not resolve a base commit; failing closed (all tiers, unknown=1)",
    );
    result = { tiers: ALL_TIERS };
    outputs.unknown = 1;
    exitCode = 1;
  } else {
    const head = headSha();
    try {
      ensureCommits(resolved.base, head, resolved.baseRepo);
    } catch (err) {
      console.error(`changed-paths: fetch failed (${err.message}); failing closed`);
      result = { tiers: ALL_TIERS };
      outputs.unknown = 1;
      exitCode = 1;
    }

    if (!result) {
      const base = mergeBaseOf(resolved.base, head);
      if (!base) {
        console.error("changed-paths: git merge-base failed; failing closed");
        result = { tiers: ALL_TIERS };
        outputs.unknown = 1;
        exitCode = 1;
      } else {
        const files = changedFilesBetween(base, head);
        outputs.base = base;
        if (resolved.baseRepo) outputs.base_repo = resolved.baseRepo;
        if (resolved.baseRef) outputs.base_repo_ref = resolved.baseRef;
        result = classify(files);
        if (result.unknown) {
          console.error(
            `changed-paths: unclassifiable path '${result.path}' — failing closed (all tiers)`,
          );
          outputs.unknown = 1;
          exitCode = 1;
          result = { tiers: ALL_TIERS };
        } else if (result.doc) {
          console.log("changed-paths: doc-only change; no tier suites enabled");
        } else {
          console.log(`changed-paths: tiers = ${result.tiers.join(" ")}`);
        }
      }
    }
  }

  outputs.tiers = (result.tiers ?? []).join(" ");
  // JSON-array form for the workflow matrix (`fromJSON`), empty array when
  // doc-only so the suites job can be skipped outright.
  outputs.tiers_json = JSON.stringify(result.tiers ?? []);
  writeOutputs(outputs);
  console.log(
    `changed-paths: tiers="${outputs.tiers}" unknown=${outputs.unknown ?? 0}`,
  );
  process.exit(exitCode);
}

// GITHUB_OUTPUT is the documented multi-line-safe file interface; append
// key=value pairs so the workflow can consume them via steps.<id>.outputs.
function writeOutputs(map) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  appendFileSync(file, `${lines}\n`);
}
