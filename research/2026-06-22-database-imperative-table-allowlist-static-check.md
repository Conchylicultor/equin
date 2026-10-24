# Static guarantee: imperative public tables must be allowlisted

## Context

A public table created **imperatively** — `CREATE TABLE IF NOT EXISTS …` run
outside drizzle's tracked schema, on boot — is invisible to the drizzle snapshot.
To keep such tables from being flagged as dead schema, every one must be listed in
the `IMPERATIVE_PUBLIC_TABLES` allowlist
(`plugins/database/plugins/derived-views/core/internal/imperative-tables.ts`),
which the `orphaned-db-tables` check
(`plugins/database/plugins/migrations/check/orphaned-tables.ts`) subtracts from the
live table set.

**The problem:** nothing *statically* couples a `CREATE TABLE` call site to the
allowlist. `orphaned-db-tables` is a lagging, environment-dependent detector — it
reads a live DB's `pg_stat_user_tables` (so it only sees a table after the new
code has booted and physically created it) and **soft-passes when it can't reach a
DB**, which is exactly the situation in the `./equin push` checks
subprocess. So an unallowlisted imperative table can be merged to main and only
surface as a broken *later* main build. This just happened with
`live_state_changelog` and `live_state_snapshot`: they landed unallowlisted and
broke a subsequent build.

The allowlist file's own header even *claims* "the sites that create them
reference these constants so the allowlist can never drift from reality" — but
that claim is enforced by nobody. We want it enforced: a DB-free, push-gate check
that makes an unallowlisted imperative `CREATE TABLE` impossible to land.

## Approach

Add one **pure static check** that scans real code for `CREATE TABLE` and fails
unless the statement references an `IMPERATIVE_PUBLIC_TABLES` constant on the same
line. This turns the existing convention into an enforced invariant. It runs at
`build`, `check`, and the **push gate**, needs no DB, and its failure direction is
always safe (a false positive is correctly-allowlisted-but-mis-shaped code, never
a missed orphan).

