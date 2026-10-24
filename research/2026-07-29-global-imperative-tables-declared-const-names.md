# Publish the imperative-table constant NAMES as data (delete both hand-rolled array parses)

**Date:** 2026-07-29
**Category:** global (`plugins/database/plugins/derived-views` + `plugins/database/plugins/migrations` + `plugins/framework/plugins/tooling`)

## Context

`research/2026-07-29-global-drizzle-schema-glob-single-source.md` deleted a text/regex parse
of `drizzle.config.ts` and flagged, as out of scope, that
`parseImperativeTableNameConsts` in the `table-defs-in-schema-glob` check is the same class
of hand-rolled array-literal regex over `IMPERATIVE_PUBLIC_TABLES`:

```ts
sourceText.match(/IMPERATIVE_PUBLIC_TABLES[^=]*=\s*\[([^\]]*)\]/)
```

Investigating it surfaced a fact the note did not have: **there are two such parsers, in two
different plugins, of the same array literal**, written independently and disagreeing on both
their extraction rule and their failure mode.

| | `parseImperativeTableNameConsts` | `parseAllowlistIdentifiers` |
|---|---|---|
| Where | `…/checks/plugins/table-defs-in-schema-glob/check/index.ts:56` | `plugins/database/plugins/migrations/check/imperative-create-table-allowlisted.ts` |
| Locate | regex `IMPERATIVE_PUBLIC_TABLES[^=]*=\s*\[([^\]]*)\]` — matches the **first textual occurrence**, including the 30-line prose header that names the symbol | `\bconst\s+IMPERATIVE_PUBLIC_TABLES\b` then `indexOf("=")` → `indexOf("[")` → **first** `indexOf("]")` |
| Identifiers | `[A-Za-z_$][A-Za-z0-9_$]*` (would also capture `readonly`, `string` from a type annotation caught in the span) | `\b[A-Z][A-Z0-9_]+\b` (SCREAMING_CASE only) |
| Parse failure | returns **empty set** — every exemption silently dropped | **throws**, and throws again on an empty result |

Both consume the same thing and neither is the declared source of it. Nothing forces them to
agree; today they only do because the array happens to be eight plain identifiers on their own
lines. Both carry the `[^\]]*` / first-`]` truncation hazard, both are blind to a non-identifier
element (a spread, a `.map()`), and the first one is additionally hijackable by prose.

As the note said, this is **not a live correctness hole**: a dropped exemption makes both checks
report a *false positive* on a legitimate site, not a false pass. That is why this is a
robustness cleanup. But it is a hazard sitting on top of a real gap:

**The root cause is that `IMPERATIVE_PUBLIC_TABLES` publishes only the table-name *values*, while
what these two checks enforce is a *textual* coupling that needs the constants' *identifier
names*.** So each check re-derives, from source text, information the module could simply
declare. The note correctly observed that "importing the module does not supply what the check
consumes" — that is true of the module *as written today*, and is the thing to fix.

**Outcome:** publish the name↔value mapping as one declaration. Both checks import it. Neither
parses anything, and the two parsers and their tests are deleted.

## Why the names are genuinely needed (no cheaper escape)

Both checks match an identifier as *text* at a call site, deliberately:

- `imperative-create-table-allowlisted` requires the DDL line to interpolate the constant —
  `CREATE TABLE IF NOT EXISTS ${TASK_LATEST_CONVERSATION_TABLE} (…)`
  (`plugins/tasks/plugins/tasks-core/server/internal/rollup-spec.ts:40`,
  `plugins/database/plugins/change-feed/server/internal/triggers.ts:70`). The *value*
  (`task_latest_conversation`) never appears on that line.
- `table-defs-in-schema-glob` exempts `pgTable(<IDENT>, …)` read handles
  (`plugins/tasks/plugins/tasks-core/server/internal/rollup-table.ts:18`,
  `plugins/conversations/plugins/agents/server/internal/rollup-table.ts:13`) and deliberately
  refuses string-literal names.

Resolving `<IDENT>` → value would mean following the import — real work for no gain. So the
identifier name is legitimately data the allowlist should publish.

## Approach

Invert the dependency, exactly as the schema-glob change did: make the mapping the declaration,
and derive both projections from it.

### 1. `IMPERATIVE_PUBLIC_TABLES` becomes a const-name → table-name record

**Edit** `plugins/database/plugins/derived-views/core/internal/imperative-tables.ts`. Keep all
eight `export const …` declarations and their doc comments verbatim; replace the closing array:

```ts
/**
 * The full allowlist of public tables created imperatively (outside drizzle),
 * keyed BY THE NAME OF THE CONSTANT that holds each table name.
 *
 * The shorthand form is load-bearing, not cosmetic: two static checks enforce a
 * TEXTUAL coupling — the create site must interpolate the constant on its
 * `CREATE TABLE` line (`imperative-create-table-allowlisted`), and a `pgTable`
 * read handle must pass the constant, not a string literal
 * (`table-defs-in-schema-glob`). Those checks need the identifier NAMES, which
 * a plain `string[]` of values does not publish — so both used to regex them
 * back out of this file's TEXT. Writing each entry as shorthand (`{ FOO }`, not
 * `{ BAR: FOO }`) is what makes each key the identifier a call site must spell.
 * The `imperative-create-table-allowlisted` check proves every key names a
 * barrel export holding that value, so a non-shorthand entry fails loudly.
 */
export const IMPERATIVE_PUBLIC_TABLES = {
  MIGRATIONS_TABLE_NAME,
  DERIVED_VIEW_STATE_TABLE_NAME,
  LIVE_STATE_TRIGGER_STATE_TABLE,
  LIVE_STATE_CHANGELOG_TABLE,
  LIVE_STATE_SNAPSHOT_TABLE,
  TASK_LATEST_CONVERSATION_TABLE,
  ATTEMPT_CONV_AGG_TABLE,
  ATTEMPT_PUSH_AGG_TABLE,
} as const satisfies Record<string, string>;

/** Table names — what a DB-side scan compares against `pg_stat_user_tables`. */
export const IMPERATIVE_PUBLIC_TABLE_NAMES: readonly string[] =
  Object.values(IMPERATIVE_PUBLIC_TABLES);

/** Constant identifiers — what a create site / `pgTable` read handle must spell. */
export const IMPERATIVE_PUBLIC_TABLE_CONSTS: readonly string[] =
  Object.keys(IMPERATIVE_PUBLIC_TABLES);
```

Both projections are derived, so they cannot drift. Also update the module header's "include it
in the IMPERATIVE_PUBLIC_TABLES array" instruction to say *record*, and note the shorthand rule.

Keeping the name `IMPERATIVE_PUBLIC_TABLES` (rather than minting a new one) keeps the prose in
four `CLAUDE.md` files and both check hints accurate; the one runtime consumer is typed, so the
shape change is a `tsc` error, never a silent misread.

The module stays a zero-import pure module — the property its header calls out as load-bearing
for check subprocesses.

### 2. Barrel

`plugins/database/plugins/derived-views/core/index.ts` — add
`IMPERATIVE_PUBLIC_TABLE_NAMES` and `IMPERATIVE_PUBLIC_TABLE_CONSTS` to the existing re-export
block. The eight individual constants stay exported (every create site imports from here).

### 3. `orphaned-tables.ts` — values

`plugins/database/plugins/migrations/check/orphaned-tables.ts:11,120` —
import `IMPERATIVE_PUBLIC_TABLE_NAMES` and pass it to `computeOrphans`. `computeOrphans`'
`readonly string[]` signature is unchanged; no test changes.

### 4. `table-defs-in-schema-glob` — delete the parser

`…/checks/plugins/table-defs-in-schema-glob/check/index.ts`:

- Delete `parseImperativeTableNameConsts`, the `IMPERATIVE_TABLES_FILE` constant, the
  `readFileSync` in `run()`, and the now-unused `fs` / `path` imports.
- `import { IMPERATIVE_PUBLIC_TABLE_CONSTS } from "@plugins/database/plugins/derived-views/core";`
  and build the set once: `const imperativeNameConsts = new Set(IMPERATIVE_PUBLIC_TABLE_CONSTS);`
- `isImperativeReadHandle` is unchanged (still the pure, unit-tested predicate).
- Rewrite the block comment above the import: the exemption rationale stays; the "read the file
  as text" paragraph goes.

Legal by the boundary rules — this check already imports two other plugins' `core` barrels
(`@plugins/database/plugins/migrations/core`, `@plugins/infra/plugins/spawn/core`), and
`derived-views/core` has no back-edge into `framework/tooling`, so no cycle.

### 5. `imperative-create-table-allowlisted` — delete the parser, add the real guard

`plugins/database/plugins/migrations/check/imperative-create-table-allowlisted.ts`:

- Delete `parseAllowlistIdentifiers`, `ALLOWLIST_SRC_REL`, and the `Bun.file(...).text()` read.
- Replace with the mapping plus a namespace import used as a **proof of the shorthand
  invariant** — a ~15-line pure helper, exported for unit testing:

```ts
import * as derivedViewsCore from "@plugins/database/plugins/derived-views/core";
import { IMPERATIVE_PUBLIC_TABLES } from "@plugins/database/plugins/derived-views/core";

/**
 * PURE helper: every allowlist KEY must name an exported constant holding that
 * table name. This is what makes the key usable as the identifier a create site
 * spells — a non-shorthand entry (`{ BAR: FOO }`) or a constant missing from the
 * barrel breaks the textual coupling this check enforces, and would otherwise
 * surface as a confusing false positive at the real CREATE TABLE line instead of
 * here. Throws (never returns a partial set): a broken allowlist is a parse-class
 * error, matching the previous parser's fail-loud contract.
 */
export function allowlistIdentifiers(
  mapping: Record<string, string>,
  exports: Record<string, unknown>,
): Set<string> { … }
```

The barrel namespace is the *right* comparison target, not a compromise: every external create
site and read handle imports its constant from `@plugins/database/plugins/derived-views/core`
(verified at all five sites), so "the key names a barrel export holding that value" is precisely
the invariant the textual coupling rests on. A ninth constant added to the record but not
re-exported fails here, loudly, at the push gate.

Keep the existing empty-allowlist throw. Update the check's `hint` ("include it in the
IMPERATIVE_PUBLIC_TABLES array" → record).

No new check id and no new `check/` directory: this check already owns the "the allowlist can
never drift from reality" invariant and already throws on a vacuous allowlist.

### 6. Close the read-set landmine

Both checks move from reading a file to importing a module — making it **code, invisible to the
`FileSystemView`**. Neither check is `inputKeyed` today (`imperative-create-table-allowlisted`
has `cacheSignature: () => null`; `table-defs-in-schema-glob` uses legacy whole-tree keying), so
this is a forward landmine, not a live bug — the same one the schema-glob change closed rather
than deferred.

**Edit** `plugins/framework/plugins/tooling/plugins/checks/core/read-set.ts` — append to
`CHECK_SOURCE_PREFIXES` (currently lines 220–226), with a sentence in the existing comment block
mirroring the `plugins/database/plugins/migrations/core/` rationale directly above it:

```ts
  "plugins/database/plugins/derived-views/core/",
```

Scoped to `core/` only — **not** the whole plugin, whose `server/` tree holds the rebuild logic
and would flip `sourceHash` for reasons unrelated to any check's verdict.

### 7. Tests

- `…/table-defs-in-schema-glob/check/table-defs-in-schema-glob.test.ts` — delete the
  `parseImperativeTableNameConsts` import, the `IMPERATIVE_TABLES_SOURCE` fixture and its two
  parser tests. The three `isImperativeReadHandle` tests stay; feed them a literal
  `new Set([...])` instead of the parser's output. Fix the header docstring.
- `plugins/database/plugins/migrations/check/imperative-create-table-allowlisted.test.ts` —
  delete the three `parseAllowlistIdentifiers` tests and their fixture source; add tests for
  `allowlistIdentifiers`: happy path returns the keys; a key absent from `exports` throws; a key
  whose export holds a *different* value throws; an empty mapping throws. `usesThrowawayTestDb`
  and `findOffenders` tests are untouched.

### 8. Docs

