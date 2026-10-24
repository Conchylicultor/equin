# Make `_journal.json` a post-condition of the migration pipeline

*2026-08-05 — category: `cli`*

## Context

Pushing a branch that carries a **branch-local data migration** can land a commit
whose `.sql` file has no `_journal.json` entry. It surfaces as
`migration-metadata-consistent` ("`.sql` files with no journal entry") on the
check pass that runs *after* the rebase — i.e. after the commit is already made,
so the push aborts on a tree it created itself. Observed on the quote-container
branch, repaired by hand in `d27cad7af`.

Recovery was also non-obvious: the only way out was to **edit the migration SQL**
so its content hash changed, because journal regeneration is a side effect of a
rename that only happens when the hash drifts.

### Root cause

The journal is *derived*: `regenerateJournal` (`bin/migrations.ts:894`) rebuilds
it entirely from a `readdirSync` of the `.sql` filenames. Verified — run against
the current tree it reproduces the committed file **byte-identically** (222
entries, 40204 bytes).

But it is only ever called as a *side effect of a mutation*, and on a
data-migration-only branch every one of those mutations is skipped:

| call site | why it doesn't fire |
|---|---|
| `rehashBranchLocalDataMigrations` → `if (renamed)` (`:480`) | the `.sql`'s hash already matches its content ⇒ no rename |
| `resetBranchLocalMigrations` (`:543`) | data migrations are deliberately **preserved** (`:516`) ⇒ `removed.length === 0` ⇒ early `return` at `:531`, before the regen |
| `renameMigrations` (`:627`) | drizzle-kit generated nothing (no schema delta) ⇒ `added.length === 0` ⇒ early `return` at `:366`, so `renameMigrations` never runs |

Sequence:

1. Rebase — both sides appended to `_journal.json` → git runs the
   `regen-migrations` merge driver → it takes **main's** side (branch entry gone)
   and drops the `migrations` marker. The `.sql` has a unique filename, so it
   survives.
2. `normalizeGeneratedArtifacts` sees the marker and runs `regen-migrations` —
   which, per the table, is a **complete no-op**.
3. Nothing is dirty ⇒ `normalize` never amends (`normalize-generated.ts:95`) ⇒
   the orphaned commit stands ⇒ the post-rebase check pass fails.

**The defect is not that a derived file is tracked in git — it is that the repair
pass designed to re-derive it is conditional on a mutation that didn't happen.**

### Why `_journal.json` must stay tracked

The tempting "clean" reading is *stop committing a derived file*. That would make
things worse; recording why so nobody re-proposes it:

**The journal's both-sides-modified state is the sentinel that fires the
`regen-migrations` merge driver at all.** A `merge=` driver only runs on a real
both-sides content merge. Of the four patterns routed to it, three
(`data/*.sql`, `meta/*_snapshot.json`, `meta/*_answers.json`) are named
`<YYYYMMDD>_<HHMMSS>_<sha8>__<slug>` — two branches would have to collide on the
same UTC second *and* the same content hash *and* the same slug. The journal is
the one file every migration appends to (confirmed across its git history: it
changes in essentially every migration commit). So *both sides added a migration*
⇔ *journal both-modified* ⇔ *a snapshot-chain Y-fork is possible*. The sentinel
is not merely load-bearing, it is exactly the right predicate.

That marker triggers the whole post-rebase migration normalization — including
the `--reset-migration` snapshot-chain **Y-fork repair** for *schema* migrations.
Untracking the journal would silently disable it and move the same class of late
failure onto `snapshot-chain-intact`. Worse, drizzle-kit would silently recreate
an empty journal (`prepareOutFolder` writes `dryJournal(dialect)` when `meta/` is
absent), so the failure mode would be silence.

Nuance to write down with it: the sentinel covers *snapshot-chain forks*, not
*schema drift*. If main changes `schema.ts` without adding a migration, the
journal is one-sided, no marker fires, no repair runs — and `migrations-in-sync`
is what fails loudly. State this, or someone will later "prove" the sentinel is
incomplete and go hunting for a second trigger.

The journal is also not needed at runtime: the runner
(`plugins/database/plugins/migrations/server/internal/runner.ts:48-59`) globs
`data/*.sql`, sorts on the filename timestamp, and keys applied state on the
filename `sha8` in `__singularity_migrations`. It never opens the journal.

### What the journal actually does for drizzle-kit (verified, corrects an assumption)

Read from `drizzle-kit@0.28.1/bin.cjs`:

- **Prev-snapshot selection is journal-independent** — `preparePrevSnapshot`
  takes `snapshots[snapshots.length - 1]` off a sorted `readdirSync(meta)`. So
  regenerating the journal before `generate` **cannot** change what drizzle
  diffs against.
