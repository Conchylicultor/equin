# Unified Runs DataView — merging heterogeneous run ledgers into one row space

## Context

Long-running work is recorded in four separate ledgers today, each with its own surface and its
own quality level:

| Ledger | Table | Surface today |
|---|---|---|
| Builds | `build_runs` (`plugins/build/plugins/run-ledger/server/internal/tables.ts`) | `defineDataView("build.history")` — the build-button popover **and** `/debug/build`, one component at two densities |
| Backups | `backup_runs` (`plugins/backup/server/internal/tables.ts`) | hand-rolled `.map()` of expand/collapse cards, no live resource at all — one-shot `useEndpoint(listBackupRuns)` |
| Releases | `release_runs` (`plugins/release/server/internal/tables.ts`) | server-delegated keyset DataView, scoped per composition |
| Deploys | `deploy_runs` (`plugins/apps/plugins/deploy/plugins/deployments/server/internal/tables.ts`) | server-delegated keyset DataView, scoped per deployment |

There is nowhere to answer *"what is running on this machine right now, and what just finished"*.
The build button is where a person already looks for that, and it only knows about builds.

**Scope of this plan (agreed):** all four kinds — builds, backups, releases, deploys — `Runs` as the
noun, replacing only the build popover / `/debug/build` surface, current worktree. The deploy and
release panes keep their existing scoped surfaces; those are *per-deployment* and *per-composition*
views, which the global one is not. They gain a second, unscoped home rather than losing their own.

---

## Is the "meta-DataView" idea good? Yes — with three corrections

The instinct is right: shared base fields, per-table extra fields, filter/group by table id,
per-row rendering dispatched to the owning domain. Three corrections to the framing.

### 1. Merge row *spaces*, not DataViews

`MergedDataView` already exists (`data-view/web/components/merged-data-view.tsx`,
`defineDataViewSources`) and it is **not** this. Its "sources" are mutually exclusive
presentations under one switcher — exactly one mounts at a time (`key={source.id}` remounts the
body on switch), each with its own row type and field schema. `task-deps-tree` uses it for two
organisations of one member set. It cannot put build rows and backup rows in the same list.

What we want is one ordinary `<DataView>` whose row space is a **discriminated union**, fed by one
server query. Nothing about the web host needs to change — `dataSource`, `FieldExtension`,
group-by, filter chips all already work on whatever rows arrive. The net-new work is **server-side
only**: a keyset query compiler that merges N tables.

Because these two things are both "several things under one DataView", they need names that stay
apart. See the vocabulary table below: the existing concept keeps **source**; the new one is an
**arm**.

### 2. Don't centralize storage — federate at read time

The tempting alternative is a shared `runs` table with a `kind` discriminator, the way
`reports`/`trash` do it (one ledger, generic columns, per-kind payload, per-kind spec
contribution). That is right when the records are *minted fresh* by the primitive. It is wrong
here, because these ledgers already exist and carry domain constraints that belong to their owners:

- `build_runs` has a partial unique index `WHERE finished_at IS NULL` enforcing one in-flight build
  per namespace, and is written by the **CLI** with a hand-written parameterized INSERT
  (deliberately, to survive schema skew across the build that generates the migration).
- `backup_runs` carries `manifest` / `target_results` jsonb decoded by the backup schemas.

A shared table means dual-write or a derived projection — and a derived ledger's emptiness is not
evidence (`research/2026-07-08-global-absorbable-failure-guardrail.md`). Read-time federation keeps
each table the single source of truth for its own domain.

### 3. Dispatch *presentation*, not *schema*

"Rendering dispatched to the individual table" is right for the list row and the detail pane, and
wrong for the table view. Fields are what make filter / sort / group-by / search work uniformly; if
an arm could replace the row wholesale, the table view's columns would stop lining up and a sort by
`duration` would be meaningless. So:

- **Table view** — strictly field-driven. An arm field is simply blank on rows of other kinds.
- **List view** — the arm supplies the row body and the leading indicator (the seams already exist:
  `viewOptions.list.renderRow` and `viewOptions.list.leading`, both used in production today by
  deploy-history and build.history respectively). `runs` dispatches on `row.kind`, falling back to
  the field-driven row when an arm contributes none.
- **Row activation** — the arm declares `openDetail(row)`; clicking a build row opens the existing
  build detail pane, a backup row opens the backup detail.

---

## Vocabulary

One name per concept, used identically in code, config and prose.

