# runs

One list of every long-running operation on this machine — builds, backups,
releases, deploys — federated at read time from each domain's **own** ledger.

Design: [`research/2026-08-28-global-unified-runs-dataview.md`](../../research/2026-08-28-global-unified-runs-dataview.md);
the routed union window: P6 of
[`research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md`](../../research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md).

## Read-time federation, not a shared table

The tempting alternative is one `runs` table with a `kind` discriminator, the way
`reports` / `trash` do it. That is right when the primitive *mints* the records.
It is wrong here: these ledgers already exist and carry domain constraints their
owners enforce (`build_runs` has a partial unique index for one in-flight build
per namespace, and is written by the CLI with a hand-written INSERT). A shared
table means dual-write or a derived projection — and a derived ledger's emptiness
is not evidence. Each table stays the single source of truth for its own domain;
the `runs` collection is a **union** over them (`liveCollection("runs", { arms:
{ discriminator: "kind" } })`, served by network/live's `serveUnionCollection`).

## The union window

`runs` is the reference **Meta-DataView** (data-view's CLAUDE.md): a list over
sources of different entities, its shared fields the union's, its per-source
fields the arms', its source field `kind`.

`runs` (core) is a routed, scrollable union window: one arm per registered run
kind, each served from its own table, listed in one order (`startedAt desc`,
then the row key). It mints `runs` (the window), `runs:rows` (a point read by
row key — `useRun`) and `runs:groups` (minted, subscriber-gated: no surface
declares facets over it, D23).

- **The row key** is `kind:id` (`runRowKey`, query-resource's `armKeyCodec`):
  a run id is unique only within its own ledger.
- **Live, routed.** Every arm's routes gate on exactly the columns its SQL
  reads, so a `pid` heartbeat (or a deploy's `leg_run_id`, a backup's
  `namespace`) reaches no window; a write to one ledger refills just the rows it
  changed, in the windows reading that arm. A deploy's label reads its server's
  name through a LOOKUP join, so a server rename relabels exactly that server's
  runs (a `reverse` route; over 500 runs the reading windows recompute FULL).
- **Arm pruning.** A filter that can only match some kinds (`kind is build`, a
  build-only column) compiles no SQL — and reads no routes — for the others.

## Vocabulary

An **arm** is one run kind's contribution (its table, its bindings, its own
columns, its renderers). Never call it a *source* — in data-view a source is a
`DataViewSwitcher` presentation, one active at a time, which is a different thing.

A **base field** is one every arm projects (`runs`' own fields); an **arm field**
is one only that kind has, declared by the arm's own `liveArm(runs, kind, {
label, fields, carry?, sortable })` in its core — each field with its label
and options, its filter domain derived. Arm fields ride their rows under
`$columns[<kind>]`, read through the arm (`arm.read(run)` — `null` on another
kind's row), and their wire / field ids are `<kind>.<field>` — `release.kind`
never shadows the discriminator.

An arm over a ledger the domain declared as an entity (`entityRef` beside its
raw table — build, release, deploy) is declared `from` it: it `pick`s its
stored fields by name, with the entity's labels and options, and declares
only what it computes (a build's `status`) as its own `fields`. Every field an
extension exposes on that ledger then lands in the arm's band with no code
here or in the arm. The server binds the picks by name; one whose column's
value is not the field's type (a `text[]`, a `text` under an enum) is bound in
`extra` (tsc).

The base fields are the collection's own (`liveCollection("runs", { fields,
carry, arms })`, core), presented once against it
(`FieldPresentation.Register({ owner: runs })`, `web/internal/presentation.tsx`:
cells and widths; the `kind` source field's options are the registered arms,
derived by every list). Every arm's fields are
DERIVED by the DataView from its `liveArm`, listed after them under the arm's
label — `RunsDataView` passes no fields.

## A row is fields, and only fields

Every row is one field-driven line, in every view, for every kind — so the
Properties panel means something. An arm declares **fields** (its `liveArm`,
presented by `FieldPresentation.Register({ owner: arm })`) and contributes a
**leading glyph** (`Runs.Leading`); it does not contribute a row body.

There used to be a `Runs.Row`. Do not reintroduce one: the list installs a
`renderRow` override the moment *any* arm contributes, and that override replaces
the field-driven body for **every** kind — so one arm's bespoke row switched off
the visible-fields panel for all four.

A domain's detail belongs in the pane its `runLinks` pushes. A domain's data
belongs in its arm's fields, where it is filterable and sortable rather than
merely visible.

## Where an arm cannot go wrong (T9)

`runsServed.arm(arm, { from, id, joins?, base(j), extra(j), where?(j) })` —
network/live's generic arm binding (`serveUnionCollection`'s `served.arm`):

- `arm` is the arm's own `liveArm`; the kind is ITS arm, so the
  discriminator, the row key's prefix and the field ids cannot drift.
- `base(j)` binds every base field but `id` and `duration` — each a column ref
  `j` offers whose column reads as the field's type (data type and nullability:
  an integer column cannot be a `label`, a text column cannot be `startedAt`),
  or an `ExprField` whose value type is the field's (tsc); a nullable
  field may be `null` ("no such notion": backup and deploy have no namespace).
- `extra(j)` binds exactly the arm column set's fields, each typed the same way (tsc).
- `id` is the ledger's single-column primary key (the row key encodes it), and
  the base `id` and `duration` are the union's `derive`d fields
  (`server/internal/served.ts`) — `duration` is `finishedAt − startedAt`, NULL
  while running, so `startedAt` / `finishedAt` bind to columns (tsc) and two
  arms cannot disagree about what a duration is. A running run's elapsed time is
  `<RunDuration>`'s browser ticker, never a value the server re-pushes.
- Labels and outcomes are `ExprField`s whose provenance is read off their SQL: a
  correlated subquery over an undeclared table cannot be written — declare it as
  a join.

**What this surface does not have:** user-defined custom columns. A union's
column vocabulary is its arms' static handles (no `columnScope`).

## Adding an arm

Its own `{core,server,web}` under the owning domain plugin — never here; `runs`
names no kind. `core`: `liveArm(runs, kind, { label, from?, pick?, fields?,
carry?, sortable })` — `label` is the kind's human name and the band ("Build", "Deploy", …)
its fields are listed under in the filter picker, the Properties list and the
group-by band, beside the "Common" band of base fields (data-view's CLAUDE.md,
"Field sections"). `server`: `runsServed.arm(arm, { … })` in
`register: [...]`. `web`: `FieldPresentation.Register({ owner: arm, fields })`
for its cells, widths and default visibility (required, even empty — the
`live:arms-registered` check), `runLinks(arm, (run, { openPane }) =>
openPane.to(…))` where its rows go (data-view's per-arm
`CollectionRowActivation`), `investigateRuns`, and `Runs.Leading` as wanted.

A `runLinks` link can only use identifiers the row already carries. When a
pane wants one the row does not have, **fix the pane** — do not grow this API
a component seam.

The kind's human label is declared **only** on the arm (`liveArm`'s `label`):
every list derives the `kind` filter's options from the registered arms, so
it offers every registered kind, not the ones on the loaded page.

## Reading one run: `useRun({ kind, id })`

`useLiveRow(runs, runRowKey(ref))` — a live point read of the union's `:rows`,
the row shaped exactly like a listed one (`$columns` included). A key naming no
registered kind, or no row, is `found: false`, never a contract error. A pane
resolves it with `resolveRow` and renders its body from `rowOrStale` (the found
row, or on a failed re-read the row as last seen).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The merged run surface: <RunsDataView> over the `runs` union window (a live scroll: base fields derived from the collection and presented once, plus every arm's own fields, derived from its liveArm, each bound to its column), and the seams an arm reaches it through: runLinks (where its rows go — data-view's CollectionRowActivation over the arm), investigateRuns, and Runs.Leading for the list row's status glyph; the kind filter's options are the registered arms, derived by every list; an arm presents its fields' cells with FieldPresentation.Register({ owner: arm }). Every row is a single field-driven line; a domain's detail lives in the pane its rows open. Also exports useRun (a live point read of one run by its (kind, id) pair) and <RunDuration> (finished duration, or a running run's ticking elapsed time). The merged run space as ONE routed union window (a Meta-DataView): runsServed serves the `runs` collection's window, its `:rows` point read (useRun) and `:groups` from every arm bound through runsServed.arm — a domain's own ledger typed against the base row and its liveArm, the ledger id and the duration derived by the union — so a write to one ledger refills only the rows it changed. Names no run kind.
- Web:
  - Slots: `Runs.Leading`
  - Slot contributors: `Runs.Leading` ← `build.runs-arm`
  - Contributes: `FieldPresentation.Register` "collection:runs"
  - Uses:
    - `network/live.FieldPresentation`
    - `network/live.LiveRowResult`
    - `network/live.useLiveRow`
    - `primitives/css/badge.Badge`
    - `primitives/data-view.DataView`
    - `primitives/data-view.DataViewDensity`
    - `primitives/data-view.DataViewSlots`
    - `primitives/data-view.defineDataView`
    - `primitives/data-view.liveDataSource`
    - `primitives/launch/investigate.Investigate`
    - `primitives/pane.OpenPaneFn`
    - `primitives/pane.useOpenPane`
    - `primitives/relative-time.RelativeTime`
    - `primitives/relative-time.useNow`
    - `primitives/slot-render.defineDispatchSlot`
    - `runs/run-outcome.RunOutcomeChip`
    - `runs/run-outcome.RunOutcomeDot`
  - Exports (types):
    - `RunInvestigation`
    - `RunRowProps`
    - `RunsDataViewProps`
  - Exports (values):
    - `formatDuration`
    - `investigateRuns`
    - `RunDuration`
    - `runLinks`
    - `Runs`
    - `RUNS_VIEW`
    - `RunsDataView`
    - `useRun`
- Server:
  - Contributes:
    - `resource.declare` "runs"
    - `resource.declare` "runs:groups"
    - `resource.declare` "runs:rows"
  - Uses: `network/live.serveUnionCollection`
  - Exports (values): `runsServed`
  - Resources:
    - `runs` (keyed, window)
    - `runs:groups` (push)
    - `runs:rows` (keyed, point)
- Core:
  - Uses:
    - `fields.nullable`
    - `fields/date/config.dateField`
    - `fields/float/config.floatField`
    - `fields/text/config.enumTextField`
    - `fields/text/config.textField`
    - `infra/query-resource.armKeyCodec`
    - `network/live.liveCollection`
    - `network/live.LiveRowsCollection`
    - `runs/run-outcome.RUN_OUTCOME_OPTIONS_META`
    - `runs/run-outcome.RUN_OUTCOMES`
  - Exports (types): `RunRow`
  - Exports (values):
    - `runRowKey`
    - `RunRowSchema`
    - `runs`
    - `runSubject`
- Cross-plugin:
  - Uses tokens: `ui/tokens/color-palette --muted-foreground`
  - Imported by:
    - `apps/deploy/deployments/runs-arm`
    - `backup`
    - `backup/runs-arm`
    - `build`
    - `build/runs-arm`
    - `release/runs-arm`
- Sub-plugins:
  - **`run-outcome`** — The shared run-outcome display: the colour/label metadata, the derived filter options, and the dot / chip / badge every run kind renders its outcome through — so a build row and a backup row cannot…

<!-- AUTOGENERATED:END -->
