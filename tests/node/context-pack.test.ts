import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_PACK_VERSION,
  assessCorroboration,
  assessFreshness,
  contextPackHash,
  onChainSettlementRule,
  reviseContextPack,
  validateContextPack,
  type ContextSource,
  type MarketContextPack,
} from "../../lib/research/context-pack";

// Bare hex, no `0x` prefix: `contentHash` is now SHA-256 written the way Stellar
// tooling writes hex. `isHash32Hex` still tolerates a prefix on input, so the
// prefixed form is exercised separately below.
const HASH_A = "11".repeat(32);
const HASH_B = "22".repeat(32);
const DEADLINE = 1_780_000_000; // unix seconds
const DEADLINE_MS = DEADLINE * 1000;

function source(overrides: Partial<ContextSource> = {}): ContextSource {
  return {
    url: "https://www.coingecko.com/en/coins/bitcoin",
    domain: "coingecko.com",
    trustTier: "primary",
    capturedAt: DEADLINE_MS + 60_000,
    contentHash: HASH_A,
    excerpt: "BTC closed at 98,410.22 USD on 2026-05-25.",
    publishedAt: DEADLINE_MS + 30_000,
    sourceTimezone: "UTC",
    ...overrides,
  };
}

function pack(overrides: Partial<MarketContextPack> = {}): MarketContextPack {
  return {
    packVersion: CONTEXT_PACK_VERSION,
    claim: "Will BTC close above $100,000 on 2026-05-25 according to CoinGecko?",
    creatorPosition: "Yes, it closes above",
    counterPosition: "No, it closes below",
    subjectType: "binary",
    category: "crypto",
    entities: ["BTC", "CoinGecko"],
    deadline: DEADLINE,
    resolution: {
      rule: "Settle on CoinGecko's reported daily close for BTC/USD.",
      threshold: 100_000,
      units: "USD",
      rounding: "2dp",
      tieBreak: "draw",
      timezone: "UTC",
      edgeCases: ["If CoinGecko reports no close for the date, void."],
      voidRule: "No published close for the date.",
    },
    primarySource: source(),
    corroboratingSources: [
      source({
        url: "https://www.kraken.com/prices/bitcoin",
        domain: "kraken.com",
        trustTier: "corroborating",
        contentHash: HASH_B,
        excerpt: "BTC/USD daily close 98,405.10.",
      }),
    ],
    confidenceBps: 8_200,
    unresolvedQuestions: ["CoinGecko does not state which exchange feed it aggregates."],
    createdAt: DEADLINE_MS + 90_000,
    revision: 0,
    ...overrides,
  };
}

// ── Validation: forcing the ambiguities out ───────────────────────────────────

