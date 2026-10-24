# Clone migrations: "published" is a set of trunks, not `origin/main`

> Plan, 2026-09-30. Follow-up to `research/2026-09-20-global-clone-user-git-journey.md`
> (page "[Planned] Installable by others", step 6 "Staying up to date").

## Context

The clone journey made local `main` the clone user's trunk and gave them
`./equin upstream merge`. The migration tooling was never adapted. It still
decides which migrations are "already on main, immutable" from `origin/main` (with
local `main` only as a fallback). In a clone, `origin` is the **author's** repo:
`install.sh` / `git clone` keep that name, and `resolveUpstreamRemote` treats the
unwritable `origin` as upstream. The e2e hides the bug because it renames
`origin` to `upstream`, so `origin/main` does not resolve and the fallback to
`main` kicks in.

**Problem 1 (today, no upstream update needed).** Every migration the user's own
agents landed on local `main` counts as branch-local. Push's forced normalize
(`regen-migrations` → `generateMigration({resetMigration:true})`) and
`--reset-migration` delete those schema migrations and re-emit one consolidated
migration with a new sha8. The runner keys the ledger by sha8
(`plugins/database/plugins/migrations/server/internal/runner.ts` `planMigrations`),
so it re-runs DDL the main DB already applied, and main fails to boot.
`rehashBranchLocalDataMigrations` re-hashes edited data migrations the same way,
and `migration-applies-clean` never takes its fast path.

**Problem 2 (upstream merge).** A naive fix, "compare against local `main`",
breaks the merge instead. `git merge upstream/main` brings in upstream's migrations,
which are absent from local `main`, so push's normalize would delete and regenerate
**them**. Their names change, and the next update brings them back. Beyond that:

- Nothing enforces that a published migration is never deleted, renamed or
  rewritten, on either side.
- The snapshot chain forks at the merge base: user A→U1→U2, upstream A→P1→P2.
  `snapshot-chain-intact` rejects the Y-fork. drizzle-kit diffs against the
  lexicographically last snapshot (`preparePrevSnapshot`), so the next generate
  re-emits the other side's DDL (e.g. `CREATE TABLE` for U's tables), which fails
  on apply.
- When both sides change the same table or column, nothing says so before the
  DB, and there is no resolution path.

Intended outcome: a clone can land its own migrations and take any number of
upstream updates without a migration being renamed, re-run or lost. A real
conflict fails the build and names the table and column involved, before any
database is touched.

## Design

### 1. One definition of "published": `publishedMigrations(root)`

> **A migration is published once it exists on any `main` this checkout knows of:
> local `main`, or `refs/remotes/<any>/main`.**

- **Author:** `main` plus `origin/main`, the same set as today.
- **Clone:** local `main` holds the user's migrations; `origin/main` (or
  `upstream/main`) holds the author's.
- **Fork:** `origin/main` plus `upstream/main`.
- **Upstream merge branch:** upstream's migrations are on `upstream/main`, the
  user's are on `main`. Both are immutable, so the normalize resets nothing.

The union needs no remote classification. It never probes the network and has no
side effects, which matters because checks call it. `resolvePublishTarget` can
run a dry-run push, and `resolveUpstreamRemote` can add a remote, so it calls
neither. Erring toward "published" is safe. The worst case is that a branch
migration that already sits on some remote's `main` is not consolidated, and that
migration really is out there.

For each published basename, the helper also records the ref it came from and
the **merge-base** of that ref with HEAD. The immutability check needs this to
tell "this branch changed a published file" from "this branch is just stale".

Home: `plugins/database/plugins/migrations/core` (new `internal/published.ts`,
spawning git through `infra/spawn/core`). Both consumers can import it: the CLI
`migrations` plugin already imports `migrations/core`, and the `check/` row
allows `core`. It exports:

- `publishedMigrationRefs(root)`: the ordered resolved refs, for cache signatures
  (`rev-parse` of each ref, joined).
- `publishedMigrationBasenames(root)`: the union of `git ls-tree` over those refs.
  It throws when not even `main` resolves (loud, not an empty set).

Call sites replaced (all `["origin/main","main"]` loops and literal `origin/main`):

