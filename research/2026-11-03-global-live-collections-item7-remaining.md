# Live collections — item 7, the rest

Task: task-1793632850-k2yv6k (supersedes task-1790685711467-tlq5vc). Track: Network Layer › Resources.
Audit + first designs: the previous session's workflows (conv-1793288634-k42l1w); re-verified on
main `e423ccdcd2` (2026-11-03).

Three gaps remain of item 7:

- **(A) Clock columns.** Nothing live can compute a value against the current time. `runs.duration`
  is NULL while a run is in flight (so "Took" sorts in-flight runs last in both directions); two
  served values read the wall clock inside a loader (`app-usage.summary`: `current_date - 7`;
  google-maps usage: `billingMonth(new Date())`, and `place-details` picks its tier from it), so
  they go stale across midnight / the month boundary until some unrelated write recomputes them.
  Nothing refuses `now()` / `current_date` in compiled live SQL.
- **(B) Stand-ins while loading.** A field extension (custom columns) decodes `undefined` while its
  values read loads, so a cell reads "unset". A client field can only say "not known" for the whole
  surface, so the deploy Release column answers `null` (blank cell, a "None" bucket) for each row
  whose probe has not answered; a failed probe also reads as `null`.
- **(C) Hardening.** The `runs` union takes no `columnScope`; nothing makes a live DataView take
  its surface's custom columns or say why not (13 of 22 live DataViews silently fall back to
  display-only); `buildSortKeys` (keyset) is dead and drops unmapped fields; `wireFieldFor` falls
  back to name matching across relations; the in-memory sort silently drops a rule whose field is
  missing (`makeSortComparator`), unlike the filter and the live sort.

## Decisions (user, 2026-11: "pick the clean design")

1. Clock columns are a real primitive: declared, computed against a pinned `now` query param
   (quantum-based, after `useFilterClock`), cells tick client-side, raw clock reads in compiled
   live SQL are refused. Migrate runs' duration, app-usage, google-maps usage — no exemption.
2. Runs sort by duration falls out of the clock column.
3. `columnScope` on runs and the live debug/infra lists; every live DataView must declare it or
   opt out with a written reason.
4. Deploy Release: per-row pending, never `null`; the list does not block on the slowest probe.
5. Delete `buildSortKeys` and the name fallback; an unavailable saved sort/filter is a visible
   error.

## Design

### (B) Reads the host stamps — no contributor authors known-ness

**B1. Per-row unknown, one arm, beside `ClientFieldValue`** (`network/live/core`, `row-kind.ts`):

```ts
export type RowUnknown = { readonly [rowUnknownBrand]: "pending" } | { readonly [rowUnknownBrand]: "failed"; error: Error; refetch?: () => Promise<void> };
export const rowPending: RowUnknown;
export function rowFailed(error: Error, refetch?: () => Promise<void>): RowUnknown;
export function isRowUnknown(v: unknown): v is RowUnknown;
```

`ClientFieldReaders[K]` becomes `(row) => ClientFieldValue<F[K]> | RowUnknown`. Placed in live core
(data-view already imports it; the reverse edge would be new).

**B2. The host splits a reader once.** `ClientValuesLevel` (data-view) wraps each reader: `value(row)`
returns the known value (`undefined` for an unknown row) and stamps a host-only
`FieldDef.rowState(row): { status: "known" } | { status: "loading" } | { status: "error"; error; refetch? }`
derived from the SAME call (memoised per row object), so the two cannot disagree.

