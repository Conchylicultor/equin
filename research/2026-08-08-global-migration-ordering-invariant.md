# The data/schema migration ordering invariant

## Context

`plugins/infra/plugins/entity-extensions/CLAUDE.md` tells an agent moving a column
onto an extension to **hand-edit the generated schema migration and reorder its
statements** (CREATE TABLE before DROP COLUMN) to preserve data.

`plugins/database/plugins/migrations/CLAUDE.md` says the opposite: *"Never
hand-edit the SQL: it must match the snapshot's DDL, and the push-time hand-edit
detector aborts if it doesn't."* That detector is real —
`assertNoHandEditedBranchLocalMigrations` in
`plugins/framework/plugins/cli/bin/commands/regen-migrations.ts:16`, which
re-hashes every branch-local snapshot-carrying `.sql` and exits 1 on mismatch.

So the extensions doc leads an agent straight into a push abort, and it is the
doc they reach for while working on an extension. It must be fixed.

But "use `--custom-migration` instead" is not the whole answer either, and
getting only that far is how the next agent lands in the *other* trap. The real
constraint is an ordering invariant that neither doc states.

### The invariant

`resetBranchLocalMigrations`
(`plugins/framework/plugins/cli/bin/migrations.ts:572`) deletes **every**
branch-local schema migration (snapshot-carrying, absent from `origin/main`) and
**preserves** data migrations (snapshot-less) at their original timestamps —
lines 591-594 are the explicit carve-out. `generateMigration` then re-emits one
consolidated schema migration stamped `timestampNow()`, i.e. *after* everything
already on disk. The runner applies in filename-timestamp order.

> **A branch-local data migration may only depend on schema that is already on
> `origin/main`.** It may be ordered *before* a branch-local schema migration;
> it can never be ordered *after* one, because the reset moves every branch-local
> schema migration to the end.

This reset fires on `--reset-migration` and on push's post-rebase
`regen-migrations` normalize pass — the latter whenever main added a migration
concurrently. So a `schema → data → schema` sequence on one branch builds fine
locally and passes checks, then breaks at push **only when main happened to
move**. The failure is loud (`migration-applies-clean` dry-runs the pending delta
against main) but late, and it surfaces as a raw `relation "…" does not exist`
naming the backfill file, with nothing pointing at the ordering as the cause.

The user hit exactly this migrating `conversations/conversation-category` off a
1:1 extension onto a child table. The working procedure was **two pushes**, and
they wrote the reasoning into the migration itself
(`data/20260808_014745_0e6cb898__backfill_conversation_category_rows.sql:11-16`):

> *"Ordering is why this is a second push rather than a second statement: `push`
> regenerates branch-local SCHEMA migrations into one stamped at push time while
> leaving DATA migrations at theirs, so a backfill can never be ordered after a
> table its own branch creates."*

That knowledge currently exists only in a SQL comment.

### Intended outcome

1. The extensions doc stops recommending a procedure that aborts at push.
2. The invariant is stated once, in the plugin that owns it, and both the
   "backfill before a schema change" and "backfill needs schema this branch
   creates" cases fall out of it.
3. The unsafe ordering fails at **build** time with a diagnosis, instead of at
   push time with a pg error.

## Changes

### 1. New check: `data-migration-reset-stable`

**Where:** `plugins/database/plugins/migrations/check/data-migration-reset-stable.ts`,
a sibling of `migration-applies-clean` — the late catcher it front-runs. Added to
the default-exported array in
`plugins/database/plugins/migrations/check/index.ts`.

This location is deliberate. Check discovery is by directory convention
(`<plugin>/check/index.ts`) but is *realized* through a generated file,
`plugins/framework/plugins/tooling/plugins/checks/core/check.generated.ts`, with
`plugins-registry-in-sync` failing on drift. A new sub-plugin under
`tooling/checks/plugins/<name>/` would therefore need its own `package.json` and
`CLAUDE.md` plus a regenerated `check.generated.ts` entry. Appending to the array
in a `check/index.ts` that is **already** a collected-dir entry needs none of
that — no new plugin, no generated-file churn — and it puts the check in the
plugin that owns the invariant, next to the check it front-runs.

**Rule.** Classify each `.sql` in `data/`:

- *branch-local* — basename absent from `git ls-tree -r --name-only origin/main -- <data dir>`
- *schema* vs *data* — presence of `meta/<tag>_snapshot.json`

Fail if any branch-local **data** migration is timestamped **after** any
branch-local **schema** migration. That is precisely the set of orderings a reset
does not preserve.

**Message** names the offending pair — the backfill and the schema migration it
currently sits after — and states that push will restamp the schema one later, so
the order on disk is not the order that will apply.

**Hint has two arms**, because the check cannot tell whether the dependency is
real:

- *The backfill does not depend on this branch's schema change* (a false
  positive — unrelated column add + unrelated backfill on one branch): run
  `./equin build --reset-migration --migration-name <slug>` to restamp the
  schema migration after it. That is exactly what push would do anyway, so the
  remediation is one command and harmless.
- *The backfill does depend on it:* split into two pushes — expand, then
  migrate + contract. Point at `migrations/CLAUDE.md`.

The two-armed hint is what makes the false-positive cost acceptable and is the
reason this is an error rather than a warning.

**Shape.** Follow `orphaned-tables.ts` byte-for-byte where it applies:

