import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALLOWLISTED_SYSTEM_BINARIES,
  REVIEWED_PACKAGE_SCRIPTS,
  REVIEWED_SCRIPT_NAMES,
  buildForwardedTokens,
  extractNpmScriptReferences,
  formatPackageScriptReport,
  tokenizeShellCommand,
  validateArgumentForwarding,
  verifyPackageScripts,
  verifyRepoPackageScripts,
} from "../../lib/ops/package-script-contract";

const REPO_ROOT = process.cwd();
const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";

function readRepoPackageJson(): { scripts: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
}

// ── Positive repository verification ─────────────────────────────────────────

test("positive: every restored script in package.json resolves against real files and binaries", () => {
  const report = verifyRepoPackageScripts(REPO_ROOT);
  assert.equal(report.ok, true, formatPackageScriptReport(report));
  assert.deepEqual(report.findings, []);
  assert.equal(report.scriptCount, REVIEWED_SCRIPT_NAMES.length);
  assert.equal(report.reviewedCount, REVIEWED_SCRIPT_NAMES.length);

  const pkg = readRepoPackageJson();
  assert.deepEqual(Object.keys(pkg.scripts).sort(), [...REVIEWED_SCRIPT_NAMES].sort());
});

test("positive: every npm run script referenced in ci.yml and CONTRIBUTING.md exists in package.json", () => {
  const pkg = readRepoPackageJson();
  const ciYaml = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const contributing = readFileSync(path.join(REPO_ROOT, "CONTRIBUTING.md"), "utf8");

  const ciRefs = extractNpmScriptReferences(ciYaml);
  const contributingRefs = extractNpmScriptReferences(contributing);

  assert.ok(ciRefs.length >= 15, `expected CI references, found ${ciRefs.length}`);
  assert.ok(
    contributingRefs.length >= 10,
    `expected CONTRIBUTING.md references, found ${contributingRefs.length}`,
  );

  for (const name of [...ciRefs, ...contributingRefs]) {
    assert.ok(name in pkg.scripts, `referenced script "${name}" missing from package.json`);
  }
});

test("positive: formatPackageScriptReport summarizes pass and checked references", () => {
  const report = verifyRepoPackageScripts(REPO_ROOT);
  const formatted = formatPackageScriptReport(report);
  assert.match(formatted, /package script contract: PASS/);
  assert.match(formatted, /\.github\/workflows\/ci\.yml/);
  assert.match(formatted, /CONTRIBUTING\.md/);
});

// ── Argument forwarding preservation ─────────────────────────────────────────

test("positive: buildForwardedTokens preserves flags, paths, and double-dash passthrough", () => {
  assert.deepEqual(
    buildForwardedTokens(REVIEWED_PACKAGE_SCRIPTS["verify:cache-backup"].command, [
      "tests/fixtures/cache-backup/valid.json",
    ]),
    [
      "node",
      "--import",
      "tsx",
      "scripts/verify-cache-backup.ts",
      "tests/fixtures/cache-backup/valid.json",
    ],
  );

  assert.deepEqual(
    buildForwardedTokens(REVIEWED_PACKAGE_SCRIPTS["check:openapi"].command, ["--write"]),
    ["tsx", "scripts/generate-agent-openapi.ts", "--write"],
  );

  assert.deepEqual(
    buildForwardedTokens(REVIEWED_PACKAGE_SCRIPTS["migrate:status"].command, ["--live"]),
    ["tsx", "scripts/migrate.ts", "status", "--live"],
  );

  assert.deepEqual(
    buildForwardedTokens(REVIEWED_PACKAGE_SCRIPTS["smoke:browser"].command, [
      "--skip-build",
      "--",
      "--update-snapshots",
    ]),
    ["node", "scripts/run-browser-smoke.mjs", "--skip-build", "--", "--update-snapshots"],
  );
});