| Term | Meaning |
|---|---|
| **Run** | One execution of a long-running operation: a start, an end, an outcome. Already the repo's noun — every one of these tables is `*_runs`. |
| **Run kind** | Which domain a run came from: `build`, `backup`, `release`, `deploy`. The value of the `kind` field. |
| **Arm** | One contributor to the merged row space — a run kind's table, its column bindings, its own fields and its renderers. One arm ⇄ one run kind. ("Arm" is already the repo's word for a branch of a discriminated union: *"rendered arm by arm"*.) |
| **Base field** | A field **every** arm projects: `kind`, `label`, `outcome`, `trigger`, `startedAt`, `finishedAt`, `duration`, `namespace`. Declared once by `runs`; filters, sorts and groups across all kinds. |
| **Arm field** | A field **one** arm adds: `build.targets`, `deploy.verb`, `release.platform`, `backup.archiveSize`. Always namespaced `<kind>.<id>`, and NULL on every other kind's rows. The namespace is not decoration: `release_runs` already has its own `kind` column (`staged` / `candidate`), which becomes `release.kind` and cannot be allowed to shadow the discriminator. |
| **Outcome** | The shared closed status vocabulary every arm maps its native status into: `running / succeeded / partial / failed / canceled`. |
| **Native status** | The arm's own finer status (`superseded`, `killed`, `interrupted`, `ok`, `partial`), kept as an arm field so precision is not lost. |
| **Union query** | The one server query behind the surface: `UNION ALL` of one keyset-seeked subselect per arm. |
| **Arm pruning** | A filter rule naming a field an arm does not declare removes that arm from the union entirely. |
| ~~Source~~ | **Reserved** — in `data-view` a *source* is a `MergedDataView` presentation (one active at a time). Never use it for an arm. |

Two well-defined semantics fall out of the table and must be documented as rules, not discovered:

- **A filter on an arm field prunes every other arm.** `targets contains sonata` yields builds only
  — no `NULL`-vs-`false` ambiguity, and the query gets cheaper rather than more expensive.
- **A sort on an arm field puts other kinds' rows last** (`NULLS LAST`), deterministically.
- **A NULL base field means the arm has no such notion** — `backup_runs` and `deploy_runs` have no
  `namespace` (a backup is host-global; a deploy targets a remote server), so they read null there
  rather than being given a fake one. `build_runs` and `release_runs` both have one, and both need
  it: a worktree DB is forked from main and inherits main's rows.

- **The surface is therefore half-scoped, and that is a property, not a caveat.** Builds and
  releases are pinned to `currentWorktreeName()` by an always-on arm `where`; backups and deploys
  are unscoped. So *"what is running on this machine right now"* is only literally true for two of
  the four arms — someone reading the build popover inside a worktree sees that worktree's builds
  beside the whole host's deploys.

  This follows directly from the NULL rule above, which is why it is stated here rather than left
  in a `where` clause. It is also a trap: the asymmetry looks like an oversight, and the obvious
  "fix" empties half the view. `backup_runs.namespace` is SQL `NULL` on every row, and
  `null = '<worktree>'` evaluates to `NULL`, not `false` — so a scope predicate there does not
  narrow the arm, three-valued logic discards it entirely, and the symptom is an empty section
  reading as "no backups yet".

---

## Design

### Layer 1 — `data-view/plugins/union-query` (generic, server-only)

New sub-plugin under `plugins/primitives/plugins/data-view/plugins/union-query/`. It sits on top of
the two existing field-agnostic compilers and adds the one thing they lack — multiple tables:

- `server-query` (`compileWhere`, `FieldColumnMap`, `OperatorSqlResolver`, `augmentServerQuery`)
- `primitives/keyset` (`buildSortKeys`, `orderByClauses`, `seekPredicate`, `keyValuesOf`,
  `encodeCursor` / `decodeCursor` / `sortSignature`)

