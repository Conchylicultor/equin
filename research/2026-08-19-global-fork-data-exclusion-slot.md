# Fork data exclusion slot

## Context

Creating a worktree forks the `singularity` database with `pg_dump -Fc | pg_restore`
(`plugins/database/plugins/admin/server/internal/fork.ts`). Four mail tables are excluded
from that copy by a hardcoded array, which the file's own comment flags as a quick fix:

> QUICK FIX: this hardcodes mail's table names into the generic fork path, a knowledge leak
> the database plugin shouldn't own. The clean design (a slot where a plugin declares
> "don't fork my data") is tracked as a follow-up.

This is that follow-up. Three measurements taken against the live cluster on 2026-08-19 say
it is now urgent rather than cosmetic.

**1. A fork takes about eight minutes.** `slow_ops` has 693 recorded `database.fork` job
spans since 2026-07-01: mean **118 s**, max **916 s**. The ten most recent samples run
175 s, 404 s, 474 s, 488 s, 490 s, 500 s, 529 s, 558 s, 602 s, **864 s**. Only ~1.5 % of the
cumulative time is `db-fork-acquire` gate queueing (1.2 M ms of 82 M ms), so this is real
dump/restore work, made slower still by the deliberate `darwinbg` I/O demotion in
`spawn-priority`. The "~18.5 s" figure in `fork-gate.ts`'s comments is stale — it dates from
when the database was small. Every new agent conversation waits this out.

**2. The fork copies ~970 MB to deliver ~32 MB.** Breakdown of main (1816 MB):

| bucket | size | tables |
|---|---|---|
| mail (already excluded) | 845 MB | 10 |
| observability / derived | 809 MB | 11 |
| **everything a worktree actually uses** | **32 MB** | 92 |
| inherited `zero_0/*` (frozen Zero pilot) | 125 MB | — |
| `graphile_worker` (dumped, then dropped) | 2 MB | — |

`traces` alone is 722 MB. It is 7-day debugging evidence with a `perWorktree` retention
sweep — a fork inherits main's traces and no report in that fork ever points at one.

**3. It costs 69 GB of disk.** 171 worktree databases, each 700–970 MB, almost entirely
duplicated `traces`. A live fork was confirmed to carry 688 MB of `traces` and a 64 MB
`zero_0/cdc` schema it will never read.

Beyond size, the copy is **wrong** for two tables:

- `notifications` has no worktree column at all, is a `bootCritical` live-state resource read
  with no scoping, and its TTL job lacks `perWorktree: true` so it runs only on main. A fresh
  fork's bell shows main's undismissed notification history from first boot, forever.
- The single-worktree Slow Ops pane (`slow-ops/server/internal/resources.ts`) selects from
  `_slowOps` with no worktree filter, so a fresh fork's pane shows main's operations.

`build_runs` hit this same class of bug and was fixed by adding a `namespace` column plus
filtering at every read site. Excluding the data at fork time retires it at the source for
new forks. Per the decision recorded below, read-scoping of existing forks is out of scope.

**Intended outcome:** a fork carries ~35 MB instead of ~970 MB, completes in seconds instead
of minutes, and the database plugin names no consumer table.

## Decisions taken

- **Opt-in contribution only.** Mirror the existing `ExcludeFromChangeFeed` precedent; no
  mandatory per-table classification, no size-threshold check.
- **Full exclusion set** — observability + derived live-state tables + whole-schema exclusion
  of `zero*` and `graphile_worker`.
- **Exclusion only.** The `notifications` / `slow_ops` read-scoping bugs are not fixed here
  and no tasks are filed for them.
- **Benchmark as a standalone e2e script**, not a CLI flag or an MCP tool.

## Design

### The slot

New file `plugins/database/plugins/fork/server/internal/exclusion.ts`, mirroring
`plugins/database/plugins/change-feed/server/internal/exclusion.ts` — read that file first
and copy its shape, including the required `reason` field and the `docLabel` option.

```ts
export const ExcludeFromFork = defineServerContribution<{
  table: PgTable | string;
  reason: string;
}>("fork-data-exclusion", { docLabel: (c) => tableLabel(c.table) });

export const ExcludeSchemaFromFork = defineServerContribution<{
  schema: string;
  reason: string;
}>("fork-schema-exclusion", { docLabel: (c) => c.schema });
```

Two tokens because they map to two different `pg_dump` flags (`--exclude-table-data` and
`--exclude-schema`) with different meanings: the first keeps the DDL and drops the rows, the
second drops the schema entirely.

`table` accepts a string as well as a `PgTable` because `live_state_snapshot` and
`live_state_changelog` are created with `CREATE TABLE IF NOT EXISTS`, not drizzle migrations,
so no table object exists. This follows `derived-tables`, whose contribution already takes
`table: string` for the same reason. Prefer the table object everywhere one exists — a rename
stays refactor-safe and a typo is a tsc error.