- `plugins/framework/plugins/cli/plugins/migrations/cli/migrations.ts`:
  `resolveRef`, `resolveMainRef` and `listTrackedMigrationBasenames` are deleted.
  `resetBranchLocalMigrations`, `rehashBranchLocalDataMigrations` and
  `readBranchLocalAnswers` use the helper. The barrel drops the two exports.
- `plugins/framework/plugins/cli/plugins/regen-migrations/cli/run.ts` (both
  guards).
- `plugins/database/plugins/migrations/check/migration-phases-valid.ts`
  (its tracked-basenames loop and `cacheSignature`).
- `migrations.ts` `phaseGeneratedMigrations` call site (claims).
- `plugins/framework/plugins/tooling/plugins/checks/plugins/migration-hashes-unique/check/index.ts`.
- `plugins/database/plugins/migrations/check/index.ts` (`migration-applies-clean`):
  the fast path diffs against **local `main`**, the ref the main DB actually runs,
  not `origin/main`. The same applies to `cacheSignature`.
- `fork-schema-drift.ts`: `cacheSignature` changes; its logic already reads the
  main worktree's files.
- Hint strings (`snapshot-chain-intact`, `fork-schema-drift`, the `migrations.ts`
  collision message, the `migrations` guard) change from
  `git fetch origin main && git rebase origin/main` to "rebase onto `main`". Push
  already fast-forwards local `main` from the publish remote when there is one.

Out of scope: `op-runtime/cli/broadcasts.ts` also reads `origin/main`. It is not
about migrations, and I'll note it as a follow-up.

### 2. Published migrations are immutable: a check

New check `published-migrations-immutable` in
`plugins/database/plugins/migrations/check/`. For every ref R in the published
set, it takes the migration files at `merge-base(HEAD, R)`. Each one (`.sql` and
`meta/*_snapshot.json`) must exist in the working tree **byte-identical**. That
catches deletes, renames and rewrites by this branch, and passes a branch that is
merely behind R. It also asserts that each published `.sql` filename's sha8
matches its content.

This check replaces `assertTrackedMigrationsPresent` in `regen-migrations`, which
calls the same core function so the rule has one spelling. It runs in every push
(author and clone) and in `build`. The `migrations` guard hint points to it.

### 3. Snapshot DAG with merge nodes

**Merge node.** This is a snapshot-bearing migration whose SQL is a no-op header:

```sql
-- singularity:merge-snapshot parents=<snapshotIdA>,<snapshotIdB>
```

Its snapshot has `prevId` set to the parent that sorts last, and its content is
the **3-way merge** of the two tip snapshots against their nearest common
ancestor. It is not the snapshot of `schema.ts`. Because of that, drizzle's
following generate (which diffs against the last-sorting snapshot, now the merge
node) emits exactly the DDL that the merge resolution itself added, if there is
any, and nothing that either side already has. Its SQL is a no-op because each
side's own migrations already apply that side's DDL. That holds on the user's DB
(U applied, P pending) and on a fresh DB (all in timestamp order).

**Where it is made.** In `generateMigration`, after the branch-local reset and
before drizzle-kit, a new step `joinSnapshotTips(migrationsDir)` runs:

- 0–1 tips: no-op.
- More than 1 tip: at this point every tip is published, because the reset
  already consolidated branch-local ones. It 3-way merges the snapshots and
  writes the merge node, stamped so it sorts after every existing migration and
  before the migration drizzle emits next.
- A merge that is not clean fails with a list of conflicting paths such as
  `tables.public.foo.columns.bar.type: ours=text theirs=integer base=varchar`
  and the resolution below.

So `./equin build` in the upstream-merge worktree heals the chain itself,
and so does push's normalize.

**3-way merge** (pure; new `core/internal/snapshot-merge.ts` in the CLI
migrations plugin, unit-tested):

- It recurses over plain objects by key and treats arrays and scalars as leaves.
- For each key: if ours equals base, it takes theirs; if theirs equals base, it
  takes ours; if ours equals theirs, it takes either; otherwise it is a conflict.