**B3. Rows not known yet are not laid out — and do not hold the body.** When a field the view is laid
out by (group / sort / filter / fold — `fieldsReadByView`) has a `rowState`, the in-memory pipeline
partitions the rows: rows known for every such field go through filter/sort/group as today; the
rest are withheld from the layout and drawn as one **pending tail** under the view ("Checking 3
rows…" with the loading affordance; failed rows as their error with Retry). A row joins the layout
the moment its value lands. So no row claims a bucket/position/match it does not have, and one hung
probe holds one row, not the list (decision 4). A field NOT read by the layout draws its unknown
rows in place: `FieldCell` renders the loading block / inline error per row, and a pending row is
not editable. `computeElided` and extents skip non-known rows.

  *Trade-off (reported):* the alternative was holding the whole body until every probe answers (the
  previous session's draft) — simpler, but it blocks on the slowest probe, which decision 4 forbids.

**B4. Field extensions hand a read, not finished fields.** `FieldExtensionProps.render` takes
`{ fields: ExtensionField[], values: ResourceResult<Readers> }`; `ExtensionField` is a
distributive omit of `FieldDef` with `value | values | pending | readError | rowState: never`. The
host (`FieldExtensionStep`) stamps `value` / `pending` / `readError` (stale kept on error) with the
same fold `ClientValuesLevel` uses — one shared helper, `foldFieldRead`. A contributor that authors
a value is a tsc error; a reader for an undeclared id, or a field without a reader, throws.
custom-columns migrates (loading is `pending`, never the decode of `undefined`).

**B5. Release column.** `ReleaseFieldResolver`'s reader returns `rowPending` until the row's probe
answers, `rowFailed(error, retry)` for a failed probe, and the release state when ready. A row on a
server with no verified platform is a KNOWN `null` (no question to ask) — explicitly, not "no probe
mounted". The git resolver's home-dir wait is a whole-surface read (loading until home is known).
A probe deadline only as a bound around the remote peer, if one is needed at all (the probe is a
live value; its own read state already settles).

### (C) Hardening

**C1. `runs` takes a `columnScope`.** The union compiler joins scoped families per arm. The family's
host key is the union row key (`kind:id`), so the arm key codec owns both directions: a family is
bound with `hostKey: armKeyCodec(kind)` (SQL `'<kind>:' || pk::text`), and the union route plan gets
the `decode` counterpart of its alias `encode`. `LiveArmsSpec.columnScope` is allowed;
compile-union-window gains member columns (`memberOf`, nullable LEFT-join members, `$scoped` off the
wire row, `recomputeOn`), with an oracle case for a NULL cut boundary across arms.

**C2. A live DataView names its surface; the collection's scope must be it (tsc).**
`defineDataView<const Id>` returns `DataViewId<Id>`; `liveCollection` keeps a literal `columnScope`
type; `liveDataSource(collection, { surface, ... })` requires `surface: DataViewId<Cs>` for a scoped
collection, and `unscoped: { reason }` for one without. `LiveDataSource` carries
`customColumns: { kind: "scoped"; scope } | { kind: "unscoped"; reason }`; under `unscoped` the
custom-column fields are explicitly `sortable: false, filterable: false` and the Fields setting says
why. The live origin takes no `storageKey` (it is the source's surface) — staged as step two of C2
(a type-only churn over ~22 call sites), after the binding lands with a mount assert.
Scoped: notifications, eventEmissions, jobRuns, deadJobs, slowOpCallers, slowOpsList, claudeCliCalls,
bootTraces, errorStoppedConversations, pluginHealthReviews, historyVersions, runs (after C1). Opt-outs:
`jobs` (served from the job queue outside Postgres — a scoped column joins a Postgres side table);
`trashEntries` (shared by every trash surface, one collection for N surfaces — verify, else scope).

**C3. Dead and fail-soft code.** Delete `buildSortKeys`, `keyValuesOf`, `KeysetColumnMap/Binding`,
`Tiebreaker` and `keyset/core` (only `seek.test.ts` uses them). `wireFieldFor` → relation-exact
`projectedField`; keep the `arm-plan` "projects a joined column" check as a one-line invariant.
In-memory sort: a rule naming a field that does not resolve joins `unavailable` (body-state's
`rule-error`, loading while the deferred tier may still contribute it) — the same arm the filter
and the live sort already use.

### (A) Clock columns — one declaration, two renderings, a pinned `now`

**A1. A closed set of clock forms**, declared in core so the server renders SQL and the browser
renders JS from the SAME declaration (no second definition to drift):

```ts
// network/live/core
clockField.elapsed({ from: "startedAt", until: "finishedAt" }, { quantumMs: 60_000 })
//   SQL: extract(epoch from (coalesce(until, $now) - from)) * 1000
//   JS:  (until ?? now) - from
```

Only `elapsed` is needed today; a new form (e.g. `overdue`) is one entry in the closed set.
A row carries the clock field computed at the pin, and the cell recomputes it from the row's own
inputs against the browser's ticking clock (`useNow`), so a running run's "Took" ticks with no
server push. `runs.duration` becomes this (the union `derive` binds it over `startedAt` /
`finishedAt`); `<RunDuration>`'s hand ticker goes.

**A2. The pin is a query param, owned by the reader.** A window query whose `where` / `orderBy`
names a clock field carries `now` (epoch ms, floored to the field's quantum); one that does not
carries none (no reloads for a list that only displays the column). `useLive` fills it and re-pins
at the next quantum boundary with one timer to a known instant (the `useFilterClock` /
`useDayClock` pattern, not a poll). The server refuses a query that reads a clock field without
`now`, or carries `now` reading none. Within a pin the keyset is a pure function of the params,
so cursors are stable; a re-pin is a new tuple (the window reloads).

  *Trade-off (reported):* sorted by Took, an open runs list reloads its window once per quantum
  (60 s) while in-flight runs exist; between pins a running row's ticking cell can sit a little out
  of order against finished rows. Alternatives: a shorter quantum (more reloads) or no re-pin
  (order frozen at open).

**A3. Clock params on values.** `liveValue(..., { params: { today: clockParam("day") } })` — a
typed param the READER fills from its clock (`useLive` on the browser, in the user's zone; a server
reader passes it explicitly). app-usage takes `today` (its 7-day window is `day > today - 7`);
google-maps usage takes `month` (billing month, Pacific); `place-details` takes `month` for its tier.
`mapsBudgetNow()` for non-live server callers (agent tools, photo handlers) stays a point read.

**A4. Raw clock reads are refused.** `assertStableRead(fragment, label)` at the compile entry points
(projection, where, order, join on, ExprField, aggregate SQL incl. `ifNone`) refuses `now()`,
`current_date`, `current_timestamp`, `clock_timestamp()`, `random()`, … at module eval (rung 4: tsc
cannot read SQL text). Hand-written loaders: lint `live/no-clock-in-served` — a `sql` template with
a clock read, or `Date.now()` / `new Date()` with no argument, inside the arguments of a
`serveValue` / `serveCollection` call (rung 3).

## Sessions

1. **This session:** B (B1–B5), C3, C2 step one (binding + scopes on the DB-routed lists). Prove on
   the deploy Release column and a custom column.
2. **Next:** A (A1–A4) + C1 (runs takes its scope and its clock duration together — both reshape
   the union compiler's per-arm columns), C2 step two. Prove on runs (sort by Took with an in-flight
   run) and a real-Postgres oracle fixture.

## As landed — session 1

Approved by the track supervisor (2026-11-03): the pending tail, one clock
definition rendered both ways, the 60 s re-pin while a clock field is in
where/orderBy (client-side quantum timer, push-free on the server), clock params
on values, `jobs` opt-out, `trash-entries` verified.

**B — reads the host stamps.**
- `RowUnknown` / `rowPending` / `rowFailed` / `isRowUnknown` / `RowFieldState`
  in `network/live/core` (`row-unknown.ts`); `ClientFieldReaders[K]` returns
  `ClientFieldValue | RowUnknown`.
- data-view `web/internal/field-read.ts`: `foldFieldRead` (the one
  pending / readError / stale fold), `splitRowReader` (value + `rowState` from
  one memoised call per row), `partitionKnownRows`, `stampExtensionRead`.
- `FieldDef.rowState` (host-stamped). `FieldCell` draws loading / the failure
  per row (not editable). The in-memory body withholds rows not known for a
  laid-out-by field and draws `NotKnownRowsTail` under the view.
- Field extensions: `render({ fields: ExtensionField[], values: ResourceResult })`
  (or `null`); the contract moved to data-view web
  (`field-extension-types.ts`, it carries a `ResourceResult`).
  `ExtensionField` makes `value`/`values`/`pending`/`readError`/`rowState`
  tsc errors; `ColumnConfigDerivation` likewise. custom-columns migrated
  (loading = `pending`, never `decode(undefined)`).
- Deploy Release: `releaseAnswerOf` — probe not answered = `rowPending`, failed
  = `rowFailed(retry)`, no verified platform = known `null`. Git client fields
  are pending while the home dir loads.

**C3.** `buildSortKeys`, `keyValuesOf`, `KeysetColumnMap/Binding`,
`Tiebreaker` and `keyset/core` deleted (seek tests build keys directly).
`wireFieldFor` deleted: the pk's wire field and select-all signature fields
resolve relation-exact through `projectedField` (a joined column of the pk's
name now fails as "primary-key column not present" — still at module eval).
In-memory sort rules on a missing field → `unsortableRules` → body `rule-error`.

**C2 step one.** `DataViewId<Id>` keeps its literal (`defineDataView<const Id>`);
the window overload of `liveCollection` keeps `columnScope` literal
(`LiveColumnScopeOf`, declared outside the form conditional — inside it tsc
inferred `never`); `liveDataSource(c, { surface, unscoped? })` binds the source
(`LiveSurfaceBinding`, `C` inferred whole — inferring the scope alone merged it
with `LiveCollection`'s `string | null`). `LiveDataSource.surface` /
`.customColumns`; `FieldExtensionProps.liveColumns` (in-memory | scoped |
unscoped); mount assert `source.surface === storageKey`
(`surfaceCustomColumnsOf`). Custom columns under `unscoped` are explicitly not
sortable/filterable.
- Scoped now (11 added): notifications, event-emissions, job-runs.history,
  dead-jobs, slow-ops.callers, slow-ops.ops, claude-cli-calls,
  debug.boot-traces, plugin-health-reviews, history.versions,
  runtime-sdk.error-stopped.
- Opt-outs (reason in code): `jobs` (external — graphile snapshot), 
  `trash-entries` (one generic collection for every trash surface; a scope names
  one surface), `runs` (union — session 2).

**Trade-off found (for session 2).** A column scope is ONE surface per
collection, but `runs` is listed under several surfaces (`RUNS_VIEW`, the Deploy
Activity page's own id), as `trash-entries` would be. A per-collection scope
can give custom columns to one of them only. The clean fix is a scope chosen
per query (the surface id a tuple names, validated against the
`LiveColumns.Scoped` contributions) rather than per collection — to decide
with C1.

Not done this session (session 2): A (clock columns + guard + migrations), C1
(runs scope), C2 step two (no `storageKey` on a live origin), the Fields
setting's note under `unscoped`.
