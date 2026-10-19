import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert";

const root = join(__dirname, "..", "..");

const agentFiles = [
  "app/[locale]/agents/page.tsx",
  "app/[locale]/agents/[id]/page.tsx",
  "app/[locale]/agents/new/page.tsx",
  "components/agents/AgentRoster.tsx",
  "components/agents/AgentStats.tsx",
];

describe("agent directory locale-aware links", () => {
  for (const file of agentFiles) {
    it(`${file} does not import next/link`, () => {
      const source = readFileSync(join(root, file), "utf-8");
      assert.ok(
        !/from\s+("|')next\/link/.test(source),
        `${file} should not import from "next/link"`,
      );
    });

    it(`${file} imports Link from @/i18n/navigation`, () => {
      const source = readFileSync(join(root, file), "utf-8");
      assert.match(
        source,
        /import\s+\{[^ ]*\bLink\b[^]*\}\s+from\s+("|')@\/i18n\/navigation("|')/,
        `${file} should import Link from @/i18n/navigation`,
      );
    });
  }
});