- **The journal feeds only `idx`** — `const idx = lastEntry === undefined ? 0 :
  lastEntry.idx + 1`. `regenerateJournal` never writes `idx`, so `idx` is
  *already* `NaN` on every run today, and the emitted prefix is `"0NaN"`. That is
  why `DRIZZLE_FORMAT` (`:180`) must accept `0NaN`. Regenerating first changes
  nothing here either.
- **`writeResult` writes `meta/_journal.json` (line 33626) BEFORE
  `<tag>.sql` (line 33627)**, and writes the snapshot as `<prefix>_snapshot.json`
  (`0NaN_snapshot.json`) while the journal entry's tag is `<prefix>_<name>`
  (`0NaN_add_foo`).

The last point yields two findings below.

## Approach

Make the journal a **post-condition of `generateMigration`** rather than a side
effect of mutations inside it. `generateMigration` is the single funnel — its
only callers are `bin/commands/internal/app-artifacts.ts:413` (serving both
`build` and `build-composition`) and `bin/commands/regen-migrations.ts:78`.

Because `regenerateJournal` is a pure function of the on-disk `.sql` set and is
byte-idempotent against the committed file, unconditional calls cost nothing on a
healthy tree and repair a mangled one.

### Step 1 — bookend the pipeline (`plugins/framework/plugins/cli/bin/migrations.ts`)

**Land this before Step 2**, or the abort paths regress.

- **1a.** `regenerateJournal(migrationsDir)` immediately after `:253`
  (`await rehashBranchLocalDataMigrations(...)`). This is the call that fixes the
  reported bug. Its justification is **not** anything about drizzle-kit's inputs
  (see above) — it is that, once Step 2 deletes the two conditional sites, this
  is the only thing re-establishing journal↔filename consistency after reset /
  rehash have renamed or deleted files, and the only regen that runs on the
  `added.length === 0` early return at `:366`. Comment it with *that* reason.
- **1b.** `regenerateJournal(migrationsDir)` after each
  `removeGeneratedFiles(migrationsDir, added)` — `:320`, `:342`, `:370` — see
  Finding D. Prefer a small local `discardGenerated(dir, files)` doing both,
  rather than folding the regen into the exported `removeGeneratedFiles`, whose
  name promises only removal.
- **1c.** `regenerateJournal(migrationsDir)` before the success return at `:442`,
  so the post-condition is visible at the exit instead of inferred from
  `renameMigrations`' own call at `:627`.
- **1d.** Do **not** add one at `:366` — 1a already covers it, and a second there
  would wrongly imply drizzle wrote something.

Use **explicit calls, not `try/finally`**: `process.exit()` does not unwind the
stack, so `finally` never runs — there are six terminal exits downstream of the
mutations (`:285, :293, :309, :332, :353, :385`).

**Finding D — the abort paths already leak an orphan journal entry.** Because
drizzle writes the journal before the `.sql`, and `removeGeneratedFiles` (`:866`)
deletes the `.sql`, the snapshot and the answers sidecar but *never* the journal
entry, each of the three aborts (`:332` prompt-detected, `:353` keyed-unanswered,
`:385` missing `--migration-name`) leaves a working tree failing
`migration-metadata-consistent` with `orphanJournal: ["0NaN_<name>"]`. 1b turns
three latent leaks into no-ops, and is the strongest argument for the
post-condition framing.

### Step 2 — delete the now-redundant conditional call sites

`:480` (`if (renamed) regenerateJournal(...)`) and `:543`, plus the docblocks at
`:455-464` and `:487-493` that promise journal regeneration.

### Step 3 — fix `readPriorSnapshotViewDefs` (`:678-708`)

**Finding E — it is dead code today.** Its docblock claims drizzle "has NOT yet
appended it to `_journal.json`"; that is false for drizzle-kit ≥ 0.28. When
`reorderViewStatements` runs (`:393`), `journal.entries.at(-1).tag` is
`0NaN_<name>`, so the lookup is `meta/0NaN_<name>_snapshot.json` — but drizzle
wrote `meta/0NaN_snapshot.json`. `existsSync` is always false ⇒ it **always
returns an empty Map** ⇒ pure-`DROP VIEW` dependency derivation has silently had
no prior definitions, so a view can be dropped before its dependent. The tests
never caught it because `migrations.test.ts` injects `priorDefs` directly.

Fix by adopting drizzle-kit's own rule: the lexicographically-last
`meta/*_snapshot.json` (the fresh `0NaN_snapshot.json` sorts first, so it
self-excludes). Correct the false docblock.

