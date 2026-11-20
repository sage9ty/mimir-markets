/** Verify or regenerate the offline API contract artifact. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_CONTRACT_FIXTURE_PATH, renderApiContractFixtures } from "../lib/api/contract-fixtures";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--write")) {
  console.error("Usage: npm run check:api-fixtures -- [--write]");
  process.exitCode = 1;
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const destination = path.join(root, API_CONTRACT_FIXTURE_PATH);
  const expected = renderApiContractFixtures();
  if (args.includes("--write")) {
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, expected, "utf8");
  }
  if (!existsSync(destination) || readFileSync(destination, "utf8") !== expected) {
    console.error("API contract fixtures are missing or stale. Run npm run check:api-fixtures -- --write and review the diff.");
    process.exitCode = 1;
  } else {
    console.log(`API contract fixtures match: ${API_CONTRACT_FIXTURE_PATH}`);
  }
}
