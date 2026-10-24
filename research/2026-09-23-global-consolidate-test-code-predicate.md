# Consolidate test-code predicates onto `isTestCodePath`

## Context

`plugin-id/core` (`plugins/framework/plugins/plugin-id/core/plugin-id.ts:165-194`)
defines the single source of truth for test-code identification:

- `TESTING_FOLDER = "testing"` — `<runtime>/testing/index.ts` barrels
- `TESTS_DIR = "__tests__"` — vitest jsdom suite directories
- `isTestCodePath(segments)` — true for `*.test.ts(x)`, `__tests__/`, or `testing/`

The boundary checks and `parse-utils/walkFiles` already import and use these.
Eight other places re-derive the predicate with hand-written regexes and sets.
**None of the eight know about `testing/`**, so a file in `<runtime>/testing/`
slips through as production code — it gets scanned, hashed, documented, or
linted as if it shipped.

## Approach

Replace each hand-written predicate with imports from
`@plugins/framework/plugins/plugin-id/core`. The eight sites fall into three
categories by what they can import.

### Category A: check/facet/codegen code — import `isTestCodePath` directly

These run under Bun and can resolve `@plugins/*`.

**1. `keyed-resource-scope` check**
`plugins/framework/plugins/tooling/plugins/checks/plugins/keyed-resource-scope/check/index.ts:52-53`

Replace the local `isTestPath` with `isTestCodePath`:
```ts
// Before
const isTestPath = (rel: string) =>
  /\.test\.tsx?$/.test(rel) || rel.includes("__tests__/");

// After
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
const isTestPath = (rel: string) => isTestCodePath(rel.split("/"));
```

**2. `table-defs-in-schema-glob` check**
`plugins/framework/plugins/tooling/plugins/checks/plugins/table-defs-in-schema-glob/check/index.ts:78-83`

Replace the inline conditions (which also miss `.test.tsx`) with `isTestCodePath`:
```ts
// Before
if (path.endsWith(".test.ts")) return false;
if (/\/__tests__\//.test(path)) return false;

// After — one call replaces both
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
if (isTestCodePath(path.split("/"))) return false;
```

**3. `routes` facet**
`plugins/plugin-meta/plugins/facets/plugins/routes/facet/index.ts:215`

Replace the inline condition:
```ts
// Before
if (/\.test\.tsx?$/.test(f) || f.includes("/__tests__/")) continue;

// After
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
if (isTestCodePath(f.split("/"))) continue;
```

**7. `durable-signals-accounted` check**
`plugins/framework/plugins/tooling/plugins/checks/plugins/durable-signals-accounted/check/scan.ts:28-33`