Why a check (not a lint rule or a type): lint rule files can't import `@plugins/*`
(jiti can't resolve them) so a rule couldn't read the allowlist; and a type-level
union only constrains code that opts into a typed helper — it can't stop a raw
`db.execute(\`CREATE TABLE …\`)`, which is precisely how the bug entered. A
source scan is the only mechanism that catches the raw form. This mirrors the
sibling `data-migration-dml-only` check (default-deny SQL scanning) and the
`no-raw-websocket` check (`grepCode` + path allowlist).

### Mechanism

1. **Resolve the allowlist identifier names.** Read
   `plugins/database/plugins/derived-views/core/internal/imperative-tables.ts`
   from the repo root, isolate the `IMPERATIVE_PUBLIC_TABLES = [ … ]` array body,
   and extract the SCREAMING_CASE identifiers inside it
   (`MIGRATIONS_TABLE_NAME`, `DERIVED_VIEW_STATE_TABLE_NAME`,
   `LIVE_STATE_CHANGELOG_TABLE`, `LIVE_STATE_SNAPSHOT_TABLE`).
   **Throw if zero are found** — refuse to pass vacuously (mirrors
   `declaredTablesFromSnapshot`'s empty-set guard in `orphaned-tables.ts`).
   Using the array's *members* (not just any exported const) means a constant
   that's defined but not added to the array won't satisfy a create site — so
   "add the constant" and "add it to the array" are both forced.

2. **Find real-code `CREATE TABLE` matches.** Use `grepCode`
   (`@plugins/framework/plugins/tooling/plugins/checks/core`) with
   `pattern: /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\b/i`, `grepArg: "CREATE"`,
   `maskStrings: false`. `maskStrings:false` is load-bearing: the DDL lives
   inside a JS template string, and `maskSource` masks comments *always* but
   preserves string interiors only when `strings:false` — so the comment mentions
   in `rank/core/internal/types.ts` and `data-migration-dml-only` are excluded,
   while the four real template-string DDL sites survive. (Confirmed:
   `maskSource` treats a backtick literal as one verbatim span under
   `strings:false`, so both `CREATE TABLE` and the `${CONST}` identifier remain on
   the line.) `UNLOGGED` is included because unlogged tables persist in
   `pg_stat_user_tables` (orphan-able); `TEMP`/`TEMPORARY` are intentionally not
   matched (session-scoped, never persistent orphans — none exist today).

3. **Flag offenders.** For each match, after dropping `ALLOWED_PATHS` (the check's
   own `*.test.ts` fixture file, following the `no-raw-websocket` precedent),
   require the matched line to contain at least one allowlist identifier. Any line
   that doesn't is an offender reported as `path:line:text`. Because each of the
   four real sites interpolates its allowlist constant as the table name *on the
   `CREATE TABLE` line*, they all pass; a bare `CREATE TABLE foo (…)` or a
   `CREATE TABLE … ${SOME_OTHER_CONST}` fails.

4. **`cacheSignature: () => null`** — the scan is sub-second (one `git grep -l`
   narrows to a handful of files); never risk a stale PASS on a correctness gate.

The enforced convention — *"an imperative `CREATE TABLE` must interpolate an
`IMPERATIVE_PUBLIC_TABLES` constant by its canonical name, inline on the
`CREATE TABLE` line"* — is stated in the failure `hint` and the check's CLAUDE.md.
All four current sites already satisfy it; it is also the convention the allowlist
file already documents.

### Files

- **New:** `plugins/database/plugins/migrations/check/imperative-create-table-allowlisted.ts`
  — the check. Export a pure helper `findOffenders(matches, allowlistIds)` and a
  pure `parseAllowlistIdentifiers(src)` for unit testing.
- **Edit:** `plugins/database/plugins/migrations/check/index.ts` — append the new
  check to the existing `export default [check, orphanedTablesCheck]` array. The
  `database/plugins/migrations` check plugin is **already registered** in
  `check.generated.ts`, so appending to its array needs **no registry
  regeneration** — the new check rides the existing entry. (Placing it here also
  colocates it with its complementary lagging detector, `orphaned-tables`. The
  alternative home — `derived-views/check/`, the allowlist's owner — would be a
  *new* check directory requiring `check.generated.ts` regen; not worth the extra
  surface for this.)
- **New:** `plugins/database/plugins/migrations/check/imperative-create-table-allowlisted.test.ts`
  — `bun:test` over the pure helpers (synthetic `CodeMatch[]` + sample source).
  Avoid a bare literal `CREATE TABLE` substring in scanned source (or rely on the
  `ALLOWED_PATHS` exemption of this file).
- **Edit (docs):** `plugins/database/plugins/migrations/CLAUDE.md` (or a short note
  in the derived-views CLAUDE.md) documenting the enforced same-line convention,
  so the two-part defense (static gate + lagging DB detector) is discoverable.

### Reused utilities

- `grepCode` — `plugins/framework/plugins/tooling/plugins/checks/core/grep-code.ts`
  (real-code matching, comment/string masking, scan-tree-aware).
- `maskSource` — `plugins/plugin-meta/plugins/parse-utils/core/mask-source.ts`
  (used internally by `grepCode`; `strings:false` keeps template-literal DDL
  visible).
- `Check` shape + `ALLOWED_PATHS` pattern — mirror
  `plugins/framework/plugins/tooling/plugins/checks/plugins/no-raw-websocket/check/index.ts`
  and the inlined `Check` type already used in `orphaned-tables.ts`.

## Verification

1. **Unit:** `bun test plugins/database/plugins/migrations/check/imperative-create-table-allowlisted.test.ts`
   — `parseAllowlistIdentifiers` returns the 4 names (and throws on an empty
   array); `findOffenders` passes lines carrying an allowlist identifier and flags
   a bare `CREATE TABLE foo`, a `CREATE TABLE … ${UNKNOWN_CONST}`, and a
   `CREATE UNLOGGED TABLE` without a constant.
2. **Green baseline:** `./equin check imperative-create-table-allowlisted`
   passes on the current tree (all 4 sites reference their constant).
3. **Red proof:** temporarily add `await db.execute(drizzleSql.raw(\`CREATE TABLE
   IF NOT EXISTS rogue_tbl (id int)\`))` to a server file → the check fails with
   `…:rogue_tbl` and the allowlist hint; revert.
4. **Full gate:** `./equin build` (regenerates nothing new for the registry,
   runs all checks) stays green; `./equin check` lists the new check via
   `--list`.
