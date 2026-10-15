# runs-arm (build)

Builds, as one arm of the merged run space. See
[`plugins/runs`](../../../runs/CLAUDE.md) for what an arm is, and
[the design](../../../../research/2026-08-28-global-unified-runs-dataview.md).

## Why it is a sibling of `run-ledger`, not a child

The arm needs two things that live on opposite sides of the build plugin:
`_buildRuns` from `run-ledger/server`, and `buildDetailPane` from `build/web`.
`run-ledger` is deliberately a **lean leaf** — the `./singularity build` CLI
imports it with no env and no config, which is the whole reason it exists as its
own plugin — so hanging the arm underneath it would put a web barrel importing
`build/web` inside that leaf's subtree. A sibling keeps both imports legal and
leaves the leaf alone.

## `BUILD_RUN_KIND` lives in `run-ledger/core`, not here

The kind string is needed on both sides of an import edge that runs in opposite
directions: `build/web` names a selected row with it (`{ kind, id }`), and this
arm needs `build/web` for the run-detail pane its rows open. With the constant
in this plugin's own `core/`, those two edges close a cycle —
`build → build/runs-arm → build` — and `plugin-boundaries` rejects it.

The reasoning that it was safe, because the edges are keyed `zone.runtime` and
the two runtimes differ, is **wrong**: the cycle rule collapses to plugin
granularity. It was checked by argument rather than by running
`./singularity check plugin-boundaries`, which reported it in one line.

`run-ledger` breaks it because it already owns `build_runs`, imports nothing
from `build`, and a kind string is an identity — which is what a ledger has.
Both sides import from there and there is no path back.

**Do not re-export it from this plugin's core to shorten the import.**
Cross-plugin re-exports are banned and the ban is transitive; it would also put
the edge straight back.

## The one rule written twice

`buildStatusOf` decides a build's status in TypeScript, over a fetched row. The
union query has to decide it **in Postgres**, inside a projection that a
`WHERE`, an `ORDER BY` and a `GROUP BY` all run against — so a TypeScript
predicate is not available where the decision is needed, and
`server/internal/status-sql.ts` writes the same rule as a `CASE`.

Two encodings of one rule is a drift hazard, and it is guarded twice:

- Both read the **same exported constants** (`BUILD_EXIT_SUPERSEDED`,
  `BUILD_EXIT_HARD_KILLED`, `BUILD_EXIT_SIGNAL_BASE`). The last two used to be
  private to `build-status`; they are exported now precisely because there is a
  second reader. No number is re-typed as a literal.
- `status-sql.test.ts` drives every branch and both sides of every boundary
  through **both** encodings on a real Postgres and asserts they agree. It
  evaluates the expression over parameters rather than over `build_runs`, so it
  needs no table and no fixture rows.

The shared `outcome` is then derived **from** the status expression, not decided
again from the exit code — one encoding of the exit-code rule, and a separate
`Record<BuildStatus, RunOutcome>` collapse on top of it, which is total by type.
The generated `CASE` has no `else`: a status the map does not cover projects
NULL and `RunOutcomeSchema` throws, rather than an unlabelled row reaching the
list.

## Why `build.status` exists at all

`outcome` collapses `superseded` / `interrupted` / `killed` into one `canceled`,
because those three are not distinctions every kind of run can draw. They are
exactly the distinctions a person reading a *build* list needs, and none of the
three is a defect. Keeping the six-way taxonomy as an arm field is how the
precision survives the collapse — and it is why the list row contributes the
build dot rather than the shared outcome dot, which would paint all three the
same grey.

## `message` is null, deliberately

`build_runs` has no error column. A build's own words about why it failed are in
its transcript, which is a file on disk. Summarising the transcript into
`message` would be inventing a sentence the ledger never wrote; the exit code is
what the row actually knows, and it is `build.exitCode`.

## Worktree-scoped by construction

The arm carries an always-on `where namespace = ?` (`server/internal/arm.ts`),
so the merged runs view shows **this worktree's** builds and no one else's —
even though nothing in the view's own filters says so.

That is not a default anyone can reasonably be expected to infer, and "where are
my other worktree's builds?" is a fair question to ask of a list that calls
itself unified. The answer: a worktree DB is **forked** from main, so it inherits
every row main had at fork time. Unscoped, the list would open on main's stale
history and present it as this worktree's own.
`buildHistory` (the `build.history` collection) — the surface this replaces,
and the one the build button's own state reads — carries the same predicate as
its base `where`.

Removing the scope is therefore not "showing more" — it is showing another
checkout's runs under this one's name. A cross-worktree view, if it is ever
wanted, needs a deliberate namespace *dimension* the user can widen, not the
quiet absence of a predicate.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The build arm's presence on the merged run surface: the Build kind (whose rows open the existing build run-detail pane), the six-way build status dot as the list row's leading indicator, and the status / targets / commit / exit-code columns only a build row has. The build arm of the merged run space: binds `build_runs` into the runs union, mapping the six-way BuildStatus taxonomy onto the shared outcome axis while keeping it whole as the `build.status` arm field, plus the targets, commit and exit code only a build row has.
- Web:
  - Contributes:
    - `Runs.Kind` "build"
    - `Runs.Leading` → `BuildRunLeading`
    - `FieldPresentation.Register` "arm:runs:build"
    - `DataViewSlots.CollectionItemAction` "runs:investigate:build" → `CollectionInvestigate`
  - Uses:
    - `build.buildDetailPane`
    - `build/build-status.BuildStatusChip`
    - `build/build-status.BuildStatusDot`
    - `network/live.FieldPresentation`
    - `primitives/css/badge.Badge`
    - `runs.investigateRuns`
    - `runs.Runs`
- Server:
  - Uses:
    - `build/run-ledger._buildRuns`
    - `database/sql-projection.parsed`
    - `runs.defineRunKind`
  - Register: `defineRunKind('build')`
- Core:
  - Uses:
    - `build/build-status.BUILD_STATUS_OPTIONS_META`
    - `build/build-status.BuildStatus`
    - `build/run-ledger.BUILD_RUN_KIND`
    - `fields.nullable`
    - `fields/int/config.intField`
    - `fields/string-list/config.stringListField`
    - `fields/text/config.enumTextField`
    - `fields/text/config.textField`
    - `network/live.liveArm`
    - `runs.runs`
  - Exports (values):
    - `buildRunArm`
    - `BuildStatusSchema`

<!-- AUTOGENERATED:END -->