This is in scope, not adjacent: it removes the last journal *read* inside
`generateMigration`, making "the journal is a pure post-condition, never an
input" literally true — which is the invariant this whole plan documents.

### Step 4 — make a silent drizzle-kit abort loud (unrelated cause, defused in passing)

`prepareOutFolder` collects `readdirSync(meta).filter(it => !it.startsWith("_"))`
— which **includes `meta/*_answers.json`** — and runs each through the pg-schema
validator. A sidecar fails ⇒ `report.malformed` ⇒ drizzle prints
"`<file> data is malformed`" **on stdout** and `process.exit(0)`. Our sniffer at
`:286` matches only `/\b(error|collision|conflict)\b/i`, and `added.length === 0`
then returns quietly at `:366` — so the first `*_answers.json` ever committed
silently stops migration generation repo-wide. `git log --all` shows none has
ever landed, so the landmine is armed but untripped.

Add `malformed` to that regex. One word; it converts a silent stop into a loud
failure, per the fail-loudly rule. Flagged as an unrelated cause so review knows
why it is here — say the word and I file it separately instead.

### Step 5 — close the one guard the fix weakens (`bin/commands/regen-migrations.ts`)

Beside `assertNoHandEditedBranchLocalMigrations` (`:16`), assert every basename
from `listTrackedMigrationBasenames(root, ref)` is still present on disk.
Migrations on main are immutable by contract, so a missing one is always an
error. Without this, deleting a main-tracked *data* migration's `.sql` would now
silently drop its journal entry instead of failing `orphanJournal` (schema
migrations stay covered by `orphanSnapshot`). See Risk 2.

### Step 6 — split pure from impure, and test it

Mirror the precedent already in this file — `reorderViewStatementsInSql` (pure,
exported for tests) wrapping in `reorderViewStatements` (fs):

- export a pure `journalEntriesForSqlFiles(files: string[])`;
- keep `regenerateJournal(migrationsDir)` as the `readdirSync`/`writeFileSync`
  wrapper, exported too so an fs-level test can assert idempotence.

No boundary is crossed: `bin/migrations.ts` is CLI-internal, `cli/core/index.ts`
is untouched, so the autogen block in `cli/CLAUDE.md` doesn't move.

Cases in `plugins/framework/plugins/cli/bin/migrations.test.ts` (`bun:test`;
1-5 pure, 6-7 via `mkdtempSync`, precedent `bin/build-lock.test.ts:14`):

1. only `NEW_FORMAT` names produce entries (`0NaN_foo.sql`, `0001_foo.sql`,
   `README.md` ignored);
2. `when` = `Date.UTC` from the filename — anchor on the real regression:
   `20260804_140946_d4f01c6e__quote_anchor_split` → `1785852586000`, the exact
   entry `d27cad7af` restored by hand;
3. entry shape — `version: "7"`, `hash` = filename sha8, `breakpoints: true`, and
   **no `idx` key** (the `idx+1 → NaN → "0NaN"` prefix is load-bearing; assert it
   so nobody "helpfully" adds `idx`);
4. ordering is full-filename sort; two files sharing `YYYYMMDD_HHMMSS` order by
   sha8;
5. a snapshot-less data migration still gets an entry (the `J ⊆ N` non-invariant);
6. fs: a `data/` fixture with two `.sql` and a journal missing one — the exact
   post-merge-driver state — then `regenerateJournal(dir)`; assert both tags
   present and sorted, and that a **second** call is byte-identical;
7. fs: journal seeded with an orphan `0NaN_foo` entry (Finding D) → regen drops it.

A cross-module test asserting `classifyMigrationMetadata` agrees with
`journalEntriesForSqlFiles` was considered and **dropped**: the check plugin
would have to import `cli/bin/migrations`, which is not a runtime barrel, so
`plugin-boundaries` forbids it. The contract stays pinned in the CLI test file.

### Step 7 — documentation

- `.../migration-metadata-consistent/check/index.ts:97-105` — the hint points at
  `--reset-migration`, which does not repair an orphan `.sql`. Correct remedy is
  now plain `./equin build` (or `./equin normalize-generated`).
- `.../migration-metadata-consistent/CLAUDE.md` — delete "(a normal `build` does
  not regenerate the journal — only `--reset-migration`/rename does)" and state
  the new contract *and its consequence*: `J === S` is now a post-condition of
  every `generateMigration`, so this check degrades to a backstop for trees that
  were never built. Don't pretend its power is unchanged.
- `plugins/framework/plugins/cli/CLAUDE.md`, "Generated artifacts across a merge"
  (which already owns the marker contract) — document the **sentinel**: the
  journal is derived, but it is the only artifact under the `regen-migrations`
  patterns that can both-sides-modify, therefore it is the trigger for the entire
  migration normalization pass, therefore it stays tracked. Include the
  "doesn't cover schema drift — `migrations-in-sync` does" nuance. Cross-reference
  from `plugins/database/plugins/migrations/CLAUDE.md`.