```ts
// server/index.ts
export interface UnionArm {
  kind: string;                       // the discriminator value
  table: PgTable;
  /** base fieldId -> column or SQL expression. Must cover every base field the
   *  consumer declared, or NULL-typed for the ones this arm has no notion of. */
  base: Record<string, SQL | AnyColumn>;
  /** arm fieldId -> column or SQL expression. Keys are namespaced `<kind>.<id>`. */
  extra: Record<string, SQL | AnyColumn>;
  /** Optional always-on scope, e.g. soft-delete or retention. */
  where?: SQL;
}

export function compileUnionPage(args: {
  arms: UnionArm[];
  baseTypes: Record<string, string>;   // base fieldId -> field-type id, for operator resolution
  armTypes: Record<string, string>;    // arm fieldId -> field-type id
  resolveOperator: OperatorSqlResolver;
  sort: SortRule[]; filter: FilterGroup | null; query: string;
  cursor: string | null; limit: number;
  tiebreaker: { fieldId: string };     // stable last key, `id`
}): { sql: SQL; keys: SortKey[]; prunedArms: string[] };
```

Mechanics: build one `$dynamic()` select per surviving arm projecting `kind` + the full base column
list + every arm's extra columns (`NULL::<type>` for the ones this arm doesn't own), push the
compiled `WHERE` **and** the keyset `seekPredicate` **and** `LIMIT n` into each arm, then
`unionAll` and re-apply `ORDER BY` + `LIMIT n` on the outside. Postgres merges the per-arm sorted
prefixes; each arm's own index on `(started_at desc, id)` does the work.

Why a primitive rather than code inside `runs`: the arm-pruning rules, the null-projection
alignment and the cursor-signature handling are the hard-to-get-right part, and they are entirely
field-agnostic. `debug/timeline` — today a hardcoded `DB_SOURCES` array doing this by hand — is the
obvious second consumer, and the timeline's own CLAUDE.md already flags the closed list as
"revisit if a non-debug plugin ever needs to feed it". That is now.

**Tests** (`server/internal/compile-union.test.ts`, bun:test alongside the source, mirroring
`server-query`'s and `keyset`'s existing suites): pruning on an arm-field rule, null projection
alignment across arms, seek continuity across an arm boundary, cursor-signature invalidation on
sort change.

### Layer 2 — `plugins/runs` (the domain)

```
plugins/runs/
  core/          RunKind ids, RunOutcome, base field ids + types, UnionRun wire schema, endpoints
  server/        defineRunKind registry, POST /api/runs/query, the runs.revision tick resource
  web/           RunsDataView, base FieldDef[], RunFields extension slot, RunRow/RunLeading dispatch
  plugins/
    run-outcome/ shared outcome display: options, chip, dot (mirrors build-status's shape)
```