test("a complete pack validates", () => {
  const result = validateContextPack(pack());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("a dated claim without a timezone is refused", () => {
  // "Closes above X on date D" is undecidable without one.
  const result = validateContextPack(
    pack({ resolution: { ...pack().resolution, timezone: "  " } }),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /timezone is required/);
});

test("a numeric threshold requires units, rounding and a tie-break", () => {
  const bare = validateContextPack(
    pack({
      resolution: {
        rule: "Settle on the close.",
        threshold: 100_000,
        timezone: "UTC",
        edgeCases: [],
      },
    }),
  );
  assert.equal(bare.ok, false);
  const joined = bare.errors.join(" ");
  assert.match(joined, /needs resolution\.units/);
  assert.match(joined, /needs resolution\.rounding/);
  // Exact equality with the threshold is the most common real dispute.
  assert.match(joined, /tieBreak for exact equality/);
});

test("a non-numeric claim needs none of those", () => {
  const result = validateContextPack(
    pack({
      resolution: {
        rule: "Settle on the official winner announced by the organiser.",
        timezone: "Europe/Istanbul",
        edgeCases: [],
      },
    }),
  );
  assert.equal(result.ok, true);
});

test("every source must carry an excerpt so a vanished source can still settle", () => {
  const result = validateContextPack(
    pack({ primarySource: source({ excerpt: "   " }) }),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /excerpt is required so the capture survives/);
});

test("sources need an http url, a 32-byte hash and a capture time", () => {
  assert.match(
    validateContextPack(pack({ primarySource: source({ url: "ftp://x/y" }) })).errors.join(" "),
    /must be http\(s\)/,
  );
  assert.match(
    validateContextPack(pack({ primarySource: source({ contentHash: "dead" }) })).errors.join(" "),
    /SHA-256 hash/,
  );
  assert.match(
    validateContextPack(pack({ primarySource: source({ capturedAt: 0 }) })).errors.join(" "),
    /capturedAt is required/,
  );
});

test("trust tiers cannot be mislabelled", () => {
  assert.match(
    validateContextPack(pack({ primarySource: source({ trustTier: "corroborating" }) })).errors.join(" "),
    /primarySource must have trustTier 'primary'/,
  );
  assert.match(
    validateContextPack(
      pack({ corroboratingSources: [source({ trustTier: "primary" })] }),
    ).errors.join(" "),
    /must not claim trustTier 'primary'/,
  );
});

test("identical positions are refused", () => {
  const result = validateContextPack(
    pack({ creatorPosition: "Yes", counterPosition: "Yes" }),
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /positions must differ/);
});

test("confidence is an integer in basis points", () => {
  for (const bad of [-1, 10_001, 82.5]) {
    assert.equal(validateContextPack(pack({ confidenceBps: bad })).ok, false);
  }
});

// ── Warnings: things a reviewer must see but that do not block ─────────────────

test("no open questions is a warning, not a pass", () => {
  // An agent claiming zero open questions asserts certainty it does not have.
  const result = validateContextPack(pack({ unresolvedQuestions: [] }));
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(" "), /no unresolvedQuestions/);
});

test("a source published before the deadline it must settle is flagged", () => {
  const result = validateContextPack(
    pack({ primarySource: source({ publishedAt: DEADLINE_MS - 60_000 }) }),
  );
  assert.match(result.warnings.join(" "), /published before the deadline/);
});

// ── Corroboration must be INDEPENDENT ─────────────────────────────────────────

test("corroboration from the primary's own domain is not corroboration", () => {
  // Three pages on one site are one source wearing three hats.
  const status = assessCorroboration(
    pack({
      corroboratingSources: [
        source({
          url: "https://coingecko.com/other",
          domain: "coingecko.com",
          trustTier: "corroborating",
        }),
      ],
    }),
  );
  assert.equal(status, "same_origin_only");
});

test("an independent domain corroborates", () => {
  assert.equal(assessCorroboration(pack()), "corroborated");
});

test("no sources means uncorroborated, and it warns", () => {
  const p = pack({ corroboratingSources: [] });
  assert.equal(assessCorroboration(p), "uncorroborated");
  assert.match(validateContextPack(p).warnings.join(" "), /no independent corroborating source/);
});

test("unverified sources do not count as corroboration", () => {
  assert.equal(
    assessCorroboration(
      pack({
        corroboratingSources: [
          source({ url: "https://blog.example.com/x", domain: "example.com", trustTier: "unverified" }),
        ],
      }),
    ),
    "uncorroborated",
  );
});

test("an explicit conflict outranks everything", () => {
  assert.equal(assessCorroboration(pack(), true), "conflicting");
});

// ── Freshness ─────────────────────────────────────────────────────────────────
test("freshness reports age and whether the capture beat the deadline", () => {
  const assessment = assessFreshness(source(), DEADLINE);
  assert.equal(assessment.ageSeconds, 30);
  assert.equal(assessment.capturedAfterDeadline, true);
  assert.equal(assessment.publishedBeforeDeadline, false);
});

test("a source with no publish time has unknown age, not zero", () => {
  const assessment = assessFreshness(source({ publishedAt: undefined }), DEADLINE);
  assert.equal(assessment.ageSeconds, undefined);
});

// ── On-chain commitment ───────────────────────────────────────────────────────

test("the hash is deterministic for the same content", () => {
  assert.equal(contextPackHash(pack()), contextPackHash(pack()));
  assert.match(contextPackHash(pack()), /^[0-9a-f]{64}$/);
});

test("entity discovery order does not change the hash", () => {
  // The same set found in a different order is the same context.
  assert.equal(
    contextPackHash(pack({ entities: ["BTC", "CoinGecko"] })),
    contextPackHash(pack({ entities: ["coingecko", "btc"] })),
  );
});

test("corroborating source order does not change the hash", () => {
  const a = source({ url: "https://a.com/x", domain: "a.com", trustTier: "corroborating" });
  const b = source({ url: "https://b.com/x", domain: "b.com", trustTier: "corroborating" });
  assert.equal(
    contextPackHash(pack({ corroboratingSources: [a, b] })),
    contextPackHash(pack({ corroboratingSources: [b, a] })),
  );
});

test("async fetch order does not change the hash when sources share a URL", () => {
  // Regression: the same page captured twice (or two sources whose URL and
  // domain coincide) used to tie on URL alone, leaving the digest at the mercy
  // of whichever fetch finished first.
  const first = source({
    url: "https://mirror.example/x",
    domain: "mirror.example",
    trustTier: "corroborating",
    capturedAt: DEADLINE_MS + 10_000,
    contentHash: HASH_A,
    excerpt: "First capture of the mirror page.",
  });
  const second = source({
    url: "https://mirror.example/x",
    domain: "mirror.example",
    trustTier: "corroborating",
    capturedAt: DEADLINE_MS + 20_000,
    contentHash: HASH_B,
    excerpt: "Second capture of the mirror page.",
  });
  assert.equal(
    contextPackHash(pack({ corroboratingSources: [first, second] })),
    contextPackHash(pack({ corroboratingSources: [second, first] })),
  );
});

test("the remaining capture metadata breaks ties deterministically", () => {
  const base = source({
    url: "https://mirror.example/x",
    domain: "mirror.example",
    trustTier: "corroborating",
  });
  const cases: Array<[ContextSource, ContextSource]> = [
    // Publish time alone differs.
    [base, { ...base, publishedAt: (base.publishedAt ?? 0) + 1_000 }],
    // Reported timezone alone differs.
    [base, { ...base, sourceTimezone: "America/New_York" }],
    // Capture time and content hash coincide, only the excerpt differs.
    [base, { ...base, excerpt: "A different slice of the same page." }],
  ];
  for (const [a, b] of cases) {
    assert.equal(
      contextPackHash(pack({ corroboratingSources: [a, b] })),
      contextPackHash(pack({ corroboratingSources: [b, a] })),
    );
  }
});

test("differing capture metadata still changes the hash", () => {
  // Determinism must not be bought by dropping the metadata: a different
  // capture is a different piece of evidence and has to produce a new digest.
  const base = source({
    url: "https://mirror.example/x",
    domain: "mirror.example",
    trustTier: "corroborating",
  });
  const baseline = contextPackHash(pack({ corroboratingSources: [base] }));
  assert.notEqual(
    baseline,
    contextPackHash(pack({ corroboratingSources: [{ ...base, capturedAt: base.capturedAt + 1 }] })),
  );
  assert.notEqual(
    baseline,
    contextPackHash(pack({ corroboratingSources: [{ ...base, contentHash: HASH_B }] })),
  );
  assert.notEqual(
    baseline,
    contextPackHash(pack({ corroboratingSources: [{ ...base, publishedAt: undefined }] })),
  );
  assert.notEqual(
    baseline,
    contextPackHash(pack({ corroboratingSources: [{ ...base, sourceTimezone: undefined }] })),
  );
});

test("changing the rule changes the hash", () => {
  assert.notEqual(
    contextPackHash(pack()),
    contextPackHash(pack({ resolution: { ...pack().resolution, rule: "Settle differently." } })),
  );
});

test("changing the threshold, the tie-break or the timezone changes the hash", () => {
  const base = contextPackHash(pack());
  assert.notEqual(base, contextPackHash(pack({ resolution: { ...pack().resolution, threshold: 99_000 } })));
  assert.notEqual(base, contextPackHash(pack({ resolution: { ...pack().resolution, tieBreak: "creator" } })));
  assert.notEqual(base, contextPackHash(pack({ resolution: { ...pack().resolution, timezone: "Asia/Tokyo" } })));
});

test("changing the primary source's content hash changes the pack hash", () => {
  assert.notEqual(
    contextPackHash(pack()),
    contextPackHash(pack({ primarySource: source({ contentHash: HASH_B }) })),
  );
});

test("two different packs cannot collide by field concatenation", () => {
  // Without real separators these are byte-identical once concatenated, so both
  // markets would commit to one hash. This is the regression guard for that.
  assert.notEqual(
    contextPackHash(pack({ creatorPosition: "ab", counterPosition: "c" })),
    contextPackHash(pack({ creatorPosition: "a", counterPosition: "bc" })),
  );
  // Same hazard across a group boundary.
  assert.notEqual(
    contextPackHash(pack({ claim: "AB", creatorPosition: "C" })),
    contextPackHash(pack({ claim: "A", creatorPosition: "BC" })),
  );
  // And across the resolution fields, where units and rounding sit adjacent.
  const base = pack().resolution;
  assert.notEqual(
    contextPackHash(pack({ resolution: { ...base, units: "USD", rounding: "2dp" } })),
    contextPackHash(pack({ resolution: { ...base, units: "USD2", rounding: "dp" } })),
  );
});

test("the on-chain rule summary states the fields that decide a dispute", () => {
  const summary = onChainSettlementRule(pack());
  assert.match(summary, /Threshold 100000 USD/);
  assert.match(summary, /rounded 2dp/);
  assert.match(summary, /exact ties to draw/);
  assert.match(summary, /Times in UTC/);
  assert.match(summary, /Source: coingecko\.com/);
});

test("the on-chain rule summary is bounded", () => {
  const summary = onChainSettlementRule(
    pack({ resolution: { ...pack().resolution, rule: "x".repeat(2_000) } }),
    200,
  );
  assert.ok(summary.length <= 200);
  assert.ok(summary.endsWith("…"));
});

// ── Revisions ─────────────────────────────────────────────────────────────────

test("a revision records both hashes and increments the counter", () => {
  const before = pack();
  const after = pack({ resolution: { ...before.resolution, rule: "Tightened rule." } });
  const { pack: revised, revision } = reviseContextPack(before, after, "rule was ambiguous", 1_000);

  assert.equal(revised.revision, 1);
  assert.equal(revision.previousHash, contextPackHash(before));
  assert.equal(revision.nextHash, contextPackHash(revised));
  assert.equal(revision.reason, "rule was ambiguous");
  assert.equal(revision.at, 1_000);
});

test("changing the primary source is flagged on its own, not buried in a diff", () => {
  // It changes what the market MEANS, so it must be visible in review.
  const before = pack();
  const after = pack({
    primarySource: source({ url: "https://kraken.com/prices/bitcoin", domain: "kraken.com" }),
  });
  const { revision } = reviseContextPack(before, after, "original source went offline");
  assert.equal(revision.changedPrimarySource, true);
});

test("a revision that keeps the same source says so", () => {
  const before = pack();
  const after = pack({ confidenceBps: 9_000 });
  assert.equal(reviseContextPack(before, after, "re-read the source").revision.changedPrimarySource, false);
});