test("positive: npm run forwards arguments cleanly in real subprocess invocations", () => {
  const cacheVerify = spawnSync(
    NPM_BIN,
    ["run", "--silent", "verify:cache-backup", "--", "tests/fixtures/cache-backup/valid.json"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(cacheVerify.status, 0, cacheVerify.stderr || cacheVerify.stdout);
  assert.match(cacheVerify.stdout, /cache backup: OK/);

  const scriptVerify = spawnSync(
    NPM_BIN,
    ["run", "--silent", "verify:package-scripts", "--", "--json"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(scriptVerify.status, 0, scriptVerify.stderr || scriptVerify.stdout);
  const parsed = JSON.parse(scriptVerify.stdout) as { ok: boolean; scriptCount: number };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.scriptCount, REVIEWED_SCRIPT_NAMES.length);
});

test("positive: npm run preserves -- --write forwarding end to end in an isolated fixture", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mimir-npm-forward-"));
  try {
    writeFileSync(
      path.join(dir, "echo-args.mjs"),
      "console.log(JSON.stringify(process.argv.slice(2)));\n",
      "utf8",
    );
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "forward-fixture",
        version: "0.0.0",
        scripts: {
          "check:fixture": "node echo-args.mjs",
        },
      }),
      "utf8",
    );

    const run = spawnSync(
      NPM_BIN,
      ["run", "--silent", "check:fixture", "--", "--write", "--mode=release"],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.deepEqual(JSON.parse(run.stdout), ["--write", "--mode=release"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Boundary & failure modes ─────────────────────────────────────────────────

test("failure: missing target file, fixture, manifest, or binary fails closed", () => {
  const report = verifyPackageScripts({
    packageJson: {
      scripts: {
        badNode: "node scripts/does-not-exist.mjs",
        badTsx: "tsx --env-file-if-exists=.env.local agents/missing-agent/index.ts",
        badFixture: "tsx scripts/replay-ledger-fixture.ts fixtures/ledger/missing.json",
        badCargo: "cargo test --manifest-path contracts-soroban/Missing.toml",
        badBinary: "nonexistent-cli --check",
        badNested: "npm run ghost-script",
        selfCycle: "npm run selfCycle",
        badWorkers: 'concurrently "npm:badNode" "npm:missingWorker"',
      },
    },
    strictReviewed: false,
    documents: {},
    existingPaths: new Set(["scripts/replay-ledger-fixture.ts"]),
    existingBinaries: new Set(["tsx", "concurrently"]),
    systemBinaries: ALLOWLISTED_SYSTEM_BINARIES,
  });

  assert.equal(report.ok, false);
  const codes = new Map(report.findings.map((f) => [`${f.scriptName}:${f.code}`, f]));
  assert.ok(codes.has("badNode:MISSING_TARGET_PATH"));
  assert.ok(codes.has("badTsx:MISSING_TARGET_PATH"));
  assert.ok(codes.has("badFixture:MISSING_TARGET_PATH"));
  assert.ok(codes.has("badCargo:MISSING_TARGET_PATH"));
  assert.ok(codes.has("badBinary:MISSING_BINARY"));
  assert.ok(codes.has("badNested:MISSING_NESTED_SCRIPT"));
  assert.ok(codes.has("selfCycle:MISSING_NESTED_SCRIPT"));
  assert.ok(codes.has("badWorkers:MISSING_NESTED_SCRIPT"));
});

test("failure: malformed, empty, and non-string commands are rejected", () => {
  assert.throws(() => tokenizeShellCommand(""), /empty/);
  assert.throws(() => tokenizeShellCommand('node "unclosed.mjs'), /unclosed double quote/);
  assert.throws(() => tokenizeShellCommand("node scripts/a.mjs &&"), /trailing operator/);
  assert.throws(() => tokenizeShellCommand("&& node scripts/a.mjs"), /empty subcommand/);
  assert.throws(() => tokenizeShellCommand("AUTO_CHALLENGE=1"), /without an executable/);
  assert.throws(() => tokenizeShellCommand("node scripts/a.mjs | cat"), /unsupported shell operator/);

  const report = verifyPackageScripts({
    packageJson: {
      scripts: {
        emptyCmd: "   ",
        nonString: 42,
        unclosedQuote: 'tsx "scripts/check-schema-snapshot.ts',
        danglingAnd: "node scripts/check-forbidden-terms.mjs &&",
        missingTargetAfterNode: "node --import tsx",
      },
    },
    strictReviewed: false,
    documents: {},
    existingPaths: new Set(["scripts/check-forbidden-terms.mjs"]),
    existingBinaries: new Set(["tsx"]),
    systemBinaries: ALLOWLISTED_SYSTEM_BINARIES,
  });

  assert.equal(report.ok, false);
  assert.equal(
    report.findings.find((f) => f.scriptName === "emptyCmd")?.code,
    "EMPTY_COMMAND",
  );
  assert.equal(
    report.findings.find((f) => f.scriptName === "nonString")?.code,
    "MALFORMED_COMMAND",
  );
  assert.equal(
    report.findings.find((f) => f.scriptName === "unclosedQuote")?.code,
    "MALFORMED_COMMAND",
  );
  assert.equal(
    report.findings.find((f) => f.scriptName === "danglingAnd")?.code,
    "MALFORMED_COMMAND",
  );
  assert.equal(
    report.findings.find((f) => f.scriptName === "missingTargetAfterNode")?.code,
    "MALFORMED_COMMAND",
  );
});

test("failure: invalid package.json shape fails closed", () => {
  const notObject = verifyPackageScripts({ packageJson: null, documents: {} });
  assert.equal(notObject.ok, false);
  assert.equal(notObject.findings[0]?.code, "INVALID_PACKAGE_JSON");

  const missingScripts = verifyPackageScripts({
    packageJson: { name: "mimir" },
    documents: {},
  });
  assert.equal(missingScripts.ok, false);
  assert.equal(missingScripts.findings[0]?.code, "MISSING_SCRIPTS_FIELD");
});

test("failure: unreviewed extra script, missing reviewed script, and command mismatch fail closed", () => {
  const pkg = readRepoPackageJson();
  const mutatedScripts: Record<string, string> = { ...pkg.scripts };
  delete mutatedScripts["verify:release-readiness"];
  mutatedScripts["check:terms"] = "node scripts/check-locale-completeness.mjs";
  mutatedScripts["unreviewed:rogue"] = "node scripts/check-forbidden-terms.mjs";

  const report = verifyPackageScripts({
    repoRoot: REPO_ROOT,
    packageJson: { scripts: mutatedScripts },
    documents: {},
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.findings.some(
      (f) =>
        f.code === "MISSING_REVIEWED_SCRIPT" &&
        f.scriptName === "verify:release-readiness",
    ),
  );
  assert.ok(
    report.findings.some(
      (f) => f.code === "UNREVIEWED_SCRIPT" && f.scriptName === "unreviewed:rogue",
    ),
  );
  assert.ok(
    report.findings.some(
      (f) => f.code === "REVIEWED_COMMAND_MISMATCH" && f.scriptName === "check:terms",
    ),
  );
});

test("failure: documentation and CI references to missing scripts fail closed", () => {
  assert.deepEqual(
    extractNpmScriptReferences(
      "Run `npm run <script>` or `npm run check:openapi -- --write` and `npm run verify:cache-backup`.",
    ),
    ["check:openapi", "verify:cache-backup"],
  );

  const report = verifyPackageScripts({
    packageJson: {
      scripts: {
        typecheck: "tsc --noEmit",
      },
    },
    strictReviewed: false,
    existingBinaries: new Set(["tsc"]),
    documents: {
      ".github/workflows/ci.yml": "run: npm run typecheck\nrun: npm run missing:ci-gate\n",
      "CONTRIBUTING.md": "```bash\nnpm run missing:doc-cmd -- --flag\n```",
    },
  });

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.findings.map((f) => ({ code: f.code, scriptName: f.scriptName, source: f.source })),
    [
      {
        code: "DOC_SCRIPT_MISSING",
        scriptName: "missing:ci-gate",
        source: ".github/workflows/ci.yml",
      },
      {
        code: "DOC_SCRIPT_MISSING",
        scriptName: "missing:doc-cmd",
        source: "CONTRIBUTING.md",
      },
    ],
  );
});

test("boundary: argument forwarding rejects chained commands and trailing --", () => {
  const chained = validateArgumentForwarding(
    "bad:forward",
    "node scripts/a.mjs && node scripts/b.mjs",
    true,
  );
  assert.equal(chained.length, 1);
  assert.equal(chained[0]?.code, "ARG_FORWARDING_UNSUPPORTED");

  const trailingDashDash = validateArgumentForwarding(
    "bad:dash",
    "node scripts/a.mjs --",
    true,
  );
  assert.equal(trailingDashDash.length, 1);
  assert.equal(trailingDashDash[0]?.code, "ARG_FORWARDING_UNSUPPORTED");

  const nonForwardableAllowed = validateArgumentForwarding(
    "dev:clean",
    "rm -rf .next && next dev",
    false,
  );
  assert.deepEqual(nonForwardableAllowed, []);
});

test("positive: disk verifier reads real files inside a temporary workspace", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mimir-script-contract-"));
  try {
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
    mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(path.join(dir, "scripts", "check.mjs"), "console.log('ok');\n");
    writeFileSync(path.join(dir, "node_modules", ".bin", "tsc"), "#!/bin/sh\n");
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          "check:terms": "node scripts/check.mjs",
        },
      }),
    );
    writeFileSync(
      path.join(dir, ".github", "workflows", "ci.yml"),
      "steps:\n  - run: npm run typecheck\n  - run: npm run check:terms\n",
    );
    writeFileSync(path.join(dir, "CONTRIBUTING.md"), "Run `npm run typecheck`.\n");

    const report = verifyPackageScripts({
      repoRoot: dir,
      reviewedScripts: {
        typecheck: { command: "tsc --noEmit", category: "quality", supportsArgForwarding: true },
        "check:terms": {
          command: "node scripts/check.mjs",
          category: "quality",
          supportsArgForwarding: true,
        },
      },
    });
    assert.equal(report.ok, true, formatPackageScriptReport(report));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
