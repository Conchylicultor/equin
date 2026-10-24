# Remove the Zero sync-engine experiment

## Context

Zero (Rocicorp's sync engine) was a frozen pilot, off by default behind
`SINGULARITY_ZERO_CACHE=1`. It is no longer wanted, but its code still runs
through the repo: two plugins, a per-worktree sidecar the gateway spawns, a
fork exclusion, a Postgres start switch, and cleanup calls in three teardown
paths.

It now blocks the "no free plugin folders" change: every plugin folder must
match an import-rules row, and the cache-service `provision/` step imports its
own `scripts/` folder (which reads `shared/` and `data-dirs/`). That only passed
because `scripts/` had no rules. Removing Zero is cleaner than loosening the
provision rules for a dead experiment.

The outcome: no Zero code, no `@rocicorp/zero` dependency, no Zero objects left
in any database, and no Zero files left on disk.

## What exists today (measured 2026-09-22)

- **Main database (`singularity`)**: schemas `zero`, `zero_0`, `zero_0/cdc`,
  `zero_0/cvr` (~132 MB, almost all in `zero_0/cdc` rows); publications
  `_zero_metadata_0`, `_zero_public_0`; event triggers `zero_ddl_start_0`,
  `zero_ddl_end_0`, which fire on every DDL statement, migrations included.
- **Replication slots**: none on the cluster.
- **Worktree databases (~230)**: forked from main, so each has the Zero schemas
  (DDL only — rows were excluded from the fork), both publications and both
  event triggers.
- **Postgres**: already runs with `wal_level=replica` and no TCP listener (the
  opt-in was off at the last start).
- **Disk**: `~/.singularity/zero/` (177 MB replica + log),
  `~/.singularity/node/24.17.0` (194 MB vendored Node runtime). No
  `worktrees/*/zero/` dirs, no `<name>.zero.pid` files in `sockets/`.
- **User config**: `~/.singularity/config/singularity/apps/debug/shell/*sidebar.origin.jsonc`
  and several worktree copies list `debug.zero-test:zero-test`.

## Plan

### 1. Delete the plugins

- `plugins/database/plugins/zero/` (umbrella `core` with `zeroCacheEnabled` /
  `ZERO_CACHE_PORT`, `cache-service`, `client`).
- `plugins/debug/plugins/zero-test/`.

### 2. Remove the TypeScript wiring

- **Launcher** — `plugins/infra/plugins/launcher/server/internal/boot.ts`: drop
  `zeroCacheSpec`, the `zeroCacheEnabled` import, the `ZeroCacheSpec` import and
  the Stage-2 comment in the database-config updater. Drop the export from
  `launcher/server/index.ts`.
- **Runtime env** — `launcher/core/internal/runtime-env.ts`: remove
  `SINGULARITY_ZERO_CACHE` and `SINGULARITY_ZERO_NODE` from the allowlist, and
  the "ZERO_* for a zero-cache" wording in the header comment.
- **Worktree spec** — `plugins/infra/plugins/worktree/server/internal/spec.ts`:
  delete `ZeroCacheSpec`, the `zeroCache` field and its serialization; fix the
  `removeWorktreeSpec` layout comment. Drop the type export from
  `worktree/server/index.ts`.
- **Build deploy step** —
  `plugins/framework/plugins/cli/plugins/build/cli/internal/deploy-namespace.ts`:
  drop the `zeroCacheSpec` import and the `zeroCache:` field.
- **Teardown paths** — remove the `dropZeroReplicationArtifacts` import and
  call (keep the `databaseExists` guard + `dropDatabase`), and reword the
  comment to drop the slot rationale, in:
  - `plugins/debug/plugins/worktree-cleanup/server/internal/reap.ts`
  - `plugins/infra/plugins/worktree/plugins/reclaim/server/internal/reclaim-namespace.ts`
    (also its header comment naming `database/zero/.../cache-service`)
  - `plugins/build/plugins/serve-composition/server/internal/reset.ts`
- **Embedded Postgres** — `plugins/database/plugins/embedded/scripts/start.ts`:
  always start with `-c listen_addresses=''` (no TCP, default `wal_level`);
  delete the env switch and its comment; the log line drops `tcp=`.
- **Fork plan** — `plugins/database/plugins/admin/server/internal/fork-plan.ts`
  and `admin/CLAUDE.md`: the `zero*` declaration disappears with cache-service.
  Keep the mechanism (globs, `keep: []` → `schema.*`, quoting) — it is generic.
  Reword comments/docs that use Zero as the motivating example into neutral
  terms.
- **Fork plan test** — `fork-plan.test.ts`: the catalog fixture is "main's real
  catalog"; replace the `zero*` family with a neutral hypothetical family (e.g.
  `ext`, `ext_0`, `ext_0/log` with mixed-case tables) so the quoting,
  slash-in-name, overlap and `keep: []` cases stay covered. Update `DECLARED` to
  match.

