# A fresh clone's first build: the cluster is born without its base database

## Context

A from-scratch install in a clean macOS VM on 2026-09-18
([`2026-09-18-global-clean-install-baseline-run-1.md`](./2026-09-18-global-clean-install-baseline-run-1.md))
stopped at the database and never got past it. The gateway started, Postgres
started, and then the first `./equin build --allow-main` waited 60 seconds
and gave up:

```
ERROR: no database for "singularity" and no fork in flight after 60s.
```

Every way forward the app offered was a dead end:

- the error says to run `./equin db fork` — but that command *copies* the
  `singularity` database, so it can never be the thing that creates it, and it
  also needs a backend that is already running;
- `mise run setup`, the only thing in the repo that creates the base database,
  looks for a Postgres on port 5432 while the app's own Postgres is on a socket
  on port 5433, so it prints "Postgres is not running — skipping" and exits 0;
- creating the database by hand is still not enough: the build then crashes with
  `relation "build_runs" does not exist`, because it writes its own ledger row
  before anything has created the schema.

The outcome of this plan is that a new user's first build works: `./equin
start`, then `./equin build --allow-main`, and the app deploys. Other
blockers from the same run — the toolchain check, Claude Code never being
installed — are separate tasks and still sit behind this one.

### Where the gap is

Starting the cluster and creating its base database are one act, and today the
code only does the first half. `plugins/database/plugins/embedded/scripts/start.ts`
— the script the gateway's supervisor runs to bring Postgres up — runs `initdb`,
starts the postmaster, prints `pg: embedded PG ready`, and stops. The cluster it
leaves behind has `postgres` and `template1` in it and nothing else.

Every database in the app is minted from `singularity`: a worktree's is a
`pg_dump | pg_restore` copy of it, `./equin db fork` copies it by name,
and the build waits for that copy to land. Nothing anywhere creates the original.
On a developer's machine it has simply always been there — created years ago by
hand, or by `mise run setup` back when Postgres was a system service on 5432.
The moment the app started shipping its own cluster, the one database that is
nobody's copy lost its owner, and nobody noticed because no existing machine
needed it created again.

## Design

### 1. The cluster comes up with its base database

`plugins/database/plugins/embedded/scripts/start.ts`

After the postmaster is serving, check for the `singularity` database and create
it if absent. Empty — the schema is not this script's business; the first
backend to boot against it runs the migrations, exactly as it already does for
every composition database and for a packaged release's own.

Three properties to get right:

- **After the reattach path too, not only after `initdb`.** The script currently
  returns early when Postgres is already running. Restructure so both paths fall
  through to the same check: then it is true on every gateway start, not just the
  first, and a dropped base database heals instead of turning into the same wall
  a week later.
- **Loud on failure.** The script throws and exits non-zero, which the gateway
  treats as a fatal service-start failure — the same handling `initdb` failing
  already gets. A cluster that cannot hold the app's database should not come up
  pretending it did.
- **Tolerant of the race, not of anything else.** `42P04` (already exists) is
  success; everything else propagates.

This needs a Postgres client, which the script does not have today — the bundled
binaries are `initdb`, `pg_ctl` and `postgres` only, no `psql` and no `createdb`.
Import `pg` and connect over the cluster's own socket (`PG_SOCKET_DIR`,
`PG_PORT`, `PG_USER`, database `postgres`). That is safe in a packaged release:
`bun build --compile` bundles it, and both the compiled backend and the compiled
launcher already depend on `pg` through the same bundler.

**Why this script and not `./equin start`, or the launcher, or the build.**
It is the lowest layer, so it cannot be bypassed by whatever brings the gateway
up — the dev `start`, a release launcher, a restart. And a release gets it for
free: the same file is compiled into the `pg-start` binary a bundle ships.

The database's name is main's namespace. Add `PG_BASE_DATABASE` beside `PG_USER`
in `plugins/database/plugins/embedded/shared/internal/paths.ts` (the script
deliberately imports only node builtins and its own `shared/`), and pin it with a
co-located test asserting it equals `MAIN_WORKTREE_NAME` — a test file can import
both barrels, so the two spellings cannot drift apart silently.

### 2. The build stops waiting for a copy of a database that is nobody's copy

`plugins/framework/plugins/cli/plugins/build/cli/run.ts:1043-1050`

The hoisted database step runs `waitForWorktreeDatabase(name)` whenever a
main-composition target is present. For a worktree that is right: its database is
a fork, made by a job at conversation time, and waiting for it is the correct
thing to do. For the main checkout it is nonsense — there is no fork and no job,
so it burns 60 seconds and then prints advice that could not have worked.

Split on which kind of database the namespace has, using
`(await checkoutRef(root)).kind === "main"` from
`@plugins/infra/plugins/paths/core` — **not** a comparison against the namespace
string. `checkoutRef`'s own docblock warns why, and there is a real collision:
`namespaceFor` gives a linked worktree whose directory happens to be named
`singularity` the same namespace as the main checkout. `root` is already in
scope; `checkoutNamespace(root)` at `run.ts:516` is built from the same call.

- **main checkout** — the base database should already exist, because starting
  the cluster creates it. If it does not, fail immediately (`databaseReady(name)`
  is already there) and say to run `./equin start`. No polling: there is
  nothing in flight to wait for.
- **anything else** — `waitForWorktreeDatabase(name)`, untouched.

The build creates nothing. That is the point of doing step 1: provisioning
storage is not a build's job, and the base database must not depend on someone
having run a build.

This also retires the circular advice properly rather than by rewording it. The
`./equin db fork` message lives inside `waitForWorktreeDatabase`, which is
now only reachable for a namespace whose database really is a fork — the case it
was written for.

**One mode stays the user's.** With `services: []` — the documented "use my own
Postgres" setting — the gateway supervises nothing and this script never runs, so
nothing here provisions inside a cluster the app does not own. The build's new
message names `createdb singularity` in that case, and `docs/setup.md` keeps the
instruction for that path only.

### 3. The build ledger tolerates a database whose schema does not exist yet

`plugins/build/plugins/run-ledger/server/internal/recorder.ts:77, 187, 212`

**Load-bearing, not polish.** Step 1 makes the database exist before its tables
do, so without this the first build trades one crash for another
(`relation "build_runs" does not exist`).

`insertRun` already answers `"unavailable"` — a named outcome, not an error —
when the database is missing (`3D000`), because a checkout that has never been
deployed has no ledger to write to. On the first build ever, the database is
there and the `build_runs` table is not (`42P01`). That is the same fact: no
ledger here yet. The recorder's own docblock already states the ordering that
produces it — the CLI mints this row before the backend restarts and applies
migrations, so it "always runs NEW code against the schema the PREVIOUS build
left behind", and on a first build there is no previous schema at all.

Widen the predicate from "missing database" to "no ledger here yet"
(`3D000` or `42P01`), rename it to match, and apply it in both `insertRun` and
`closeRun`. The soft note the build already prints for `"unavailable"` covers
this case too. Same reading exists a few plugins over:
`plugins/database/plugins/migrations/check/fork-schema-drift.ts:131` and
`orphaned-tables.ts:127` both treat `42P01` as "the migration runner never ran on
this DB".

Only the very first build goes unrecorded. By the time it closes its row the
backend has booted and migrated, and every later build is in the ledger normally.

### 4. `mise run setup` stops claiming to bootstrap the database

`mise.toml`

Its `createdb` / `apply-migrations` half probes a Postgres the app does not use
and is now redundant. Delete it, keeping the `trusted_config_paths` registration
— the part that works and is unrelated. Update the task `description` and the
file's header comment with it: both currently promise the database bootstrap and
claim to "unblock the very first `./equin build --allow-main`", which would
otherwise be a false statement sitting at the top of the file.

Whether `./equin apply-migrations` should survive at all is the separate
apply-migrations task's call; after this change nothing in a fresh install needs
it.

### 5. `docs/setup.md` stops describing paths that do not exist

- Delete the "Auto-migration from system PG" section. That code was removed in
  `48a8bd8c20` ("Drop the legacy migrate-from-system-PG path entirely"); the
  sentinel file and the auto-detect it describes exist nowhere.
- Keep `createdb singularity` **only** in the "Using system PG instead of
  embedded" section, where it is still true. (The instruction appears twice in
  the file today; the second occurrence, in that section's closing line, is easy
  to miss.)
- Say plainly what a first run is: `./equin start`, then
  `./equin build --allow-main` — and that with the bundled Postgres the
  database is created for you.

## Files

| File | Change |
| --- | --- |
| `plugins/database/plugins/embedded/scripts/start.ts` | create the base database once the cluster serves, on every start incl. reattach |
| `plugins/database/plugins/embedded/shared/internal/paths.ts` (+ barrel) | `PG_BASE_DATABASE`, pinned to `MAIN_WORKTREE_NAME` by a test |
| `plugins/framework/plugins/cli/plugins/build/cli/run.ts` | split the hoisted DB step by checkout kind; fail fast for the base DB |
| `plugins/build/plugins/run-ledger/server/internal/recorder.ts` | `3D000` **or** `42P01` ⇒ "no ledger here yet" |
| `mise.toml` | drop the dead DB bootstrap; fix the description and header comment |
| `docs/setup.md` | drop the deleted auto-migration path; state the first-run commands |

Reused as-is, nothing new invented: `checkoutRef`, `databaseReady`,
`readDatabaseConfig`, `runMigrations` at `onReadyBlocking`, and the release
launcher's "empty database, the backend migrates it on boot" contract
(`plugins/infra/plugins/launcher/server/internal/boot.ts:766`).

## What does not change

- The fork path. `database.fork` jobs never target `singularity`, so creating it
  cannot race one or shadow a fork.
- `./equin db fork`'s need for a running backend. A fresh install never
  reaches for it now, and by the time a hand-made `git worktree add` does, main
  is built and answering. Its circularity is real but separate.
- `./equin apply-migrations`, still broken on its first log line — the
  separate task.
- `./equin start`, `bootSelfContainedApp`, and the release launcher: all
  unchanged, because they all go through the same start script.

## An option considered and rejected

Having `./equin build` create the base database, the way it already
creates an empty one for every composition it serves
(`deploy-namespace.ts:482`). Rejected: a build compiles and deploys, and putting
provisioning there makes the base database's existence depend on someone having
run a build. It also would not have helped a packaged release, and it would have
left `./equin start` finishing successfully on a cluster with nothing in
it.

## Verification

**Read before writing:** nothing else in the build touches the database before
the backend boots. `propagateConfigToUser`, the composition marker, the worktree
spec, the build receipts and the profile are all filesystem writes; the
host-admission grants hold no database; drizzle's `generate` diffs files, not a
live schema; and the two checks that do connect (`fork-schema-drift`,
`orphaned-tables`) already decline on `42P01` / `3D000`.

**On this machine, without disturbing it:**

1. `./equin build` from this worktree. The ordinary path must be
   unchanged — the base database already exists, so step 1 is a no-op and step 2
   takes the fork branch exactly as before.
2. `./equin test plugins/build/plugins/run-ledger` — a test beside
   `stale-holder.test.ts`. `createTestDb()` hands back an unmigrated database by
   construction (the fixture applies schema only when the caller calls
   `runMigrations`), so skipping that call and asserting `insertRun` answers
   `"unavailable"` and `closeRun` resolves pins step 3 exactly.
3. `./equin test plugins/database/plugins/embedded` — the
   `PG_BASE_DATABASE` / `MAIN_WORKTREE_NAME` pin.
4. The self-healing property, against a scratch cluster rather than the live one:
   point the start script at a throwaway `SINGULARITY_DIR`, run it twice, and
   confirm it creates the database on the first run, finds it on the second, and
   recreates it after a drop.

**The real proof** is the clean-install harness — `sidequests/clean-install/run.sh`
in a fresh Tart VM, which is what found this. A run costs a VM clone plus ~10
minutes of machine time, and it will still stop further down at the toolchain
check (run-1 finding 8), but it is the only way to see this wall actually gone.
Worth one run once this lands; the `EXPECT_FAIL` marks on steps 12–18 and the
harness-only "apply 255 migrations by hand" step 19 come off in the same pass.