The slot lives in `database/fork`, not `database/admin`: `admin` stays a pure mechanism that
is told what to exclude, and `fork` owns the policy. Neither imports a consumer plugin, so
the collection-consumer separation holds and no cycle is introduced (`mail-core → database/fork
→ database/admin` runs in the existing direction).

### Threading it into the fork

`forkDatabase` takes the exclusions as a **required parameter** rather than reading the
registry itself:

```ts
export interface ForkExclusions {
  readonly tableData: readonly string[]; // "public.traces"
  readonly schemas: readonly string[];   // "graphile_worker", "zero*"
}
export async function forkDatabase(
  source: string, target: string, exclusions: ForkExclusions,
): Promise<void>
```

This matters. `getContributions()` returns `[]` when `collectContributions()` has not run,
and `collectContributions()` runs only during server boot (`server-core/bin/index.ts`, after
the register phase). A CLI process never calls it. If `forkDatabase` read the registry
internally, `./equin db fork` would silently produce a full 970 MB fork — exactly the
silent-empty-set footgun the change-feed comments warn about. A required parameter forces
every caller to confront where the set comes from.

`database/fork` exports the reader:

```ts
export function forkExclusions(): ForkExclusions   // throws if the registry is empty
```

The throw is deliberate: the declarations below guarantee a non-empty set in any booted
backend, so empty can only mean "contributions were never collected in this process".

Call sites:

- `plugins/database/plugins/fork/server/internal/fork-job.ts` — passes `forkExclusions()`.
  Runs inside a booted backend, so the registry is complete.
- `plugins/framework/plugins/cli/bin/commands/db.ts` (`./equin db fork`) — runs outside
  a backend. Inside the action only (never at module scope — `bin/index.ts` imports every
  command module eagerly), dynamically import `server-core/bin/plugins-active` and call
  `collectContributions(serverEntries)` before `forkExclusions()`. Loading the registry pulls
  in every server plugin as a side effect; verify this command still works end to end. If it
  proves too heavy or side-effectful, make the command fail loudly pointing at the app rather
  than falling back to an unfiltered fork.

In `fork.ts`, replace the hardcoded `EXCLUDE_TABLE_DATA` array and its comment with the
passed-in lists, mapping `tableData` to `--exclude-table-data=` and `schemas` to
`--exclude-schema=`. Delete the post-restore `DROP SCHEMA IF EXISTS graphile_worker CASCADE`
block: excluding the schema at dump time reaches the same end state (Graphile re-migrates
idempotently on first worker start) without copying it first.

### Declarations

Each plugin adds the contribution to its **own** `contributions: [...]` array in its server
`index.ts`, using its own internal table object. The `reason` is a reviewed justification,
not a restatement of the table name.

| declaration | owning plugin |
|---|---|
| `traces` | `debug/trace/engine` |
| `slow_ops` | `debug/slow-ops` |
| `reports` | `reports` |
| `boot_traces` | `debug/boot-profile` |
| `claude_cli_calls` | `infra/claude-cli` |
| `notifications` | `shell/notifications` |
| `live_state_snapshot`, `live_state_changelog` (strings) | `database/live-state-snapshot` |
| `mail_messages`, `mail_threads`, `mail_message_labels`, `mail_attachments` | `apps/mail/mail-core` |
| schema `graphile_worker` | `infra/jobs` |
| schema `zero*` | `database/zero/cache-service` |

The mail rows move from the hardcoded array into `mail-core`'s own declaration — that is the
knowledge leak this plan exists to close.

Exclude `live_state_snapshot` and `live_state_changelog` **together**. The snapshot is a
cold-boot accelerator holding values computed from other tables; leaving it while emptying
`notifications` would make a fork serve main's notifications from the stale persisted blob
even though the table is empty. Emptying both makes that mismatch unrepresentable, and
`live-state-snapshot`'s `boot-init.ts` already degrades to a full recompute when the snapshot
is absent.

Verify the `zero*` pattern matches the four real schemas (`zero`, `zero_0`, `zero_0/cdc`,
`zero_0/cvr`) and nothing else; if it over-matches, declare the exact names instead.

## Benchmark

`plugins/database/plugins/admin/e2e/fork-bench.ts`, run manually with
`bun plugins/database/plugins/admin/e2e/fork-bench.ts [--runs 3]`. Not `*.test.ts` — the test
runner would pick that up.

It drives `./equin db fork <scratch>` as a subprocess and times it with
`performance.now()`, rather than importing `forkDatabase` directly. That way it measures the
real end-to-end path including the exclusion plumbing, and it needs no registry loading of
its own. For each run it should:

1. Mint a scratch name (`forkbench_<rand>`), guarded by the same `/^[a-zA-Z0-9_-]+$/` shape
   `assertSafeName` enforces.