- Inlined local `CheckResult` / `Check` types (the convention across every check
  in this folder — `index.ts:22`, `orphaned-tables.ts:18` — kept to avoid a
  cross-plugin import of the framework `Check` type from a check file).
- `DATA_DIR` / `META_DIR` from `import.meta.dir` (`orphaned-tables.ts:29`).
- `MIGRATION_RE` inlined, same comment as `orphaned-tables.ts:36`.
- Branch-local set via `spawnCaptured(["git", "ls-tree", …])` + `getWorktreeRoot`
  from `@plugins/infra/plugins/spawn/core`, as `migration-applies-clean` does.
  **Do not** import `listTrackedMigrationBasenames` from
  `@plugins/framework/plugins/cli/bin/migrations.ts` — that is a `bin/` path, not
  a runtime barrel, so it is not a legal cross-plugin import.
- `cacheSignature()` mirroring `index.ts:47` (data dir content + `origin/main`
  rev), same best-effort degrade-to-null.

**Pure core, exported for test:**

```ts
export function findResetUnstablePairs(
  files: string[],                 // .sql basenames in data/
  hasSnapshot: (tag: string) => boolean,
  isTracked: (basename: string) => boolean,
): Array<{ dataMigration: string; afterSchemaMigration: string }>
```

Everything impure (git, readdir) stays in `run()`.

**Test:** `check/data-migration-reset-stable.test.ts`, `bun:test`, importing the
pure helper only — mirroring `orphaned-tables.test.ts`. Cases: safe
data-then-schema ordering passes; schema-then-data fails and names the pair;
migrations tracked on main are ignored on both sides; a branch with only data
migrations passes; a branch with only schema migrations passes.

### 2. `plugins/database/plugins/migrations/CLAUDE.md` — state the invariant

Generalize the existing **"Backfill that must precede a schema change"** section
(currently lines 44-62) into one section that opens with the invariant, then
gives its two consequences. Keep the existing numbered `--custom-migration` →
`--reset-migration` recipe verbatim as the first case; it is correct and
reset-safe.

Add the second case: **the backfill needs schema this branch creates.** Not
expressible in one push — expand → migrate → contract across two:

- Push 1 (expand): add the new table/column in `schema.ts`, leave the old shape
  in place. Both coexist.
- Push 2 (migrate + contract): `--custom-migration` backfill (its dependencies
  are now on main), then remove the old shape from `schema.ts`. The backfill is
  timestamped before the branch's DROP, and a reset only pushes the DROP later —
  still safe.

Name both guards: `data-migration-reset-stable` (build, diagnosis) and
`migration-applies-clean` (push, ground truth).

Backfills must be idempotent — they are re-hashed and re-applied whenever their
content changes (`rehashBranchLocalDataMigrations`, `migrations.ts:532`). Already
covered in `server-core/CLAUDE.md` Gotchas; cross-reference rather than restate.

### 3. `plugins/infra/plugins/entity-extensions/CLAUDE.md` — replace the procedure

Delete the 5-step hand-edit recipe (lines 77-87) entirely. Replace with a short
section that:

- Covers **both directions** — onto an extension and off one. The user's case was
  the latter; the invariant is symmetric and the current title
  ("moving an existing column to an extension") is why the reverse case had no
  home.
- Gives the two-push expand → migrate → contract sequence with concrete commands.
- States the one-line reason (a backfill cannot depend on schema its own branch
  creates) and defers to `migrations/CLAUDE.md` for the mechanism. This doc must
  not restate migration mechanics — restating it is how it went stale.
- Keeps the existing "if no data needs preserving, accept the auto-generated
  migration as-is" escape hatch, which is still true and still the common case.

Line 37's parenthetical *"(generated migrations are never hand-edited)"* is
already correct and stays.

## Non-goals

- No change to the reset behaviour itself. Restamping branch-local schema
  migrations is what makes them Y-fork-proof against a moving main; the data/schema
  asymmetry is the deliberate design (`migrations.ts:591-594`), not a bug.
- No new migration, no schema change, no runtime code touched.

## Verification

```bash
# 1. The check is discovered and green on a tree with no branch-local migrations
./equin check --list | grep data-migration-reset-stable
./equin check data-migration-reset-stable

# 2. Pure-helper unit tests (both runners reported)
./equin test plugins/database/plugins/migrations

# 3. Nothing else regressed
./equin check
./equin build
```

**End-to-end proof the check fires.** Originally planned as scratch migrations
generated on a throwaway branch, then abandoned: cleaning up afterwards would
mean deleting files under `data/`, and `--reset-migration` deliberately preserves
data migrations, so the only exit was `rm` — which the migrations guard blocks,
correctly.

Done instead with a **temp-dir fixture**. `run()` delegates its directory read to
an exported `classifyBranchLocal(dataDir, metaDir, tracked)`, so the
snapshot-presence and tracked-filter rules are exercised against a real
`mkdtempSync` directory (precedent: `signal-origin.test.ts`, `price-table.test.ts`)
and fed straight into `findResetUnstablePairs`. That covers the same seam without
`data/` ever being written to by a test.

The remaining untested surface is only the git plumbing (`trackedBasenames`),
which is exercised live every time the check runs.

**Docs.** `./equin check plugins-doc-in-sync` and `plugins-have-claudemd`
must stay green after both `CLAUDE.md` edits; the autogen blocks at the foot of
each file are regenerated by `./equin build` and must not be hand-edited.
