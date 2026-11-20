import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as runnerModule from "../../scripts/run-node-tests.mjs";

type SpawnLike = (command: string, args: string[], options: { cwd: string; env: Record<string, string>; stdio: string }) => { status: number | null; error?: Error };

type RunnerOptions = {
  argv?: string[];
  root?: string;
  sourceEnvironment?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
};

type Runner = {
  ROOT: string;
  buildChildArgs: (options: { files: string[]; coverage: boolean; coveragePath: string; nodeVersion?: string }) => string[];
  buildTestEnvironment: (options: { sourceEnvironment: NodeJS.ProcessEnv; cacheDirectory?: string; includeDatabase?: boolean }) => Record<string, string>;
  cacheIdentity: (root?: string, nodeVersion?: string) => { runnerVersion: number; nodeVersion: string; lockfile: string; tsxVersion: string };
  compileCacheDirectory: (options?: { root?: string; cacheRoot?: string; nodeVersion?: string }) => string;
  discoverTestFiles: (root?: string) => string[];
  parseArgs: (argv?: string[], root?: string) => { cache: boolean; clearCache: boolean; coverage: boolean; coverageDir: string; cacheDir?: string; includeDatabase: boolean; help: boolean; files: string[]; filters: string[] };
  runNodeTests: (options?: RunnerOptions) => number;
};

const runner = runnerModule as unknown as Runner;
const {
  ROOT,
  buildChildArgs,
  buildTestEnvironment,
  cacheIdentity,
  compileCacheDirectory,
  discoverTestFiles,
  parseArgs,
  runNodeTests,
} = runner;