### 3. Remove the Go gateway wiring

- `gateway/worktree.go`: `ZeroCache` spec field, `ZeroCacheSpec`,
  `ErrZeroCacheDisabled`, the `zeroCache` struct, `activeZero` / `zeroMu`,
  `EnsureZeroCache`, `startZeroCache`, `stopZeroCache` and its two call sites,
  `zeroReadyTimeout`, the replica-path helper, `readZeroSidecar`.
- `gateway/proxy.go`: the `/zero/*` branch, `handleZeroCacheHTTP`,
  `handleZeroCacheWebSocket`, `isZeroPath`, `cloneStrippedURL` (if only used
  there).
- `gateway/registry.go`: the `.zero.pid` orphan reaping in boot reconcile and
  its skip in the socket loop.
- `gateway/env.go`: the `ZERO_PORT` example in the `With` comment (say "a value
  the gateway sets per child").
- `gateway/CLAUDE.md`: drop zero-cache mentions (bullet at line 13, `zeroCache`
  in the UpdateSpec line, the ZERO_* sentence in Backend Contract item 2).
- Run `go vet` / `go test ./...` in `gateway/`.

Note: the running gateway binary keeps its Zero code until the user restarts it
with `./equin start`. That's harmless: new specs just have no
`zeroCache` block, so the old gateway never spawns anything.

### 4. Remove config, generated and doc residue

- `config/apps/debug/shell/sidebar.jsonc`: remove `"debug.zero-test:zero-test"`.
  The build regenerates `sidebar.origin.jsonc`; restamp the override's
  `// @hash` from the new origin (`config-origins-in-sync`).
- `plugins/primitives/plugins/pane/check/identity-snapshot.json`: remove the
  `zero-test` pane entry (or regenerate, if the check offers a regen).
- `plugins/reorder/shared/slot-id-rename.json`: remove the `debug/zero-test`
  entry. `reorderable-slots.generated.ts` is regenerated.
- `singularity` wrapper: delete the `@rocicorp/zero-sqlite3` comment block.
- Prose: `plugins/infra/plugins/launcher/CLAUDE.md` (lines ~83, ~111),
  `plugins/infra/plugins/safe-fetch/plugins/browser-fetch/CLAUDE.md` (the
  zero-cache example — reword or drop).
- Regenerated by `./equin build` (do not hand-edit): `web.generated.ts`,
  `server.generated.ts`, `provision.generated.ts`, `data-dirs.generated.ts`,
  `docs/plugins-*.md`, per-plugin autogen blocks (css/row, scroll, spacing,
  text, loading, pane, live-state, database, debug, apps/debug/shell CLAUDE.md).
- `bun.lock`: `@rocicorp/zero` leaves via the dependency install the build runs.
- Leave `research/` docs as historical record.
- Final sweep: `rg -i 'zero[-_ ]?cache|zeroCache|rocicorp|zero-test|ZERO_(CACHE|NODE|PORT|UPSTREAM|REPLICA)'`
  outside `research/` and `bun.lock` returns nothing.

### 5. One-off cleanup of live state (not committed)

A throwaway script in the scratchpad, run with `./equin run` once, **with
the user's go-ahead, right before the push** — so main's database is clean
before the new code (which no longer excludes `zero*` rows) forks it again.

For every non-template database on the cluster, in its own connection:

```sql
-- abort the whole DB's cleanup if a Zero slot exists (none today; would mean a
-- live zero-cache we did not expect)
SELECT slot_name FROM pg_replication_slots WHERE database = current_database() AND slot_name LIKE 'zero%';
DROP EVENT TRIGGER IF EXISTS zero_ddl_start_0;
DROP EVENT TRIGGER IF EXISTS zero_ddl_end_0;
DROP PUBLICATION IF EXISTS _zero_metadata_0;
DROP PUBLICATION IF EXISTS _zero_public_0;
DROP SCHEMA IF EXISTS "zero_0/cdc", "zero_0/cvr", zero_0, zero CASCADE;
```

Each database in one transaction. Before running, list every `zero%` schema /
`_zero%` publication / `zero%` event trigger per database, and confirm the set
matches what's above (drop anything extra only after looking at it). After,
re-run the listing and expect zero rows everywhere; print a per-DB summary.

Disk and user config, same moment:
- `rm -rf ~/.singularity/zero ~/.singularity/node` (after confirming nothing
  else uses `node/`; only cache-service declared it).
- Remove the `debug.zero-test:zero-test` line from main's user-level
  `~/.singularity/config/singularity/apps/debug/shell/*sidebar.origin.jsonc`
  only if the build's origin regeneration doesn't rewrite them itself (check
  after main rebuilds). Worktree copies go away when those worktrees are reaped.

The script text is recorded in this doc's "Cleanup log" section after it runs.

## Verification

- `./equin build` passes (runs all checks: plugin-boundaries,
  registry/doc in sync, config-origins-in-sync, pane identity, type-check).
- `./equin test plugins/database/plugins/admin` (fork-plan suite).
- `cd gateway && go vet ./... && go test ./...`.
- The deployed worktree app loads; the Debug app sidebar has no Zero test
  entry; `~/.singularity/worktrees/<wt>/spec.json` has no `zeroCache` key.
- After the one-off cleanup: `query_db` on `singularity` and a sample of forks
  shows no `zero%` schemas, publications or event triggers; creating a new
  worktree forks cleanly (fork plan reports no errors).
- The final `rg` sweep from step 4 is empty.

## Cleanup log

Ran 2026-09-22, before the push, from a throwaway `zero-cleanup.sh` (scratchpad,
not committed). It used the Homebrew `psql` client over the embedded cluster's
Unix socket — the embedded Postgres ships only `postgres` / `pg_ctl` / `initdb`.
The repo's `psql` guard was lifted for the run with a `.allow-postgres` file in
the worktree, removed again afterwards.

Per database, in one transaction, and only when the objects found were exactly
the known set (anything else would have been reported and skipped):

```sql
DROP EVENT TRIGGER IF EXISTS zero_ddl_start_0;
DROP EVENT TRIGGER IF EXISTS zero_ddl_end_0;
DROP PUBLICATION IF EXISTS _zero_metadata_0;
DROP PUBLICATION IF EXISTS _zero_public_0;
DROP SCHEMA IF EXISTS "zero_0/cdc", "zero_0/cvr", zero_0, zero CASCADE;
```

Results: 233 databases — 219 carried the full set and were cleaned, 14 were
already clean, 0 skipped, 0 replication slots (checked before starting, the
run aborts if any exist). Afterwards `singularity` reports 0 `zero%` schemas,
0 publications, 0 event triggers, 0 slots.

Disk: removed `~/.singularity/zero` (177 MB) and `~/.singularity/node` (194 MB).

Still to settle on its own: main's user-level
`~/.singularity/config/singularity/apps/debug/shell/*sidebar.origin.jsonc` still
list `debug.zero-test:zero-test`. Those regenerate when main rebuilds after the
push; check them then.
