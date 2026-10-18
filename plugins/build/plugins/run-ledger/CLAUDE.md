# run-ledger

Lean build-runs ledger leaf: the `build_runs` entity (`_buildRuns`, server)
plus the CLI build-run recorder (`createBuildRunRecorder`, the `cli/` barrel). Extracted out from
behind the heavy `build/server` barrel so the detached `./singularity build` CLI
can record rows without evaluating that graph — importing `build/server` pulls in
`config_v2` (whose module eval resolves its config dir from this process's runtime
namespace, which a CLI has none of) and `shell/notifications`, neither of which
exists in a namespace-less terminal build.

The recorder writes to the DB of the namespace it is HANDED
(`createBuildRunRecorder(ns)` → `openShortLivedClient(ns)` + drizzle), because the
CLI has no runtime namespace of its own and cannot use the namespace-bound `db`. That
namespace is the BUILDING CHECKOUT's — a build's row belongs with the transcript
and profile the same checkout's backend serves. It used to be hardcoded to main's,
which was right while the only rows written were main's deploy and its
compose-serve children. Rows are stamped first-writer-wins
(`where(isNull(finishedAt))`) so the backend's supervised-run `finish` callback
never overwrites the CLI's authoritative close — it still runs, because the bell
and the convergence reconcile hang off it, but the row it finds is already
stamped.

## The entity, and why the CLI never sees it

`buildRunsEntityRef` (`core/internal/entity.ts`) is the `build_runs` entity —
the one record of a build run's fields (`build.history` carries its fields from
it; the runs union's build arm is declared `from` it and picks `targets`,
`commitHash`, `exitCode`). The table is built from it (`defineEntity(ref,
{ pid }, meta)` in `server/internal/tables.ts`); `pid` is its one server field.

`defineEntity` loads the field-storage codegen manifest, which the regenerating
`./singularity build` process may not load
(`cli:codegen-manifests-not-frozen`). So the CLI imports `run-ledger/cli` — the
recorder — and never `run-ledger/server`. Every statement the CLI runs
(`shared/recorder.ts`, `shared/stale-holder.ts`) is hand SQL naming only its own
columns, which the schema-skew rule below demands anyway. The backend shares
`settleDeadInflightRun` through the server barrel.

## One invocation is one row, with N targets

`targets text[]` — `./singularity build --composition sonata website` is ONE
shared build (one install, one codegen, one migration pass, one checks pass, one
transcript, one profile, one verdict), so it is one row rendering
`[sonata] [website]`, not two rows pointing at the same three artifacts. A plain
build is `{singularity}`; the default is derived from `MAIN_COMPOSITION_ID`, and
the `"main"` literal it replaced was a spelling the table itself contradicted
(`namespace` already defaulted to `"singularity"`).

## The CLI's INSERT names its own columns

`insertRun` is a hand-written parameterised `INSERT`, not
`db.insert(_buildRuns).values({…})`. That is deliberate and load-bearing.

The CLI mints this row (`bin/commands/build.ts`, just before
`generateAppSources`) and the migration that call GENERATES is not APPLIED until
the backend restarts at the very end of the build. So the CLI always runs NEW
code against the schema the PREVIOUS build left behind. And drizzle's
`.values()` names **every** column in the table definition, passing `DEFAULT`
for the ones you omitted — measured with `.toSQL()`:

```
insert into "build_runs" ("id","trigger","commit_hash","namespace","targets",
                          "started_at","finished_at","exit_code","pid")
values ($1,$2,$3,$4,default,default,default,default,$5)
```

So the hazard is the TABLE, not the field: **the CLI cannot use the ORM insert
on a table whose drizzle definition has gained any column the deployed schema
lacks** — leaving the field out of `.values()` does not leave the column out of
the statement. That is what produced `42703 column "targets" does not exist`
twice. Naming our own columns makes the write immune to every future column
addition here, so this is the fix, not a workaround.

`closeRun` stays on drizzle: `.set()` names only the assigned columns, so an
UPDATE is already immune (verified the same way).

`targets` is named in the INSERT now that its migration is applied, so a terminal
`--composition sonata` build lands `{sonata}`. That is the standing discipline
for this statement: **add the column, deploy it, and only then name it here** —
one release later, never in the build that creates it.

An array column must be bound with **`sql.param(value)`**, never `${value}`. A
bare array in a `sql` template is drizzle's `in (…)` list form — one placeholder
per element wrapped in parens (`($5, $6)`), a row expression, which Postgres
rejects with `42804 … is of type text[] but expression is of type record`.
`sql.param()` binds it as ONE parameter; the type is then inferred from the
column, so no `::text[]` cast is needed.