- `plugins/database/plugins/derived-views/CLAUDE.md` — the autogen block gains the two new
  exports (regenerated by build, don't hand-edit). Add a short hand-written paragraph on why the
  allowlist is a record and why the shorthand form is load-bearing.
- `…/checks/plugins/table-defs-in-schema-glob/CLAUDE.md` — its "Imperative-table read handles are
  exempt" section says the constants are "read from the same single-source allowlist"; reword to
  name `IMPERATIVE_PUBLIC_TABLE_CONSTS` and drop the file-path-as-text framing.
- `plugins/database/plugins/db-test-fixture/CLAUDE.md` — check its
  `IMPERATIVE_PUBLIC_TABLES` mention for "array" wording.
- `docs/plugins-details.md` / `docs/plugins-compact.md` — autogenerated by `./equin build`,
  enforced by `plugins-doc-in-sync`.

## Considered and rejected

- **A `parse-utils` helper for "identifiers in a const's array literal"** (masked source +
  `matchBracket` + fail-loud on a non-identifier element). This is the *correct* fix if the parse
  must exist — but it does not have to. Publishing the names as data removes both parsers
  entirely; adding a shared parser would keep two consumers depending on the module's *text*, and
  grow the parse-utils API for a need that no longer exists.
- **A `no-adhoc-array-literal-scan` lint rule** (sibling to `no-adhoc-binding-scan`). The
  reintroduction path is closed at the source once the names are published, and the two deleted
  parsers have no shared regex tell — one is a regex, the other `indexOf`-based — so a rule would
  catch at most one of the two shapes it is meant to prevent.
- **Keeping the array and adding a parallel `IMPERATIVE_PUBLIC_TABLE_CONSTS` string list.** A
  second hand-maintained list that can silently drift from the first — the exact defect being
  removed.

## Verification

```bash
# Baseline BEFORE editing — the two derived sets must be identical after.
bun -e 'import {IMPERATIVE_PUBLIC_TABLES} from "./plugins/database/plugins/derived-views/core"; \
        console.log([...IMPERATIVE_PUBLIC_TABLES].sort().join("\n"))' > /tmp/imperative-before.txt

bun test plugins/database/plugins/migrations/check/imperative-create-table-allowlisted.test.ts
bun test plugins/database/plugins/migrations/check/orphaned-tables.test.ts
bun test plugins/framework/plugins/tooling/plugins/checks/plugins/table-defs-in-schema-glob/check
bun test plugins/framework/plugins/tooling/plugins/checks/core   # read-set roundtrip

./equin check imperative-create-table-allowlisted table-defs-in-schema-glob \
                    type-check plugin-boundaries plugin-refs-resolve plugins-doc-in-sync
./equin build && ./equin check   # orphaned-db-tables needs a live worktree DB
```

`orphaned-db-tables` is the load-bearing end-to-end proof for the *values* projection (it diffs
the allowlist against the live DB); the full `./equin check` after a build is what runs it.

### Deliberate-divergence experiments (revert each)

- **E1 — the shorthand guard bites.** Change one entry to `{ FOO: MIGRATIONS_TABLE_NAME }` →
  `imperative-create-table-allowlisted` must fail naming `FOO` as not an exported constant.
  Contrast on the pre-change tree: the same edit makes `parseAllowlistIdentifiers` return
  `{FOO, MIGRATIONS_TABLE_NAME}` (its `[A-Z][A-Z0-9_]+` matches both) and everything passes.
- **E2 — the truncation hazard is gone.** On the pre-change tree, adding an element whose line
  contains a `]` (or moving the array behind a prose mention of `IMPERATIVE_PUBLIC_TABLES = [`)
  silently narrows one or both parsers while both checks keep passing. After the change there is
  nothing to truncate — assert by confirming neither check reads the file's text
  (`rg -n 'imperative-tables' plugins/*/plugins/*/check plugins/framework -g '*.ts'` returns no
  path-as-string hit).
- **E3 — a dropped exemption is still loud.** Remove `TASK_LATEST_CONVERSATION_TABLE` from the
  record → `table-defs-in-schema-glob` must flag
  `plugins/conversations/plugins/agents/server/internal/rollup-table.ts:13`, and
  `imperative-create-table-allowlisted` must flag `rollup-spec.ts:27`. Confirms the exemption is
  actually wired to the new source.

## Risks

| Risk | How it fails loudly |
|---|---|
| A consumer reads `IMPERATIVE_PUBLIC_TABLES` expecting an array | `tsc` error — there is exactly one such consumer (`computeOrphans`), and it is typed `readonly string[]`. |
| The barrel namespace import pulls weight into the check process | None new: `orphaned-tables.ts` already imports this exact barrel, and `derived-views/core` reaches only `drizzle-orm/pg-core`. |
| A future constant is added to the record but not re-exported from the barrel | `imperative-create-table-allowlisted` fails at the push gate, naming the key. This is the intended behaviour, not a regression. |
| An aliased import (`import { X as Y }`) at a call site defeats the textual match | Pre-existing and unchanged in both checks; fails as a false positive, never a false pass. Out of scope. |
| Over-invalidation from the new `CHECK_SOURCE_PREFIXES` entry | Sound by construction (a superset can only over-invalidate); `derived-views/core/` is four small files that change ~never. |
