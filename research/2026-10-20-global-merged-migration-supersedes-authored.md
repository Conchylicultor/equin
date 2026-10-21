# A merged migration supersedes the migrations it replaced

## Context

On 2026-10-20, worktree `att-1792493943-evj2y1` stopped deploying after its own push:

1. The branch authored `…_38bc8c97__add_sdk_agent_background_tasks.sql` and `…_f09303fa__add_conversation_working_on.sql`. `./singularity build` applied both to the worktree DB, so the ledger (`__singularity_migrations`) has rows for 38bc8c97 and f09303fa.
2. `./singularity push` → `regen-migrations` → `generateMigration({ resetMigration: true })` → `resetBranchLocalMigrations` deleted both files and drizzle re-emitted the same delta as `…_d36c582c__merged_20261020_1154.sql` (same `ADD COLUMN`s, new hash).
3. The next build in that worktree: `planSchemaSteps` (`plugins/database/plugins/migrations/server/internal/runner.ts`) sees d36c582c missing from the ledger and applies its expand phase. That fails with `column "background_tasks" … already exists`, the backend dies, and the gateway reports only `backend exited before ready`.

What is wrong:

- **Identity.** The ledger is keyed by content hash. The regen changes the hash without changing what the migration does, and nothing records that d36c582c replaces 38bc8c97 + f09303fa. This is not specific to push: `./singularity build --reset-migration` in a worktree that already built does the same thing.
- **Misleading warning.** `reportPlan` says an applied hash with no file is "expected if this worktree predates a migration that landed on main". Here it was not expected: the branch had rewritten its own migrations.
- **No recovery.** `./singularity db fork` does nothing when the DB already exists, and agents may not run SQL by hand.
- **Hidden error.** The pg error is only in `~/.singularity/logs/gateway/<wt>.log` (the gateway pumps the backend's stderr there). The runner throws without writing to its `migrations` sink, and the build prints only the gateway's `backend exited before ready`.

Goal: a worktree that keeps working after a push (or a reset) builds again with its data intact. Main, fresh DBs and other worktrees behave exactly as before. When the runner cannot prove the DB is in a safe state, it fails before running any SQL, names the cause, and points to a supported fix.

## Design

### 1. Lineage header: `-- singularity:supersedes`

When `generateMigration` resets branch-local schema migrations, the new schema migration records the hashes of the migrations it replaces. This goes in a header block, the same way the merge-snapshot header works (grammar in `plugins/database/plugins/migrations/core/internal/phases.ts`):

```sql
-- singularity:supersedes 38bc8c97 f09303fa
-- singularity:phase expand
…
```

**Supersessions chain.** A push can regenerate twice without a build in between (checks fail, push again). The new file then replaces `merged1`, which itself replaced `o1` and `o2`. To keep that history, the regen copies the replaced file's own `supersedes` lines into the new file as **inherited edges**:

```sql
-- singularity:supersedes a1b2c3d4            ← direct (merged1)
-- singularity:supersedes a1b2c3d4 <- 38bc8c97 f09303fa   ← inherited edge
```

The parser returns this as `supersedes: { direct: string[]; edges: Map<hash, hash[]> }` on the `phased` arm (the merge-node arm stays empty). The hashes are part of the content, so the filename sha8 still covers them, and the published-immutability check is unaffected.

**Only written when it is sound.** Skipping a migration's SQL on adoption (§2) is safe only if the replaced migrations already did everything the new one does. Inside the reset, `generateMigration` checks this before it writes the header:

- Read the old branch-local **tip snapshot** before the reset deletes it.
- Compute `mergeSnapshots(base = published snapshot the branch chain forked from, ours = old branch tip, theirs = current published tip)`. This reuses `plugins/framework/plugins/cli/plugins/migrations/cli/snapshot-merge.ts`.
- Compare the result with the newly generated snapshot, ignoring `id`, `prevId` and `_meta`.

If they are equal, write the header. If they differ (for example, `schema.ts` was edited after the last build and never generated), do not write the header and print why. The worktree then falls into the loud path of §3. This also covers `--reset-migration` with no movement on main: `theirs` equals `base`, so the check compares the old tip with the new snapshot directly.

### 2. The runner adopts a migration whose lineage is fully applied

In `planSchemaSteps`, each pending phased file that carries `supersedes` is checked:

- `covered(h)` is true when `h` is in the ledger, or when `h` has inherited edges and every one of them is covered.
- **All direct predecessors covered**: the file is **adopted**. It gets a `record` step only, with no expand or contract SQL. Its claimed data migrations are still emitted whole if they are pending, as today. The plan reports it as `adopted: { file, via: string[] }`.
- **None covered**: the file is applied normally. This is the case for main, fresh DBs and every other worktree, so the header changes nothing there.
- **Some covered**: throw before any SQL runs, naming the covered and missing hashes and the recovery command (§4).

This stays pure and portable (pglite and bundled-source hosts run it unchanged). `reportPlan` logs each adoption: `[migrate] adopted <file>: supersedes <hashes>, already applied here`.

### 3. An honest message for an applied hash with no file

`reportPlan` currently prints the same "expected" text for every orphan hash. The new rules:

- **Orphans covered by an adoption, or by an already-applied superseding file**: no warning. They are accounted for.
- **Other orphans**: read the ledger's `file` column too (`getAppliedHashes` becomes hash → file). The message names the file and gives both readings:
  - "on main and your branch is behind: rebase";
  - "a migration this branch authored and then rewrote: the DB keeps its effects; if a pending migration redoes them, re-fork with `./singularity db fork --replace`".

  The runner has no git, so it cannot tell which case applies and must not claim either one.

### 4. Supported recovery: `./singularity db fork --replace`

Add a `--replace` flag to `plugins/framework/plugins/cli/plugins/db/cli/fork.ts`. It drops this worktree's DB and re-forks it from main through the existing durable fork path (`database/fork`, `database/admin`).

- It refuses to run on the `singularity` DB.
- It warns that worktree-only data is lost.

Every loud failure in §2 and §3 names this command. Update the `db` group's description; it currently says the group has one subcommand and that fork is idempotent.

### 5. Make the boot error visible

- **Runner**: in `runSteps`, publish the failure to the `migrations` sink (stderr stream) before rethrowing, so `logs/migrations.jsonl` holds `migration <file> (<phase>) failed to apply: <pg error>`. Also publish a plan-time throw, such as a partial lineage (§2) or a bad claim.
- **Gateway**: when `waitReady` returns `backend exited before ready`, attach the backend's last stderr lines from `w.logBuf.Tail(n, "stderr")`. `Tail` already exists in `gateway/logring.go` and nothing calls it. That text becomes the restart 500 body, which `restartBackend` in `plugins/framework/plugins/cli/plugins/build/cli/internal/deploy-namespace.ts` already prints. This fixes the problem for every boot crash, not just migrations.

### 6. Checks and docs

- `migration-phases-valid`:
  - a `supersedes` header is allowed only on a branch-local schema migration;
  - hashes must be 8 hex characters;
  - an inherited edge's parent must be reachable from a direct entry.
- The phases grammar tests cover parse, render and the round trip.
- `plugins/database/plugins/migrations/CLAUDE.md`: new section **Supersession (regen keeps identity)**.
- `regen-migrations/CLAUDE.md`: one paragraph on the header and the soundness check.

## Critical files

- `plugins/database/plugins/migrations/core/internal/phases.ts` — header grammar: parse and render `supersedes`
- `plugins/database/plugins/migrations/server/internal/runner.ts` — coverage in `planSchemaSteps`, the `adopted` arm, `reportPlan` messages, ledger `file` read, sink publish on failure
- `plugins/framework/plugins/cli/plugins/migrations/cli/migrations.ts`:
  - `resetBranchLocalMigrations` returns the removed hashes, inherited edges and old tip snapshot;
  - `phaseGeneratedMigrations` takes the lineage;
  - the soundness check uses `snapshot-merge.ts`
- `plugins/framework/plugins/cli/plugins/db/cli/{index,fork}.ts` — `--replace`
- `gateway/worktree.go` — stderr tail on early exit
- `plugins/database/plugins/migrations/check/migration-phases-valid.ts`

## Verification

**Unit tests** (`./singularity test plugins/database/plugins/migrations plugins/framework/plugins/cli/plugins/migrations`):

- `runner.test.ts`:
  - all predecessors applied → only a `record` step;
  - none applied → normal expand/contract;
  - some applied → throws naming the hashes;
  - chained lineage (merged2 ← merged1 ← o1, o2 with only o1 and o2 applied) → adopted;
  - claimed data migrations are still emitted when pending.
- `phases` round trip.
- `migrations.test.ts`:
  - a reset after an in-sync build writes the header;
  - `schema.ts` drifted after the last build → no header;
  - a second reset copies the inherited edges.

**DB test.** `createTestDb`, apply o1 and o2, swap in the merged file, run `runMigrations`: it succeeds and the ledger gains the merged hash.

**End to end in this worktree:**

1. Add a nullable column and build.
2. Run `./singularity regen-migrations` locally. This simulates the push's regen without landing anything.
3. Build again: the log shows `adopted …` and the deploy is healthy at `http://att-1792519856-tz5k6d.localhost:9000`.
4. Revert the column, regen and build to clean up.

**Error surfacing.** Force a failing migration, for example by editing `schema.ts` after a build and regenerating so no header is written:

- the build output shows the pg error through the gateway tail;
- `logs/migrations.jsonl` has the failure line;
- `./singularity db fork --replace` recovers.

**Original worktree.** `att-1792493943-evj2y1` gets nothing automatic: its merged file is already published and has no header. Recover it with `db fork --replace` once that exists.

## Follow-ups (not in this change)

- **A regen that emits nothing.** If the branch's delta landed on main through someone else's migration, the regen produces no file, and main's migration then hits the same duplicate DDL. §3's message and `--replace` cover it; a structural fix is out of scope.
- **Fixture hashes in the worktree ledger.** That worktree's ledger also holds `a1b2c3d4` and `b2c3d4e5`. These look like test-fixture hashes written into a real worktree DB, which suggests a test drove the live ledger. Worth a separate task.