`insertRun` has THREE outcomes, not two. `"unavailable"` means there is no
ledger here yet, which Postgres says in two ways: `3D000` (no database at all —
a fresh checkout that has never been deployed, reached legitimately by a
composition-only build) and `42P01` (the database is there and `build_runs` is
not — the machine's very first build, where the base database was created empty
when the cluster started and the schema arrives only when the backend restarts
and migrates at the end of this very build). Both are the same fact, so
`isMissingLedger` covers both and `closeRun` tolerates both; every other error is
a genuine fault and rethrows. A missing ledger must degrade to a note rather than
fail a deploy it only observes.

Both writes are exported as db-parametrized bodies — `insertRunOn` / `closeRunOn`
beside `claimInflightRun` — and `createBuildRunRecorder` is nothing but the pool
binding over them, so `missing-ledger.test.ts` drives exactly the code the CLI
runs. That suite's database is deliberately UNMIGRATED (`createTestDb` without
`runMigrations`), which is the 42P01 scenario itself.

## A dead holder is settled at the claim

Only two paths in `./singularity build` close its own row: the ok verdict and the
failure-verdict funnel. An early `process.exit`, a throw, a catchable signal and a
SIGKILL all leave it open, still holding `build_runs_inflight_uniq`. The exit hook
cannot close it (a DB write is async), and the backend's supervised-run
reconciler only looks at boot — which a failed build never triggers.

So whoever LOSES the claim settles the holder: both claimants — the CLI's
`insertRun` and the backend's `claimBuildRun` — call `settleDeadInflightRun(db,
namespace)` on an inflight-index violation (checked by constraint name, so a
primary-key collision is never read as "in flight"), and retry the INSERT once
when it returns `true`. The rule is the supervised reconciler's:

```
terminal = build-logs-<id>.json ?? (isRunAlive(pid) ? still running : HARD_KILL_EXIT_CODE)
```

`build-logs-<buildId>.json` is the build's terminal record. `writeBuildLogs`
(`op-runtime/cli/build-logs-writer.ts`) writes it synchronously on every graceful
ending — ok verdict, failure verdict, and the exit-hook verdict guard's fallback —
so the row gets the build's real `exitCode` and the file's mtime as its end time.
**That dependency is load-bearing:** a graceful exit path that stops writing the
file would be read as "still running" while its pid lives, and as a hard kill
(`-1`) once it is gone. A file that exists but does not parse throws.

It is race-safe because the index still decides every race: the settle runs only
after losing the insert, closes only a provably-ended build with the guarded
first-writer-wins UPDATE (stamping only `finished_at` / `exit_code`), and a
recycled pid can only read as alive. `"lost"` / `false` therefore now means a
LIVE build holds the slot.

This leaf's whole import graph is intentionally minimal: drizzle,
`database/admin/server`, `namespace/core`, and — for the settle —
`jobs/supervised-job/core` (`isRunAlive`, `HARD_KILL_EXIT_CODE`) and `paths/core`
(`worktreeArtifacts.buildLogs`). Both of those are db-free and queue-free by
their own barrels' rules. **Never add a `config_v2`,
`shell/notifications`, env-bound `database/server`, `jobs`, or `events` import
here** — that eval-safety is the entire reason the leaf exists.

## Two `"build"` constants in `core/`, deliberately

`BUILD_RUN_KIND` is the discriminator of a row in the merged runs surface.
`BUILD_RUN_KIND_ID` is the supervised-run kind id — the filename prefix of every
build transcript and exit marker, which the artifact prune reaps a family by.
They are the same word today and are still two constants: aliasing them would
mean a rename made for how a run READS in a list silently renamed every build's
artifacts on disk. Both live here for the same reason — the leaf imports nothing
from `build`, so both sides of an otherwise-cyclic edge can reach them.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Build-runs ledger leaf: the build_runs entity, and (cli/) the hand-SQL build-run recorder the `./singularity build` CLI imports without the table or the heavy build barrel.
- Server:
  - Uses:
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
  - DB schema: `plugins/build/plugins/run-ledger/server/internal/tables.ts`
  - Exports (values):
    - `_buildRuns`
    - `settleDeadInflightRun`
- Core:
  - Uses:
    - `fields.FieldsRecord`
    - `fields.nullable`
    - `fields/date/config.dateField`
    - `fields/int/config.intField`
    - `fields/string-list/config.stringListField`
    - `fields/text/config.enumTextField`
    - `fields/text/config.textField`
    - `ids.defineIdKind`
    - `ids.idKindField`
    - `ids.IdOf`
    - `infra/entities.entityRef`
  - Exports (types): `BuildRunId`
  - Exports (values):
    - `BUILD_RUN_KIND`
    - `BUILD_RUN_KIND_ID`
    - `buildRunFields`
    - `buildRunIdKind`
    - `buildRunsEntityRef`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by:
    - `active-data/build-run`
    - `build`
    - `build/build-commits`
    - `build/runs-arm`
    - `framework/cli/build`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `shared/stale-holder.ts` (debt)
- Cli:
  - Exports (types): `BuildRunRecorder`
  - Exports (values): `createBuildRunRecorder`

<!-- AUTOGENERATED:END -->