## Files touched

- `plugins/framework/plugins/cli/bin/migrations.ts` — the fix (steps 1-4, 6)
- `plugins/framework/plugins/cli/bin/migrations.test.ts` — regression tests
- `plugins/framework/plugins/cli/bin/commands/regen-migrations.ts` — step 5
- `plugins/framework/plugins/tooling/plugins/checks/plugins/migration-metadata-consistent/{check/index.ts,check/index.test.ts,CLAUDE.md}`
- `plugins/framework/plugins/cli/CLAUDE.md`, `plugins/database/plugins/migrations/CLAUDE.md`

Explicitly **not** touched: `.gitattributes`, the merge-driver scripts,
`normalize-generated.ts`, `push.ts`, the runner.

## Known issues recorded but NOT fixed here

- **Timestamp-tie ordering divergence.** `regenerateJournal` sorts full
  filenames (ties broken by sha8) — deterministic. The runner (`runner.ts:55`)
  sorts on `${date}${time}` only, with a stable sort over `readdirSync` order —
  **filesystem-dependent**. `renameMigrations` calls `timestampNow()` *inside*
  its loop at second granularity, so a multi-file rename in one second produces
  exactly such a tie, and journal order and apply order can then differ across
  machines. Fix is making `sortKey` the full filename in `runner.ts`; separate
  change, separate verification.
- **A genuine both-sides edit of a main-tracked `.sql`** is already silently
  resolved to upstream by the merge driver, and the hand-edit detector only
  inspects branch-local files. Pre-existing; this change neither helps nor hurts.

## Outcome (implemented 2026-08-05)

All steps landed as planned, with two deviations:

- The `malformed` sniffer tests the **combined stdout+stderr** buffer, not
  `stderrBuf` — drizzle prints "data is malformed" on stdout, so adding the word
  to the existing stderr-only regex would have caught nothing. It is a separate
  `if` with its own message rather than a fourth alternative in that regex.
- `readPriorSnapshotViewDefs` filters on the `_snapshot.json` suffix *before*
  the `NEW_FORMAT` test. Slicing 14 characters off a `*_answers.json` sidecar
  leaves a `NEW_FORMAT`-shaped stem (`…__quote_answers.json` → `…__quot`), so a
  suffix-free filter would have mistaken a sidecar for the prior snapshot.

Verified: the reproduction below fails exactly as reported, and a plain
`./equin build` restores the journal byte-identically with no SQL edit.
Full `./equin build` green (type-check, plugin-boundaries,
snapshot-chain-intact, migration-metadata-consistent), 30/30 unit tests pass.

Finding D's live repro (a schema change with no `--migration-name`) was **not**
run: it needs a throwaway schema edit through a full build. The repair is covered
by unit test instead, and drizzle's journal-before-`.sql` write order was read
directly from `drizzle-kit@0.28.1/bin.cjs:33619-33627`.

## Verification

1. `bun test plugins/framework/plugins/cli/bin/migrations.test.ts` and
   `./equin test plugins/framework/plugins/tooling/plugins/checks/plugins/migration-metadata-consistent`.
2. `./equin build` on a clean tree → `git status` shows **no** change to
   `_journal.json` (byte-idempotence; zero churn).
3. **Reproduce the bug and prove the repair.** Hand-delete the last entry from
   `_journal.json`, then:
   - `./equin check migration-metadata-consistent` → fails with the orphan
     `.sql` (confirms the starting state);
   - `./equin build` → journal restored, check passes, **without editing
     any SQL**. That is the recovery that was impossible before.
4. **Finding D:** run `./equin build` with a schema change but no
   `--migration-name` (the `:385` abort), then
   `./equin check migration-metadata-consistent` → passes (before the fix
   it reports `orphanJournal: 0NaN_…`).
5. **Finding E:** unit-test `readPriorSnapshotViewDefs`' new selection against a
   fixture `meta/` containing `0NaN_snapshot.json` plus real ones — it must
   return the last *real* snapshot's view defs, not an empty map.
6. `./equin check` full pass — in particular `migrations-in-sync`,
   `snapshot-chain-intact`, `migration-hashes-unique`, `migration-applies-clean`,
   `generated-artifacts-normalized`.
7. **Sentinel still intact** (the property the design depends on, unchanged by
   this plan but worth confirming once): a *schema*-migration branch rebased onto
   a main that added its own migration still fires the `migrations` marker and
   still gets the `--reset-migration` Y-fork repair.