`defineRunKind` is the registry, mirroring `defineTrashSource` / `defineHistorySource` byte-for-byte
(a `Registration` token placed in the plugin's `register: [...]`):

```ts
export const buildRunKind = defineRunKind({
  kind: "build",
  label: "Build",
  table: _buildRuns,
  base: {
    label: sql`array_to_string(${_buildRuns.targets}, ', ')`,
    outcome: sql`case when finished_at is null then 'running' when exit_code = 0 then 'succeeded' … end`,
    trigger: _buildRuns.trigger,
    startedAt: _buildRuns.startedAt,
    finishedAt: _buildRuns.finishedAt,
    namespace: _buildRuns.namespace,
  },
  extra: { "build.status": …, "build.targets": _buildRuns.targets, "build.commitHash": … },
});
```

The **base** map's key set is typed against the base-field declaration in `runs/core`, so an arm
that forgets `outcome` is a `tsc` error, not a silently-null column (rung 2 of the fix ladder).
Same for the **extra** map against the arm's own core field declaration — which closes the footgun
data-view's own docs already warn about, where a web field id that doesn't match the server
`FieldColumnMap` key degrades silently into client-side-only filtering over the loaded window.

`POST /api/runs/query` implements `ServerDataSourceSpec`'s wire contract exactly as
`handle-runs-query.ts` does for deploy — it just calls `compileUnionPage` over
`getRunKinds()` instead of building one select.

`runs.revision` is a scalar `{ rev }` push resource whose loader hashes coarse per-arm facts
(count by outcome, `max(started_at)`, `max(finished_at)`), copied from
`deployRunsRevisionServerResource` and generalized to fold over the registry. `dependsOn` is the
arm tables the registry reports, so adding an arm needs no edit here.

### Layer 3 — the arms

Each arm lives **inside its own domain plugin** — it must, since the tables are plugin-private, and
it is where the knowledge belongs. `runs` never names an arm.

- `plugins/build/plugins/run-ledger/plugins/runs-arm/{core,server,web}` — `_buildRuns` is already
  exported from `@plugins/build/plugins/run-ledger/server`, so no barrel change. Arm fields:
  `status` (the six-way `buildStatusOf` taxonomy, kept precise), `targets` (`tags`), `commitHash`.
  Reuses `BuildStatusChip` / `BuildStatusDot` / `BUILD_STATUS_OPTIONS` verbatim for its list
  leading + row.
- `plugins/backup/plugins/runs-arm/{core,server,web}` — requires exporting `_backupRuns` from
  `@plugins/backup/server` (mirrors run-ledger). Arm fields: `backup.status`
  (`ok / partial / failed` — `partial` is the one native status the shared `outcome` vocabulary
  keeps, because backup is the only kind that can half-succeed), `backup.archiveSize` (`int`,
  byte-formatted cell), `backup.targetCount`. Its row renderer carries the per-target ok/partial
  detail the current hand-rolled card shows.
- `plugins/release/plugins/runs-arm/{core,server,web}` — `_releaseRuns` is already exported from
  `@plugins/release/server`, so no barrel change. Base: `label` = `composition`,
  `namespace` = `namespace`. Arm fields: `release.kind` (`staged / candidate`), `release.composition`,
  `release.target`, `release.platform`, `release.commitSha`, `release.commitDirty`,
  `release.artifactPath`. `error` maps onto the base error/message field.
- `plugins/apps/plugins/deploy/plugins/deployments/plugins/runs-arm/{core,server,web}` — requires
  exporting `_deployRuns` from the deployments server barrel. Base: `label` = the server +
  composition pair, `trigger` = `verb`. Arm fields: `deploy.verb` (`converge / ship / update`),
  `deploy.phaseFailed`, `deploy.serverId`, `deploy.deploymentId`, `deploy.compositionId`,
  `deploy.commitSha`, `deploy.releaseRunId` — the last of which is a link *into* the release arm, so
  a failed deploy's row can chip through to the release it shipped. That cross-arm link is only
  expressible once both are arms of one surface, and is a good argument for taking all four now
  rather than two.

Arm web fields are contributed through the **existing** `defineFieldExtensions<UnionRun>()` seam —
`runs/web` mints `RunFields`, each arm calls `RunFields({ id, component })`, exactly like
`events/source-field`, `pages/starred` and `tasks/task-category` do today. No new web machinery.

### Layer 4 — the surfaces

`defineDataView("runs")`, authored in `config/runs/runs.jsonc`, tabs as view instances — the
`mail-threads.jsonc` pattern where the tab axis *is* an ordinary editable filter:

| Instance id | Name | Filter |
|---|---|---|
| `active` | Active | `outcome is running` |
| `recent` | Recent | — (sort `startedAt desc`) |
| `builds` | Builds | `kind is build` |
| `backups` | Backups | `kind is backup` |
| `shipping` | Shipping | `kind is any of release, deploy` |
| `failed` | Failed | `outcome is any of failed, partial` |

A tab is nothing but a filter, so this table is a suggestion the user can edit in place — adding
"Failed builds this week" costs a config row, not code.

- **Build popover + `/debug/build`** render `<RunsDataView>` instead of `BuildHistoryDataView`,
  defaulting to `active`. Same two densities, same one component, as today.
- **The build button's own state is unchanged.** It derives idle/building/failed from
  `buildHistoryResource`, which stays exactly as it is — only the *list* moves to the union query.
  (That also stops the list depending on a legacy unbounded `queryResource`, per
  `research/2026-07-18-global-bounded-working-set-resource-contract.md`; narrowing the resource
  itself is out of scope.)
- **The backup panel's hand-rolled list is deleted** and replaced by `<RunsDataView>` with the
  `backups` instance — which also retires a `data-view/no-adhoc-row-list` violation.
- `config/build/build.history.jsonc` and its `defineDataView("build.history")` marker are removed;
  the two authored instances there are superseded by `recent` / `builds` above.

---

## Files

**New**

- `plugins/primitives/plugins/data-view/plugins/union-query/{core,server}/` + `CLAUDE.md`
- `plugins/runs/{core,server,web}/` + `plugins/runs/plugins/run-outcome/` + `CLAUDE.md`
- `plugins/build/plugins/run-ledger/plugins/runs-arm/{core,server,web}/`
- `plugins/backup/plugins/runs-arm/{core,server,web}/`
- `plugins/release/plugins/runs-arm/{core,server,web}/`
- `plugins/apps/plugins/deploy/plugins/deployments/plugins/runs-arm/{core,server,web}/`
- `config/runs/runs.jsonc` (authored; the `@review` marker must be resolved or
  `config:overrides-authored` fails)

**Modified**

- `plugins/build/web/components/build-popover-content.tsx` — drop `BuildHistoryDataView` and its
  field schema (fields move into the build arm), render `<RunsDataView>`
- `plugins/build/web/panes.tsx` — the `/debug/build` pane body
- `plugins/backup/web/components/backup-panel.tsx` — drop `BackupRunRow` + the list, render
  `<RunsDataView>`
- `plugins/backup/server/index.ts` — export `_backupRuns`
- `plugins/apps/plugins/deploy/plugins/deployments/server/index.ts` — export `_deployRuns`
- delete `config/build/build.history*.jsonc`

**Untouched** — the deploy-history and release-history sections keep their own scoped DataViews and
their own query endpoints. Folding them into scoped instances of `runs` is a plausible follow-up
once the arms exist, but it is a separate change with its own row-rendering losses to weigh.

**Reused, not rebuilt** — `compileWhere` / `augmentServerQuery` (`server-query/server`),
`buildSortKeys` / `seekPredicate` / `encodeCursor` (`primitives/keyset`), `ServerDataSourceSpec` +
`useServerDataSource` (`data-view/web`), `defineFieldExtensions` (`data-view/web`), `defineResource`
push-tick (copied from `deployRunsRevisionServerResource`), `defineTrashSource`'s registration shape,
`BuildStatusChip` / `BuildStatusDot` (`build/plugins/build-status/web`).

---

## Verification

1. `./equin build` (background) — regenerates `data-views.generated.ts`, the plugin registries
   and docs; `plugins-registry-in-sync`, `data-views-in-sync`, `plugin-boundaries`,
   `config:overrides-authored` and `type-check` all gate it.
2. `./equin test plugins/primitives/plugins/data-view/plugins/union-query` — the compiler
   suite (pruning, null alignment, seek continuity, cursor invalidation).
3. `query_db` on this worktree: confirm all four tables have rows, then compare the endpoint's first
   page against a hand-written `union all` over the four `order by started_at desc limit 25`.
4. Drive the real surface:
   ```
   ./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --url http://att-1787885228-uyko.localhost:9000/debug/build --out /tmp/runs
   ```
   Check by hand: all four kinds interleaved in one list; the `kind` chip filters; group-by `kind`
   sections; group-by `outcome` spans kinds; `build.targets contains …` leaves only builds (arm
   pruning); sorting by `backup.archiveSize` puts the other three kinds last; each row opens its own
   domain's detail pane; infinite scroll pages across arm boundaries without duplicating or dropping
   a row.
5. Run a real build and a real backup and watch both appear in **Active** without a reload — the
   `runs.revision` tick refetching the loaded window in place.

---

## As built — where the implementation departed from this plan

Recorded because each departure was forced by something the plan did not know, and a reader
comparing the two should see the reason rather than infer carelessness.

### Corrections to the plan's own claims

- **"Each arm's own index on `(started_at desc, id)` does the work" was false.** No arm table had an
  index that could serve the union's ordering: `build_runs` and `backup_runs` had none at all, and
  the indexes on `release_runs` / `deploy_runs` lead with columns the unscoped query does not
  constrain. Every arm subselect was a top-N heapsort over the whole table, on every page of every
  scroll. Fixed here — but the plan asserted the property rather than checking it.

- **The view was not worktree-scoped, and the surface it replaces is.** `buildHistoryResource`
  carries `where: eq(_buildRuns.namespace, currentWorktreeName())`; no arm did. In this worktree
  2389 of 2390 build rows belong to `singularity`, so the build popover would have shown four
  months of another namespace's history in place of its own. Fixed by an always-on arm `where` on
  build and release only.

- **`RunOutcome` lives in `run-outcome/core`, not `runs/core`.** The planned home would have made
  `runs/web → run-outcome/web → runs/core` a plugin cycle.

### Shipped as known limitations

- **Release and deploy rows do not activate.** Release's detail pane is keyed by the composition
  *uuid* while the ledger stores its *name*; deploy's pane is a legacy segment-form pane whose
  `ParentParams` types to `{}`, so it cannot be handed the `serverId` its ancestor needs. Both are
  written up in their arms' `CLAUDE.md` with the smaller fix named. A row that does not activate is
  honest; a click that silently does nothing is not.

- **User-defined custom columns do not reach this surface.** `union-query` does not run the
  server-side field augmentors: an augmentor joins one `rowKeyCol`, and the union's row key is the
  pair `(kind, id)`. Lifting it is a change to the augmentor contract.

- **The worktree scope is a hard constraint, not the editable default that was agreed.** No filter a
  user writes can see past the arm `where`. Making it widenable needs the current worktree resolved
  at query time — a config literal is wrong everywhere except where it was written, since view
  configs are committed and shared across worktrees. Filed.

- **Three of the four ledgers have no retention sweep** (`deploy_runs` is the only one that does).
  Filed; each table needs its own policy, and build history is read by the build button's own state,
  so too short a window changes behaviour rather than just reclaiming space.

### Defects found in shared code while building this

All four were pre-existing or newly introduced in the `data-view` primitive, and all four are fixed:

1. **A row that cannot activate was still rendered as a `<button>`** — the list view always passed an
   `onClick` closure. Any interactive control inside a `renderRow` was therefore a button nested in a
   button, repo-wide. The gallery had the same defect in a worse form: `DataCard` set `role="button"`,
   a tab stop and a key handler unconditionally, so a card that does nothing announced itself to a
   screen reader as something to press. Fixed by per-row activation (`rowActivation`).
2. **A mis-pinned `pinnedView` fell back to the first tab** instead of surfacing, because the host
   applied `?? instances[0]` after the resolver had correctly declined.
3. **Suppressing the switcher on a pinned host did not work** — it was implemented as
   `switcherCount: 1`, but that count is only read by the toolbar's *compact* branch.
4. **The backup panel published no rail**, so every DataView band would have paid a second inset.

### A footgun that cost a build

`web-sdk/CLAUDE.md` documented `slots: [...]`; the implementation takes a record. The runtime guard
is good — it names the plugin and shows both correct forms — but it fires in codegen, ten minutes
into a build, and the doc actively taught the wrong form. Doc corrected here; moving the catch to the
type level is filed separately, since it narrows a framework type every plugin depends on.

---

## Verification — what was actually established

Against deploy `70a77f6e9-1787894472112` (`status: ok`, checks ✓).

**Proven by the e2e suite** (`plugins/build/e2e/runs-surface.ts`, 22/22 against the shipped bundle):
six authored tabs in authored order; the Builds tab excludes deploy and backup, measured against a
same-run snapshot proving all three kinds were in the window; three kinds interleaved; no nested
buttons on either surface; a backup row is a plain container (asserted as "no button ancestor on any
Backup disclosure trigger", so it holds across all 524 rows rather than one constructed one); paging
past page one holds `startedAt desc` across the arm boundary; the pinned host paints no switcher and
shows only backups; group-by offered *and working* for both shared dimensions; the surface left as
found.

**Proven by the manual pass, each against same-instant ground truth:** Active is empty against a
527-row space (empty-vs-full needs no subset reasoning); Shipping shows exactly 2 rows and
terminates where a dropped rule would show 25; Failed settles the `is-any-of` question by count
(`failed` alone matches 21, `failed+partial` 428, and the tab runs off a full page).

**Not established, and labelled rather than assumed:**

- **The Grant access button has never rendered in a browser.** 0 of 524 backup runs carry `ok:false`
  with a `consent` payload, so its condition is never met here — including before this change. It is
  covered by a component test asserting both directions. Seeding a row was declined: constructing
  state in a component test is fine; writing it into the backup ledger, which is the record of
  whether this machine's backups actually ran, to make an assertion pass is not.
- **"All four kinds interleaved"** is permanently undemonstrable in this worktree — zero releases in
  this namespace once scoping applies. Three kinds were demonstrated.
- **The pin's negative half** (that the popover and `/debug/build` still share a selection) is not
  observable: every harness run is a fresh browser context, so localStorage never persists.
- **The rail guard's silence is not evidence** — it is `DEV`-gated and this is a production bundle.

**Investigated and deliberately not acted on:** both surfaces trip the 2000ms slow-op threshold on
cold load (2002–2325ms). Decomposed from a client-boot trace: the union query does not appear in it
at all and Postgres was idle throughout; the app paints at 436ms and commits at 637ms, so everything
over threshold is after render. It is the shared cold-boot path — the eager plugin wave alone is
731ms — and the variance tracks host CPU load, which was this session's own agents and builds. An
in-SPA navigation pays none of it. Making the query faster would buy nothing.
