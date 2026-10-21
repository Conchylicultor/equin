# A reset whose delta already landed on main adopts main's migration

Follow-up to [`2026-10-20-global-merged-migration-supersedes-authored.md`](2026-10-20-global-merged-migration-supersedes-authored.md) ("A regen that emits nothing").

## Context

Supersession covers a reset that regenerates a file: the new file names the branch-local hashes it replaced (`-- singularity:supersedes`), and a DB that applied them adopts it. It does not cover a reset that regenerates **nothing**:

1. The branch authored `X` (e.g. `ADD COLUMN c`) and built. The worktree ledger has `X`.
2. Main meanwhile got `P` from someone else — same delta, different hash.
3. Rebase + `--reset-migration` (or push's `regen-migrations`) deletes `X`. Drizzle diffs the schema against main's tip, finds nothing, and writes no file.
4. The next build: `P` is pending in the worktree DB, runs `ADD COLUMN c` again, and the backend crashes.

Today `generateMigration` only prints `warnUnsuperseded` and the runner points to `./singularity db fork --replace`, which loses the worktree's data.

The DB is in a known state: the fork base plus `X`. If that equals the fork base plus some run of main's published migrations, the DB already holds their effects. They can be recorded as applied without running their DDL. This is the same adoption supersession does, but the target is a published file. A published file is immutable, so the lineage needs a file of its own.

## Design

### 1. Grammar: `-- singularity:adopts`

The reset writes a branch-local **adoption file**. It is a phased migration with empty sections, a `supersedes` header naming the deleted hashes (with inherited edges, exactly as `resetLineage` builds them), and an `adopts` header naming the published files whose delta those hashes already applied:

```sql
-- singularity:adopts 5d1f2e3a
-- singularity:supersedes 38bc8c97 f09303fa
-- singularity:phase expand

-- singularity:phase contract
```

`PhasedMigration` gains `adopts: readonly string[]` (empty everywhere else).

The grammar enforces two rules:
- a file with `adopts` must also have `supersedes`;
- its expand and contract sections must be empty, and it claims nothing.

This means the file is a pure record. The hashes are part of the content, so the filename's sha8 covers them.

The file is named `<ts>_<sha8>__adopt_published.sql`. It has no snapshot, so it does not join the snapshot DAG; the journal lists it like any other `.sql`.

### 2. Generator: find the published run that equals the branch's delta

In `reset-lineage.ts`, add `resetAdoption(migrationsDir, prior, published)`. It is called in `generateMigration`'s `added.length === 0` branch, where `warnUnsuperseded` is called today:

- It needs `prior.schema.kind === "known"`: the old tip `O` and the base snapshot `B` the branch forked from. It also needs some deleted hash that is no longer on disk.
- Walk the published snapshot chain back from the published tip to `B`, following `prevId`. The result is an ordered list of published schema migrations `p1…pk`. A merge node splits the list into segments, and a run never crosses one.
- Find the shortest contiguous run `pi…pj` such that `mergeSnapshots(B, O, prev(pi))` succeeds and is equivalent (`equivalentSnapshots`) to `S(pj)`. In words, the branch's delta replayed onto the snapshot before the run equals the snapshot after it. If several runs qualify, take the earliest.
- **Match** → `{ kind: "adopts", adopts: [hash(pi)…hash(pj)], supersedes }`. Write the adoption file and print `adopts <files> (same schema as the deleted <hashes>: a database that applied them records these without running their DDL)`.
- **No match** → `{ kind: "none", reason }`. `warnUnsuperseded` is called with that reason, which can be one of:
  - the delta is split across non-contiguous migrations;
  - main's migration does more than the branch's did;
  - the branch's schema was reverted.

**Why adopting the run and applying the rest is sound.** The run's combined delta equals `X`'s delta rebased onto `prev(pi)`.

- Migrations before the run never created `X`'s objects, or `pi` would have failed on main.
- Migrations after the run ran on main in a state that already had those objects.

So applying every migration outside the run, in order, on `B + X` matches main.

Refactor: the lineage-building block at the end of `resetLineage` (direct hashes and inherited edges from `gone`) becomes a shared `lineageOf(gone)`, used by both `resetLineage` and `resetAdoption`.

Keeping the file through later resets:
- `resetBranchLocalMigrations` already keeps snapshot-less files, so a second regen keeps the adoption file. Its deleted set is then empty, so it writes no second one.
- `phaseGeneratedMigrations` claims snapshot-less branch-local files. It must claim only `legacy`-kind ones, so an adoption file is never claimed.

### 3. Runner: adoption by lineage, onto the named files

In `planSchemaSteps` (`server/internal/runner.ts`), the existing superseding-file loop is extended. For every file with `adopts`, whether pending or applied (an adoption file sorts after its targets, so the decision must be made before the walk):

- Every `adopts` hash must name a phased file on disk that sorts before the adoption file. Otherwise it **throws**, as a bad claim does.
- `lineageState(p.supersedes, applied)`:
  - `adopted`: each pending target is added to `adoptedFiles` and `adopted` with `via`. Its expand and contract are skipped, its claimed data migrations still run, and its ledger row lands. The adoption file itself is recorded; it has no SQL.
  - `partial`: throw with `REFORK_HINT`, as today.
  - `none` (main, fresh DBs, other worktrees): nothing is adopted, and the targets apply normally. The adoption file is recorded as a no-op.
- Its lineage hashes join `superseded`, so `reportPlan`'s orphan warning stays quiet for them.

`reportPlan`'s adoption line names the target and the adoption file: `adopting <P>: <Q> records that <X…>, already applied here, made the same change`.

### 4. Check: `migration-phases-valid`

- An `adopts` header must have a `supersedes` header and empty sections. The parser already enforces this; the check just surfaces parse errors.
- Every `adopts` hash names a published phased schema migration that is on disk and sorts before the adoption file. The check reuses `planSchemaSteps`'s throw, as claims do.
- The existing rule that "a superseded hash must not be on disk" covers adoption files too.

### 5. Docs

- `plugins/database/plugins/migrations/CLAUDE.md`, Supersession section: add a paragraph on adoption files.
- `regen-migrations/CLAUDE.md`: one line.
- `warnUnsuperseded`'s text stays, with the new reasons.

## Critical files

- `plugins/database/plugins/migrations/core/internal/phases.ts`: parsing and rendering of `adopts`
- `plugins/database/plugins/migrations/server/internal/runner.ts`: adoption onto named files
- `plugins/framework/plugins/cli/plugins/migrations/cli/reset-lineage.ts`: `resetAdoption`, `lineageOf`
- `plugins/framework/plugins/cli/plugins/migrations/cli/migrations.ts`:
  - the empty-regen branch writes the adoption file;
  - `phaseGeneratedMigrations` stops claiming it
- `plugins/database/plugins/migrations/check/migration-phases-valid.ts`

## Verification

- `phases.test.ts`: parse/render round trip of `adopts`, and that adopts without supersedes is rejected, as are non-empty sections.
- `runner.test.ts`:
  - `X` applied and `P` and `Q` pending → `P` adopted (only a `record`), `Q` recorded;
  - `X` not applied → `P` applied normally;
  - partial lineage → throws;
  - an `adopts` that names a missing or later file → throws;
  - `P`'s claimed data still runs.
- `reset-lineage.test.ts` (snapshot fixtures):
  - an exact single match;
  - a two-migration contiguous run;
  - main's migration does more → no match;
  - an unrelated migration before the match → match;
  - an inherited lineage is copied.
- `migration-phases-valid.test.ts`: the new rules.
- `./singularity test plugins/database/plugins/migrations plugins/framework/plugins/cli/plugins/migrations`, then `./singularity build` (the checks run inside it).