- A key **absent from base and added on both sides** is always a conflict, even
  when identical. drizzle emits bare `ADD COLUMN` (103 of 110 in `data/`), so the
  second side's statement fails. `CREATE TABLE IF NOT EXISTS` silently no-ops the
  second side's table, dropping any column only that side declared. The conflict
  is reported at each differing leaf (`….columns.note.type`), or at the added key
  when the two additions are identical.
- `id`, `prevId` and `_meta` (drizzle's rename hints) are excluded.
- A key deleted on one side and modified on the other is a conflict. Examples:
  one side drops a table while the other alters it, or both sides add the same
  column with different types.

**`snapshot-chain-intact` becomes a DAG check.** Edges are `prevId` plus the
merge header's parents. The rules are:

- exactly one root and exactly one tip;
- every snapshot is reachable from the root and reaches the tip;
- no duplicate ids;
- every merge parent exists.

A rebase Y-fork (two tips, no merge node) still fails as it does today. The hint
says: branch-local tip → `--reset-migration`; both tips published → build (which
writes the merge node).

### 4. Semantic conflicts: detect, then resolve by a new migration

These are the resolutions I can guarantee without touching an immutable file.

- **Conflict in the snapshot merge** (same column changed on both sides). The
  build fails with the paths above. The documented resolution is for the agent
  to stop and report, per the upstream task text. The fix is a judgment call:
  which side's shape wins, and whether data moves. The user decides.
- **Conflicts only the DB sees** (for example, upstream's data migration updates
  rows the user's schema no longer has). `migration-applies-clean` already
  dry-runs the pending set against the real main DB, and the task text now names
  it.

In both cases one published migration's SQL cannot run on this DB. The only
real resolution is a **per-checkout supersede**: this checkout records that hash
H is applied by different SQL. That needs a runner change (the ledger records H
when the override runs), so it is **Phase 4, designed only once the repro shows
a real case**, not built speculatively.

`merge-prompt.ts` gains a "Migrations" paragraph:

- the merge node is expected, and build writes it;
- a snapshot conflict or a `migration-applies-clean` failure means stop and
  report it verbatim;
- never delete, rename or edit a file under `migrations/data`.

`plugins/upstream/CLAUDE.md` and `plugins/database/plugins/migrations/CLAUDE.md`
each gain a short section on the published set and on merge nodes.

### 5. Repro: extend `plugins/upstream/e2e/clone-journey.ts`

Today the journey is git-only over a text-file fixture. The migration phase needs
the real tree, because drizzle-kit reads real `schema.ts` files. So it:

1. Clones **this checkout** into the temp dir with `git clone --shared` as
   "upstream". It then clones that as "clone", **keeping the remote name
   `origin`**, which is the real-clone shape and the one that exposes Problem 1.
   The existing text-fixture steps keep their own repos.
2. **Upstream:** adds table `e2e_upstream_probe` to a fixture schema and generates
   its migration via `./equin regen-migrations --name e2e_upstream`
   (subprocess in that tree). It then commits on `main`.
3. **Clone, own work:** on a branch, adds `e2e_clone_probe` and generates. It
   then lands the branch on local `main` through the real push path
   (`./equin push`; the clone is `local`, so no network).
   **Assert:** the clone migration kept its filename.
4. **Clone, second push:** a branch with no migration runs push again (forced
   normalize). **Assert:** `git diff main -- …/migrations/data` reports no delete
   or rename. **This is Problem 1's repro, and it fails today.**
5. **Update:** runs `./equin upstream merge` in a clone worktree, then the
   generate stage. **Assert:**
   - both sides' migration files are byte-identical to their published versions;
   - `snapshot-chain-intact` and `published-migrations-immutable` pass;
   - exactly one new file exists, the merge node, and its SQL is the no-op header;
   - a second generate emits nothing.
6. **Conflict:** a second round where both sides add column `note` to the
   same probe table, as `text` on one side and `integer` on the other. **Assert:**
   the generate stage fails and names
   `tables.public.e2e_…_probe.columns.note.type`.

It asserts on git state and generated files only. The e2e barrel rule allows only
`core` and `e2e` imports, so each CLI step runs as a subprocess. No DB is touched.
The DB consequence (hash-keyed re-apply) follows mechanically and is already
covered by the runner's own tests. The first `./equin` call in the temp
clone installs its dependencies, which makes this the slow part (minutes). That
is acceptable for a manual e2e.

## Interaction with phased migrations (`att-1790685914-2gqm`)

`research/2026-09-29-global-phased-migrations.md` (conv-1790685914-5xqe) landed
as acd4f74e3d, and this branch is rebased onto it. What it changes here:

- **Another `origin/main` consumer.** `phaseGeneratedMigrations` makes a new
  schema migration *claim* every branch-local data migration, where "branch-local"
  means "not on `resolveRef()`". In a clone that makes the user's already-landed
  data migrations claimable (Problem 1 again). After an upstream merge, upstream's
  data migrations become claimable too. §1's helper fixes it: its
  `listTrackedMigrationBasenames(root, ref)` becomes `publishedMigrationBasenames(root)`.
- **`data-migration-reset-stable` is deleted there.** It comes off §1's call-site
  list. The new `migration-phases-valid` check
  (`plugins/database/plugins/migrations/check/migration-phases-valid.ts`) takes
  its place: it carries its own `["origin/main","main"]` loop and an `origin/main`
  cache signature.
- **The merge node must speak the phased grammar.** `migration-phases-valid`
  rejects an unphased branch-local schema migration. So the merge node is written
  as a phased file with empty `expand` and `contract` sections and no claims, and
  it carries the `merge-snapshot` header as a comment the phase parser ignores.
  `planSchemaSteps` then treats it as an empty group.
- **Merged histories still group correctly.** Claims are per file and each side's
  claims point at that side's own files, so interleaving two sides by timestamp
  keeps every "claim sorts before claimer" true. The e2e's step 5 asserts
  `migration-phases-valid` passes after the merge.
- **Better verification for free.** Its from-scratch replay DB test (all of
  `data/` plus `applySchemaLayer` on `createTestDb`) is exactly the "fresh install
  after a merge" path §3 argues about. A unit variant of that test replays a
  history of two interleaved phased sides.
- **Nothing to change in its runner, `applySchemaLayer` or the classifier.** The
  one-transaction layer also makes `migration-applies-clean` an exact dry run of
  boot, which §4 relies on.

## Order of work

1. **Repro first:** e2e steps 1–5, run, and confirm step 4 (and step 5's chain
   assertion) fail on today's code. Record the output in this doc.
2. §1 published set plus call sites, with unit tests for the union and the
   merge-base logic (temp git repos, as `remotes`' tests do). Step 4 turns green.
3. §2 immutability check.
4. §3 snapshot merge, merge node, and the DAG chain check (pure unit tests on
   hand-built snapshot heads). Step 5 turns green, then step 6.
5. §4 prompt and doc updates.
6. Phase 4 (supersede): only if a repro produces a conflict that §4's "stop and
   report" cannot resolve.

## Verification

- `./equin test plugins/database/plugins/migrations plugins/framework/plugins/cli/plugins/migrations plugins/framework/plugins/tooling/plugins/checks/plugins/snapshot-chain-intact`
- `./equin run plugins/upstream/e2e/clone-journey.ts`: every step passes,
  and steps 4–5 were seen failing before the fix.
- `./equin check`: `migration-applies-clean`, `migration-phases-valid`,
  `migration-hashes-unique`, `snapshot-chain-intact` and
  `published-migrations-immutable` all pass on this (author) checkout. This is
  the regression check that the union equals today's set for the author.
- `./equin build` in this worktree, with `build-status.json` reporting
  `status: ok`.

## Critical files

- `plugins/database/plugins/migrations/core/` (new `published.ts` and barrel exports)
- `plugins/framework/plugins/cli/plugins/migrations/cli/migrations.ts`, plus new
  `snapshot-merge.ts`
- `plugins/framework/plugins/cli/plugins/regen-migrations/cli/run.ts`
- `plugins/database/plugins/migrations/check/{index,migration-phases-valid,fork-schema-drift}.ts`,
  plus new `published-immutable.ts`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/{snapshot-chain-intact,migration-hashes-unique}/check/index.ts`
- `plugins/upstream/server/internal/merge-prompt.ts`, `plugins/upstream/e2e/clone-journey.ts`
