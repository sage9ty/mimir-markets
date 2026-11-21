/**
 * Verify the `package.json` script contract against reviewed workflows and
 * real files/binaries on disk — offline and secret-free.
 *
 *   npm run verify:package-scripts
 *   npm run verify:package-scripts -- --json
 *
 * Exit codes:
 *   0  all reviewed scripts resolve and CI / CONTRIBUTING references exist
 *   1  missing/unreviewed script, malformed command, missing target, or doc drift
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatPackageScriptReport,
  verifyRepoPackageScripts,
} from "../lib/ops/package-script-contract";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv: string[]): { json: boolean; help: boolean } {
  const args = new Set(argv);
  for (const arg of argv) {
    if (arg !== "--json" && arg !== "--help" && arg !== "-h") {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return {
    json: args.has("--json"),
    help: args.has("--help") || args.has("-h"),
  };
}

function main(): void {
  const { json, help } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log("Usage: node --import tsx scripts/verify-package-scripts.ts [--json] [--help]");
    return;
  }

  const report = verifyRepoPackageScripts(REPO_ROOT);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatPackageScriptReport(report));
  }
  if (!report.ok) {
    process.exit(1);
  }
}

main();
