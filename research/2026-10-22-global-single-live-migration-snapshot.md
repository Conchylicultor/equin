# One live migration snapshot, git as its history

## Context

Every schema migration commits a full drizzle snapshot,
`plugins/database/plugins/migrations/data/meta/<tag>_snapshot.json`. Each one is
about 14k lines and 370 KB. There are 293 of them, 48 MB in total, checked out
in every worktree. Over the last 14 days they account for 550k of the 1.14M
inserted lines. Yet two consecutive snapshots differ by about 36 lines, so
99.7% of each file repeats the one before it. Git's pack absorbs the
duplication. The working tree, review diffs, line stats and release bundles do
not.

No consumer needs the historical bodies on disk:

| Consumer | What it reads |
|---|---|
| drizzle-kit (`stageDrizzleOut`) | The DAG tip only. |
| `migrations-in-sync`, `orphaned-tables` | The tip only. |
| `snapshot-chain-intact`, `migration-metadata-consistent`, `stageDrizzleOut`'s tip test | `id` / `prevId` only (the first 1 KB, `readSnapshotNodes`). |
| `snapshot-join.ts` (merge nodes) | Two tip bodies and their nearest common ancestor. Git can supply all three. |
| Runner, ledger, `migration-applies-clean` | `.sql` only. |
| Six places listed below | Use "has a sibling snapshot" as the test for schema migration vs data migration. |

**Outcome:**

- One mutable `data/meta/schema.snapshot.json` (the tip).
- Lineage recorded in each new schema migration's `.sql` header.
- Older snapshot bodies read from git on demand.

A schema migration's diff then shrinks from about 14k lines to its real delta,
and `meta/` drops from 48 MB to about 400 KB.

## Design

### 1. Files in `data/meta/`

- **`schema.snapshot.json`** is the current tip body. It is drizzle's format
  unchanged, including `id`/`prevId`. It is rewritten in place by each new
  schema migration or merge node.
- **`legacy-snapshots.json`** is frozen at cutover:
  `{ "<tag>": { "id", "prevId" } }` for every pre-cutover schema migration
  (about 293 entries, about 40 KB). It does three jobs:
  - It keeps the schema/data split for legacy `.sql` files, which can never
    gain a header because their sha8 is immutable.
  - It roots the header chain, since its tip id is the first header's parent.
  - It keeps the legacy DAG walkable for clones (§7).
- **`_journal.json`** and **`_*_answers.json`** are unchanged.

### 2. Lineage header (new schema migrations)

This generalises the existing merge header in
`core/internal/phases.ts` (`-- singularity:merge-snapshot parents=…`). No merge
node exists on disk yet, so the grammar can be replaced:

```sql
-- singularity:snapshot id=<uuid> parents=<uuid>            -- ordinary schema migration
-- singularity:snapshot id=<uuid> parents=<uuidA>,<uuidB>   -- merge node
-- singularity:supersedes …
-- singularity:phase expand
…
```

- The header is the first line and sits inside the hashed content. That is
  fine, because only new files carry it.
- `id` is drizzle's emitted `id` for an ordinary migration. For a merge node it
  is `mergeSnapshotId(parents)` (`snapshot-join.ts`).
- **The header *is* the schema-migration marker.** A file is a schema migration
  if it has the header or is a key of `legacy-snapshots.json`. That single
  predicate lives in `core/internal/` as `isSchemaMigration(dataDir, file)`, and
  it replaces every "has sibling snapshot" test:
  - `migrations.ts`: `rehashBranchLocalDataMigrations`,
    `resetBranchLocalMigrations`, `phaseGeneratedMigrations`, and the
    answers-sidecar placement.
  - `regen-migrations/cli/run.ts` (hand-edit detector).
  - `data-migration-dml-only`.
  - `migration-phases-valid`.
  - `classify.test.ts`.
  - The `migration-hashes-unique` hint.
- `parseMigration` and the runner (`server/internal/runner.ts`) skip the line,
  the same way they skip the merge header today.

### 3. The DAG

`readSnapshotNodes` (`core/internal/snapshot-dag.ts`) builds nodes from:

- `legacy-snapshots.json`;
- the `.sql` headers;
- any leftover legacy `meta/<tag>_snapshot.json` heads (the clone transition,
  §7).

Nobody reads JSON bodies anymore. `analyzeSnapshotDag` and `snapshotAncestors`
stay as they are.

One new invariant is added: **`schema.snapshot.json`'s `id` equals the DAG's
single tip**. `snapshot-chain-intact` enforces it, and `stageDrizzleOut`
asserts it. `migration-metadata-consistent` loses its N set (snapshot tags) and
instead checks two things:

- every header id is unique;
- every legacy key has a `.sql`.

### 4. Generation (`framework/cli/plugins/migrations/cli/migrations.ts`, `core/internal/drizzle-stage.ts`)

`stageDrizzleOut`:

- copies `schema.snapshot.json` into the stage as
  `meta/<lastSchemaTag>_snapshot.json`, which is the name drizzle-kit expects
  next to the journal;
- keeps the multi-tip refusal, now computed on the header DAG.

`moveEmittedInto` does three things:

1. It moves the `.sql`.
2. It overwrites `schema.snapshot.json` with the emitted body.
3. It returns the emitted `{id, prevId}`.

`renameMigrations` and `phaseGeneratedMigrations` then stamp the header before
hashing.

- **`--custom`**: the emitted snapshot is simply never moved. This replaces the
  delete at about line 600.