function makeRoot() {
  const directory = mkdtempSync(path.join(tmpdir(), "mimir-node-runner-"));
  mkdirSync(path.join(directory, "tests", "node"), { recursive: true });
  mkdirSync(path.join(directory, "node_modules", "tsx"), { recursive: true });
  writeFileSync(path.join(directory, "tests", "node", "sample.test.ts"), "export {};\n");
  writeFileSync(path.join(directory, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(path.join(directory, "node_modules", "tsx", "package.json"), '{"version":"fixture"}\n');
  return directory;
}

test("discovery is sorted and limited to the node test suite", () => {
  const files = discoverTestFiles(ROOT);
  assert.ok(files.length > 0);
  assert.deepEqual(files, [...files].sort((left, right) => left.localeCompare(right)));
  assert.ok(files.every((file) => file.startsWith("tests/node/") && file.endsWith(".test.ts")));
});

test("argument parsing supports cache, coverage, database opt-in, and explicit files", () => {
  const root = makeRoot();
  try {
    const options = parseArgs([
      "--coverage",
      "--coverage-dir",
      "artifacts/coverage",
      "--cache-dir",
      "artifacts/cache",
      "--clear-cache",
      "--with-db",
      "tests/node/sample.test.ts",
    ], root);
    assert.equal(options.coverage, true);
    assert.equal(options.coverageDir, path.join(root, "artifacts", "coverage"));
    assert.equal(options.cacheDir, path.join(root, "artifacts", "cache"));
    assert.equal(options.clearCache, true);
    assert.equal(options.includeDatabase, true);
    assert.deepEqual(options.filters, ["tests/node/sample.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("argument parsing fails without echoing unknown values", () => {
  assert.throws(() => parseArgs(["--private-secret=do-not-print"]), /Unknown node test option/);
  assert.throws(() => parseArgs(["--coverage-dir"]), /requires a value/);
});

test("child arguments retain process isolation and fresh coverage reporters", () => {
  const args = buildChildArgs({
    files: ["tests/node/sample.test.ts"],
    coverage: true,
    coveragePath: "/tmp/node-tests.lcov",
  });
  assert.ok(args.includes("--experimental-test-isolation=process"));
  assert.ok(args.includes("--experimental-test-coverage"));
  assert.ok(args.includes("--test-reporter=spec"));
  assert.ok(args.includes("--test-reporter=lcov"));
  assert.ok(args.includes("--test-reporter-destination=/tmp/node-tests.lcov"));
  assert.ok(!args.some((arg) => arg.includes("isolation=none")));
  assert.ok(!args.some((arg) => arg.includes("rerun-failures")));
  assert.deepEqual(args.slice(-1), ["tests/node/sample.test.ts"]);
  const earlyNodeArgs = buildChildArgs({
    files: ["tests/node/sample.test.ts"],
    coverage: false,
    coveragePath: "",
    nodeVersion: "22.0.0",
  });
  assert.ok(!earlyNodeArgs.includes("--experimental-test-isolation=process"));
});

test("the child environment is allowlisted and database credentials require opt-in", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "/bin",
    HOME: "/tmp",
    NODE_ENV: "development",
    DATABASE_URL: "postgres://secret",
    TURSO_DATABASE_URL: "libsql://secret",
    STELLAR_ORACLE_SECRET: "seed",
    ANTHROPIC_API_KEY: "key",
  };
  const safe = buildTestEnvironment({ sourceEnvironment: source, cacheDirectory: "/tmp/cache" });
  assert.equal(safe.PATH, "/bin");
  assert.equal(safe.HOME, "/tmp");
  assert.equal(safe.NODE_ENV, "test");
  assert.equal(safe.MIMIR_NODE_TESTS, "1");
  assert.equal(safe.NODE_COMPILE_CACHE, "/tmp/cache");
  assert.equal(safe.DATABASE_URL, undefined);
  assert.equal(safe.TURSO_DATABASE_URL, undefined);
  assert.equal(safe.STELLAR_ORACLE_SECRET, undefined);
  assert.equal(safe.ANTHROPIC_API_KEY, undefined);
  const withDatabase = buildTestEnvironment({ sourceEnvironment: source, includeDatabase: true });
  assert.equal(withDatabase.DATABASE_URL, "postgres://secret");
  assert.equal(withDatabase.TURSO_DATABASE_URL, "libsql://secret");
  assert.equal(withDatabase.STELLAR_ORACLE_SECRET, undefined);
});

test("cache identity changes with Node and dependency lock inputs without storing secrets", () => {
  const root = makeRoot();
  try {
    const identity = cacheIdentity(root, "22.0.0");
    assert.equal(identity.nodeVersion, "22.0.0");
    assert.equal(identity.tsxVersion, "fixture");
    assert.equal(identity.lockfile.length, 64);
    assert.equal(JSON.stringify(identity).includes("secret"), false);
    const first = compileCacheDirectory({ root, cacheRoot: path.join(root, "cache"), nodeVersion: "22.0.0" });
    const second = compileCacheDirectory({ root, cacheRoot: path.join(root, "cache"), nodeVersion: "22.1.0" });
    assert.notEqual(first, second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner propagates a fake child failure and publishes failed coverage atomically", () => {
  const root = makeRoot();
  const cacheRoot = path.join(root, "cache");
  const coverageDir = path.join(root, "coverage");
  try {
    const spawn: SpawnLike = (_command: string, args: string[]) => {
      const destination = args.find((arg) => arg.startsWith("--test-reporter-destination=") && arg !== "--test-reporter-destination=stdout");
      assert.ok(destination);
      writeFileSync(destination.slice("--test-reporter-destination=".length), "TN:\nSF:lib/example.ts\n");
      return { status: 1 };
    };
    const status = runNodeTests({
      argv: ["--cache-dir", cacheRoot, "--coverage-dir", coverageDir, "tests/node/sample.test.ts"],
      root,
      sourceEnvironment: { PATH: "/bin", NODE_ENV: "test" },
      spawn,
    });
    assert.equal(status, 1);
    assert.equal(readFileSync(path.join(coverageDir, "node-tests.failed.lcov"), "utf8"), "TN:\nSF:lib/example.ts\n");
    assert.equal(existsSync(path.join(coverageDir, "node-tests.lcov")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner publishes a successful coverage report and creates a compile cache", () => {
  const root = makeRoot();
  const cacheRoot = path.join(root, "cache");
  const coverageDir = path.join(root, "coverage");
  try {
    let invocation: { args: string[]; options: { env: Record<string, string> } } | undefined;
    const spawn: SpawnLike = (_command: string, args: string[], options) => {
      assert.equal(_command, process.execPath);
      invocation = { args, options };
      const destination = args.find((arg) => arg.startsWith("--test-reporter-destination=") && arg !== "--test-reporter-destination=stdout");
      assert.ok(destination);
      writeFileSync(destination.slice("--test-reporter-destination=".length), "TN:\nSF:lib/example.ts\n");
      return { status: 0 };
    };
    const status = runNodeTests({
      argv: ["--cache-dir", cacheRoot, "--coverage-dir", coverageDir, "tests/node/sample.test.ts"],
      root,
      sourceEnvironment: { PATH: "/bin", NODE_ENV: "test" },
      spawn,
    });
    assert.equal(status, 0);
    assert.ok(invocation);
    assert.equal(readFileSync(path.join(coverageDir, "node-tests.lcov"), "utf8"), "TN:\nSF:lib/example.ts\n");
    assert.equal(invocation.options.env.NODE_ENV, "test");
    assert.equal(invocation.options.env.NODE_COMPILE_CACHE.startsWith(cacheRoot), true);
    assert.equal(invocation.args.includes("--experimental-test-isolation=process"), true);
    const cacheDirectory = invocation.options.env.NODE_COMPILE_CACHE;
    assert.equal(readFileSync(path.join(cacheDirectory, "manifest.json"), "utf8").includes('"tsxVersion": "fixture"'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