The pathspecs exclude `*.test.ts(x)` but miss `__tests__/` and `testing/`.
Build the exclusions from the constants:
```ts
import { TESTS_DIR, TESTING_FOLDER } from "@plugins/framework/plugins/plugin-id/core";

export const SINK_PATHSPECS = [
  "*.ts", "*.tsx",
  ":(exclude)*.test.ts", ":(exclude)*.test.tsx",
  `:(exclude)**/${TESTS_DIR}/**`,
  `:(exclude)**/${TESTING_FOLDER}/**`,
];
```

### Category B: directory walkers — add `TESTING_FOLDER` to skip sets

These walk the filesystem and skip directories by name. They already skip
`__tests__` but not `testing/`. The fix is to import the constants and add
`TESTING_FOLDER` to their skip logic.

**4. `plugin-tree` fs-snapshot**
`plugins/plugin-meta/plugins/plugin-tree/core/internal/fs-snapshot.ts:30-46`

`plugin-tree` already imports from `plugin-id/core`. Add `TESTING_FOLDER` and
`TESTS_DIR` to the imports and use them:
```ts
import { TESTS_DIR, TESTING_FOLDER } from "@plugins/framework/plugins/plugin-id/core";

function isSkippedDir(name: string): boolean {
  return (
    name === "node_modules" ||
    name === "plugins" ||
    name === TESTS_DIR ||
    name === TESTING_FOLDER ||
    name.startsWith(".") ||
    name.startsWith("dist")
  );
}
```
Also update `shouldRead` to use `isTestCodePath` instead of the hand-rolled regex:
```ts
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";

function shouldRead(name: string): boolean {
  if (name === "package.json") return true;
  return /\.(ts|tsx)$/.test(name) && !isTestCodePath([name]);
}
```

**5. `codegen/eager-tier-gen.ts`**
`plugins/framework/plugins/tooling/plugins/codegen/core/eager-tier-gen.ts:256-258`

`codegen` already imports from `plugin-id/core`. Replace the local constants:
```ts
import {
  isTestCodePath, TESTS_DIR, TESTING_FOLDER,
} from "@plugins/framework/plugins/plugin-id/core";

const SOURCE_FILE_RE = /\.tsx?$/;
const SKIPPED_DIRS = new Set(["node_modules", "plugins", TESTS_DIR, TESTING_FOLDER]);
```
And replace the `TEST_FILE_RE.test(name)` call with `isTestCodePath([name])` at
line 272.

**6. `web-artifacts/own-files.ts`**
`plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/own-files.ts:27-28`

`testing/` sits inside an inlined root (e.g. `web/testing/`) but is an external
barrel — it is never bundled into the browser artifact. Including it in the hash
causes needless rebuilds when test helpers change. Add it to the skip set:
```ts
import { TESTS_DIR, TESTING_FOLDER } from "@plugins/framework/plugins/plugin-id/core";

const SKIP_DIRS = new Set(["node_modules", TESTS_DIR, TESTING_FOLDER, "public"]);
```
And replace the local `TEST_FILE_RE` with `isTestCodePath`:
```ts
import { isTestCodePath } from "@plugins/framework/plugins/plugin-id/core";
// line 64:
if (isTestCodePath([e.name]) || e.name === ".DS_Store") continue;
```

### Category C: lint config — fix via `non-app-globs.ts`

**8. `sink-safety` lint ignores**

Lint barrels are loaded by jiti, which cannot resolve `@plugins/*`. But
`sink-safety` does NOT use `enforceEverywhere`, so its rules are already off in
test files via `non-app-globs.ts` — the per-rule `**/*.test.ts(x)` ignores are
redundant defense-in-depth. The real gap is that `non-app-globs.ts` itself
misses `**/testing/**`.

Fix: add `**/testing/**/*.{ts,tsx}` to `NON_APP_FILE_GLOBS` in
`plugins/framework/plugins/tooling/plugins/lint/core/non-app-globs.ts`:
```ts
export const NON_APP_FILE_GLOBS: readonly string[] = [
  "**/e2e/**/*.{ts,tsx}",
  "**/__tests__/**/*.{ts,tsx}",
  "**/testing/**/*.{ts,tsx}",   // ← add
  "**/*.test.{ts,tsx}",
  "test/**/*.{ts,tsx}",
];
```

This fixes the gap for ALL contributed lint rules at once, not just sink-safety.
`enforceEverywhere` rules (promise-safety) still apply to `testing/` — those
catch genuine bugs, and test helpers should have them.

No change needed to the `sink-safety` barrel itself — its `ignores` are already
redundant with `non-app-globs.ts` for the test patterns.

## Files modified

| # | File | Change |
|---|------|--------|
| 1 | `.../keyed-resource-scope/check/index.ts` | Replace `isTestPath` with imported `isTestCodePath` |
| 2 | `.../table-defs-in-schema-glob/check/index.ts` | Replace inline conditions with `isTestCodePath` |
| 3 | `.../facets/plugins/routes/facet/index.ts` | Replace inline condition with `isTestCodePath` |
| 4 | `.../plugin-tree/core/internal/fs-snapshot.ts` | Add `TESTING_FOLDER` to `isSkippedDir`, use `isTestCodePath` in `shouldRead` |
| 5 | `.../codegen/core/eager-tier-gen.ts` | Replace local constants with imports, use `isTestCodePath` |
| 6 | `.../web-artifacts/core/internal/own-files.ts` | Add `TESTING_FOLDER` to `SKIP_DIRS`, use `isTestCodePath` |
| 7 | `.../durable-signals-accounted/check/scan.ts` | Build pathspecs from imported constants |
| 8 | `.../lint/core/non-app-globs.ts` | Add `**/testing/**/*.{ts,tsx}` |

## Verification

1. `./equin check type-check` — the new imports resolve and types are correct
2. `./equin check plugin-boundaries` — the new cross-plugin imports are legal
3. `./equin build` — full build succeeds (migrations, codegen, frontend, server)
4. Spot-check: create a file at `plugins/<any>/web/testing/some-helper.ts` and
   verify that checks #1-#7 exclude it and contributed lint rules are off for it