2. Time the `./equin db fork <scratch>` subprocess.
3. Report `pg_database_size(scratch)`, and a per-schema and top-10-table size breakdown, via
   a short-lived client (`openShortLivedClient` from `database/admin/server`).
4. `dropDatabase(scratch)` in a `finally`, so an aborted run leaves nothing behind.

Print min / median / max across runs plus the size breakdown, mirroring the reporting style of
`plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/perf.ts`.

**Capture the baseline before changing anything.** Write and run the script first against the
current fork path; that number is the "before". Expect roughly 970 MB and several minutes.

## Verification

1. `bun …/fork-bench.ts --runs 3` on an unmodified tree — record baseline duration and size.
2. Implement, then `./equin build` (background, per the agent workflow).
3. `bun …/fork-bench.ts --runs 3` again. Expect ~35 MB and a duration in seconds. The size
   check is the real assertion: duration varies with host load.
4. `query_db` against a newly forked worktree DB and confirm `traces`, `notifications`,
   `slow_ops`, `reports`, `claude_cli_calls`, `live_state_snapshot`, `live_state_changelog`
   and `mail_*` are all **present but empty**, that no `zero*` or `graphile_worker` schema
   exists, and that `tasks` / `conversations` / `page_blocks` still hold main's rows.
5. Open the new worktree in the browser and confirm it boots, the notification bell is empty
   rather than showing main's history, and the Slow Ops pane shows only its own operations.
6. `./equin check` — in particular `migrations-in-sync`, `fork-schema-drift` and
   `plugins-doc-in-sync` (the new contributions change the generated plugin docs).
7. Confirm `./equin db fork <name>` still works for a manually-created worktree, since
   it is the one call site that has to load the registry itself.

## Results (measured 2026-08-19)

| | before | after |
|---|---|---|
| fork size | ~824 MB (a real fork on this host) | **34.6 MB** |
| fork duration | mean 118 s over 693 recorded job spans; today's samples 175–864 s | **23.1 / 25.6 / 28.0 s** (min/median/max over 3 runs) |
| `graphile_worker` | copied, then dropped | absent |
| `zero*` | 125 MB in main, 64 MB per fork | 368 kB (DDL only) |

The after-duration is measured end to end through `./equin db fork`, so it
includes CLI startup, the exclusion fetch and process spawn; the before-figure is
the `database.fork` job span alone. The comparison is therefore conservative.

Contents verified on a fresh fork: `traces`, `notifications`, `slow_ops`,
`reports`, `boot_traces`, `claude_cli_calls`, `live_state_snapshot`,
`live_state_changelog` and `mail_*` all present with 0 rows; `tasks` (4254),
`conversations` (4167), `attempts` (3988) and `page_blocks` (1850) intact.

### Two changes forced during implementation

- **The slot lives in `database/admin`, not `database/fork`.** `database/fork`
  imports `shell/notifications` to report a failed fork, and `shell/notifications`
  is itself a declaring plugin — hosting the token there closes a cycle. `admin`
  reaches only two leaf plugins, so nothing can cycle back into it.
- **The CLI reads the set over HTTP, not from a locally-collected registry.**
  Loading the plugin registry in a CLI process imports `@plugins/database/server`,
  whose pool is built at module load and throws without `SINGULARITY_WORKTREE` —
  which is exactly the situation `db fork` exists for. It now asks this checkout's
  own backend first (the exclusion set is a function of the code), falling back to
  main, via `GET /api/db/fork-exclusions`, and fails loudly when neither answers.

### `ExcludeSchemaFromFork` needs a `drop` mode

The first implementation used `--exclude-schema` for both `graphile_worker` and
`zero*`, and the benchmark caught what review did not: `pg_restore` failed on 7
statements. Zero's `_zero_metadata_0` publication and its `zero_ddl_start_0` /
`zero_ddl_end_0` event triggers are **database-level** objects that live outside
the excluded schemas and reference back into them; `pg_dump` emits them regardless.

So the contribution takes a required `drop: "schema" | "data"`. Graphile needs
`"schema"` (it re-runs its own migrations, which would collide with inherited
empty tables); Zero takes `"data"` (`--exclude-table-data=zero*.*`), which skips
the rows and keeps the DDL so nothing can dangle.

## Not in scope

- The `notifications` / `slow_ops` read-scoping bugs, and the inherited rows already sitting
  in the 171 existing forks. Per-worktree retention sweeps age most of them out in 7–30 days;
  `notifications` never sweeps in a fork.
- Reclaiming the existing 69 GB. Once new forks are small, `debug/worktree-cleanup`'s reaper
  handles stale worktrees on its normal schedule.
- Any change to the fork transport itself (parallel dump/restore, dropping compression, or
  copy-on-write cluster cloning). Those stay open once the payload is 35 MB.
