# Localization (i18n) workflow

Mimir uses [next-intl](https://next-intl-docs.vercel.app) for locale-prefixed routing (`/en/*`). English is the only **shipped** locale today; the infrastructure is in place to add more.

---

## Adding a new locale — checklist

1. **Register the locale** in `i18n/routing.ts`:

   ```ts
   export const routing = defineRouting({
     locales: ["en", "es"],   // add the new code here
     defaultLocale: "en",
     localePrefix: "always",
   });
   ```

2. **Create the message file** at `messages/{locale}.json`.  
   The file must contain every key present in `messages/en.json` as its baseline.  
   Copy `messages/en.json` and translate it; do **not** strip or reorder keys.

3. **Run the completeness check** locally:

   ```bash
   npm run check:locales
   ```

   Fix every error before opening a PR.  The same command runs in CI.

4. **Optional — catch stale keys** (extra keys not in English):

   ```bash
   npm run check:locales:strict
   ```

5. **Add explore fallbacks** in `i18n/request.ts`.  
   The `EXPLORE_FALLBACKS` map already has an `es` example.  Add an entry for your locale to ensure the explore filter strings degrade gracefully if that section of `messages/{locale}.json` is partial.

6. **Test the UI manually** by navigating to `/{locale}/` in dev (`npm run dev`).

---

## Funded-feature namespaces

Some namespaces contain strings that appear immediately before or during a USDC commitment. A missing key in one of these namespaces means a translated user could see a raw key path instead of guidance about what they are signing.

| Namespace  | What it covers                                         |
| ---------- | ------------------------------------------------------ |
| `create`   | Stake input, fee disclosure, settlement-mode labels    |
| `dashboard`| Copy-trading mirror controls, portfolio value display  |
| `home`     | Agent-wallet / x402 CTAs on the landing page          |
| `vsDetail` | Payout card, fee breakdown, settlement receipt         |
| `wallet`   | USDC trust-line gate, balance display, approval flows  |

Missing any key in these namespaces causes `npm run check:locales` to exit 1 with a **FUNDED-FEATURE VIOLATION** message and blocks the CI job. This is intentional and the block cannot be suppressed by a flag.

The complete list is the `FUNDED_NAMESPACES` constant in `lib/locale-completeness.ts`. Extend it when a new namespace exposes strings that gate or describe a money-touching action.

---

## How the check works

```
i18n/routing.ts (locales list)
        │
        ▼
scripts/check-locale-completeness.mjs
        │  reads messages/{locale}.json for each non-English locale
        │  calls flattenKeys() → dot-separated leaf paths
        │  diffs against messages/en.json (the baseline)
        │
        ├─ missing keys          → error; prints key paths
        ├─ missing funded keys   → FUNDED-FEATURE VIOLATION; always exits 1
        ├─ extra keys            → warning (stale translations); no exit code change
        └─ untranslated strings  → warning (value == English baseline)
```

The script and core logic live in two files:

| File | Role |
| ---- | ---- |
| `lib/locale-completeness.ts` | Typed library: `flattenKeys`, `checkLocale`, `checkAll`, `FUNDED_NAMESPACES` |
| `scripts/check-locale-completeness.mjs` | CLI wrapper — reads the filesystem, formats output, sets exit code |

The library has no filesystem or network dependency; it accepts parsed JSON objects. This makes it fully testable without mocks.

---

## Running the tests

The test suite is part of the standard `npm run test:smoke` run:

```bash
# Run just the locale tests
node --import tsx --test tests/node/locale-completeness.test.ts

# Run the full node test suite (includes locale tests)
npm run test:smoke
```

Fixtures live in `tests/fixtures/locales/`:

| Fixture | Purpose |
| ------- | ------- |
| `en.json` | Minimal English baseline (subset of the real file) |
| `complete.json` | All keys present and translated — positive case |
| `missing-keys.json` | Drops non-funded keys (`common.*`) — tests missing detection |
| `extra-keys.json` | Adds obsolete keys — tests extra detection |
| `missing-funded.json` | Drops a `dashboard.*` key — tests funded-violation flag |
| `untranslated.json` | Keeps some values identical to English — tests untranslated detection |

---

## CI behaviour

`npm run check:locales` runs in the `verify` job of `.github/workflows/ci.yml`, after `check:terms` and before `typecheck`. It uses plain `node` (no `tsx`) so it adds negligible overhead.

| Condition | CI outcome |
| --------- | ---------- |
| Only English registered | ✓ passes immediately — nothing to diff |
| New locale, all keys present | ✓ passes |
| New locale, missing non-funded keys | ✗ fails — lists missing keys |
| New locale, missing funded keys | ✗ fails — FUNDED-FEATURE VIOLATION |
| New locale, extra (stale) keys | ✓ passes — warning printed |

---

## Release and rollback impact

**Release.** Adding a locale adds no on-chain state and requires no contract change. It is a pure frontend concern: a new message file, a one-line routing change, and CI green. Rolling back means reverting the routing entry and removing the message file; the app falls back to English immediately for all users on the removed locale's path.

**Funded-feature gate.** The check is additive — it only blocks a locale from being registered while it is incomplete. It does not alter existing settlement, fee, or payout logic. A CI failure here means "this locale is not ready to ship", not "something is broken on mainnet".

**Production secrets.** The script reads only `i18n/routing.ts` and `messages/*.json`. It requires no environment variables, no API keys, and no database access. It is safe to run from any checkout, including fresh CI runners.

---

## Adding a key to a funded namespace

1. Add the English key to `messages/en.json` in the appropriate funded namespace.
2. If any non-English locale is registered in `i18n/routing.ts`, add the translation to `messages/{locale}.json` **in the same PR**.
3. CI will fail if you forget step 2 — the funded-violation check will catch the gap.

Do not add placeholder English strings to non-English files as a "ship now, translate later" workaround for funded namespaces. The entire point of the funded check is to prevent users from interacting with money-moving flows without readable guidance.

---

## Architectural notes

- **Arrays are opaque.** `flattenKeys` does not expand array indices. `create.challengeQuestionExamples` is treated as a single leaf. This matches how next-intl consumes array entries (`t.raw()`) and avoids false positives when an array is translated as a whole.
- **Untranslated detection is string-only.** Numbers, booleans, and arrays that happen to be identical across locales are intentional (IDs, format patterns), so only `string`-typed values are compared.
- **Extra keys are warnings, not errors.** A key present in a locale but absent from the English baseline was likely deleted from English. It is safe to ship (the runtime ignores unknown keys), but it signals the translator's file needs pruning.

- **Portfolio performance separation.** Localized currency and date strings are presentation-only. Portfolio and chart calculation endpoints accept canonical numeric and atomic values (lib/portfolio-performance.ts). Formatted display strings must never be parsed back into money arithmetic.