- **`removeGeneratedFiles`**: restores the pre-run `schema.snapshot.json`
  instead of deleting `${idx}_snapshot.json`.

### 5. Reset and rebase

A rebase where only the branch touched `schema.snapshot.json` raises no
conflict, so the merge driver never fires. The fix is that
`resetBranchLocalMigrations` actively restores the published tip rather than
just deleting files:

```
git show $(git merge-base HEAD main):…/schema.snapshot.json
```

Push always resets through `regen-migrations`, so this is the single place to
get it right.

In `.gitattributes`, the line `meta/*_snapshot.json merge=regen-migrations`
becomes `meta/schema.snapshot.json` (keep the legacy glob for the clone
transition). The driver
(`framework/cli/scripts/regen-migrations.sh`) is unchanged: it keeps `%A`,
marks the merge, and regen rewrites the file.

### 6. Merge nodes (`snapshot-join.ts`)

Tip and ancestor bodies come from one resolver, `snapshotBody(id)`, which tries
these sources in order:

1. `schema.snapshot.json` in the working tree, if its id matches.
2. A legacy `meta/<tag>_snapshot.json` in the working tree.
3. Git. For a header id, use the commit that introduced the `.sql` carrying it
   (`git log --diff-filter=A --format=%H -- <sql>`), then
   `git show <c>:…/schema.snapshot.json`. For a legacy id, use
   `git show <rev>:…/meta/<tag>_snapshot.json` at any rev that still has it
   (that commit's parent, or the cutover parent).

If git lacks the object (a shallow clone), the resolver throws loudly and names
the fetch to run. `snapshot-merge.ts` is unchanged. The join writes the merge
`.sql` with its header and the merged body into `schema.snapshot.json`.

### 7. Cutover (one-shot, in the build's `generateMigration`)

When `legacy-snapshots.json` is absent, or legacy `meta/*_snapshot.json` files
are present, the cutover runs these steps:

1. Join any multiple tips with the existing logic, if needed.
2. Write the tip body to `schema.snapshot.json`.
3. Fold every legacy file's `{id, prevId}` into `legacy-snapshots.json`.
4. Delete the legacy snapshot files.

On this repo it runs once, in the implementing branch.

A clone that merges the cutover while holding its own legacy schema migrations
ends up with leftover legacy files and upstream's `schema.snapshot.json`. The
same step folds them in and joins the two tips, with the ancestor body taken
from git (§6).

`legacy-snapshots.json` is append-only. Only the cutover writes it, and
published keys are immutable.

### 8. Published immutability (`core/internal/published-immutable.ts`, `published.ts`)

- Drop the `meta/*_snapshot.json` arm from `isImmutablePath`.
- A published `.sql` stays byte-identical, header included, so its lineage is
  immutable too.
- Add a check: each published key of `legacy-snapshots.json` is unchanged.
- `snapshot-join` asks "is this tip published" by the `.sql` basename that
  carries the id, not by the snapshot filename.

### 9. Smaller follow-through

- **Release** (`cli/release/cli/run.ts` ~1250): skip `meta/` in the bundle,
  since the runner reads `.sql` only.
- **`orphaned-tables.ts`**: read `schema.snapshot.json`.
- **`upstream/e2e/migration-journey.ts`**: exclude `schema.snapshot.json` from
  the immutable fingerprint, and change "one new migration" from 2 files to
  1 added plus 1 modified.
- **Prose**: the guard text (`guards/core/guards/migrations.ts`), the hints, the
  upstream merge prompt and the automation origin text.
- **Docs**: rewrite the snapshot sections of `migrations/CLAUDE.md` and the CLI
  migrations `CLAUDE.md`.

## Tests to rewrite

- `drizzle-stage.test.ts`
- `snapshot-dag.test.ts` (node source)
- `published.test.ts` (the edited-snapshot case)
- `snapshot-join.test.ts` (git-backed fixture repo for bodies)
- `migrations.test.ts`
- `classify.test.ts`
- `phases.test.ts`, `migration-phases-valid.test.ts`, `runner.test.ts` (header
  grammar)
- `migration-metadata-consistent/check/index.test.ts`

## Verification

1. `./singularity build` in the branch. The cutover runs, and `meta/` holds only
   `schema.snapshot.json`, `legacy-snapshots.json`, the journal and the answers
   files.
2. `./singularity check` passes, in particular:
   - `snapshot-chain-intact`
   - `migration-metadata-consistent`
   - `migrations-in-sync` (no diff)
   - `published-migrations-immutable`
   - `migration-phases-valid`
   - `data-migration-dml-only`
3. Add a column to a scratch table and build again. Expected result:
   - one new `.sql` with an `id=… parents=<legacy tip>` header;
   - `schema.snapshot.json` changes by tens of lines;
   - `git diff --stat` is small.
4. Exercise the custom and failure paths:
   - `--custom-migration` creates no header and leaves the snapshot untouched.
   - `--reset-migration` restores the tip byte-identical to the merge-base.
5. Run `./singularity test` on `plugins/database/plugins/migrations`,
   `plugins/framework/plugins/cli/plugins/migrations` and
   `plugins/framework/plugins/cli/plugins/regen-migrations`.
6. Run `./singularity run plugins/upstream/e2e/migration-journey.ts`. It covers
   the merge node and the clone transition, with the ancestor body read from
   git.
7. Confirm the boot applies cleanly (`migration-applies-clean`) and that the
   ledger shows no re-applied legacy file.
