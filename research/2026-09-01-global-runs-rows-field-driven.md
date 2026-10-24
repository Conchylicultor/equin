# Every run row is single-line, field-driven, and opens a pane

## Context

On `/debug/build` (and in the build popover, and on the Backup panel) the merged
runs DataView's **Properties panel does nothing**. Ticking a field on or off
leaves every row unchanged.

The cause is one line. `RunsDataView` hands the list a `renderRow` override
whenever *any* arm contributes a `Runs.Row`
([`runs-data-view.tsx:127-131`](../plugins/runs/web/components/runs-data-view.tsx)):

```ts
...(rowRenderers.length > 0
  ? { renderRow: (run: UnionRun) => <Runs.Row.Dispatch run={run} /> }
  : {}),
```

`renderRow` replaces the list's field-driven body for **every** row
([`list-view.tsx:296-297`](../plugins/primitives/plugins/data-view/plugins/list/web/components/list-view.tsx)),
so `visibleFields` never reaches it. The guard is per-list; the dispatch it
guards is per-kind. Backup and deploy each contribute a row, so build and
release — which contribute none — get the `GenericRunRow` fallback instead of
the field row, and nobody's Properties panel works.

The custom rows exist for one reason each, and neither is really about rows:

- **Backup** renders an expand/collapse `Collapsible` card (per-source reports,
  per-target outcomes, and a `<GrantAccessButton>` that is the *only* in-app
  repair path for a refused Drive token). It contributes no `Runs.Kind.open`
  **deliberately** — a non-activating row is a plain container rather than a
  `<button>`, which is what lets those controls be real buttons. So the
  disclosure is a workaround for a missing detail pane.
- **Deploy** renders every value as a hand-rolled chip even though all of them
  are already declared arm fields, plus one wrapping `message` line. It
  contributes no `open` because `deploymentDetailPane` is a legacy segment-form
  pane whose ancestor's `serverId` cannot be passed.
- **Release** contributes no row and no `open`: its detail pane nests under
  `compositionDetailPane`, keyed by a composition **uuid**, while
  `release_runs.composition` stores the **name**.

### Outcome

Every row is a single line built from the field schema and obeys the Properties
panel. Every row activates into a detail pane. `Runs.Row`, `GenericRunRow` and
all three custom rows are deleted. `Runs.Leading` stays — a leading indicator is
something the list supports natively.

This is planned as the **end state only**. An interim per-kind gate was
considered and dropped: once no arm contributes a row, the existing
`rowRenderers.length > 0` guard is already correct, so the scaffolding would be
written only to be deleted.

---

## Step 1 — a generic "one run by (kind, id)" read

**This is the load-bearing piece.** There is no way to read one run by id today.
Backup has no live-state resource at all (its `listBackupRuns` endpoint was
deleted in `a0611a78b`), and `build` fakes it —
[`build-info.tsx`](../plugins/build/plugins/build-info/web/components/build-info.tsx)
does `useResource(buildHistoryResource).data.find(r => r.id === runId)` over a
`LIMIT 50` window, so a build older than 50 rows deep-links to a *false* "Run not
found".

Solve it once, generically, in `runs`. Four arms need it.

### Why an endpoint, not a live-state resource

A by-id read is bounded (one row), so the
[bounded-working-set contract](2026-07-18-global-bounded-working-set-resource-contract.md)
is satisfied either way — but only the endpoint shape can reuse the arm
projections:

- `windowQueryResource(…, { point })` compiles **one** drizzle source. The merged
  run space is four tables behind a dynamic registry with per-arm SQL
  (`outcomeExpr()`, `sourceCountExpr`, `durationMsExpr`). Not expressible.
- A hand-written keyed resource needs a single `identityTable` (impossible) or
  `recompute: "full"` (legal but re-queries every subscribed tuple on any arm
  insert).
- **`runs.revision` already exists**, already folds over the registry, already
  ticks on any arm change, and the DataView already refetches on it. The
  primitive is there; the point read through it is what is missing.

Critically, `compileUnionPage` takes `arms` / `base` / `extra` independently, so
passing **the one matching arm** plus **all arms' `extra` specs** projects the
other kinds' columns as the same typed NULLs a listed row carries. **The returned
row is byte-identical in shape to a listed `UnionRun`** — there is no second row
type to keep in sync, and `armText`/`armNumber`/`armJson` decode it unchanged.

### Changes

| File | Change |
|---|---|
| `plugins/runs/core/internal/endpoints.ts` | Add `getRun` — `GET /api/runs/:kind/:id`, response `{ run: UnionRunSchema.nullable() }`, `dedupe: true`. Two-segment path params are well-precedented (`GET /api/history/:sourceId/:entityId/versions`), and `POST /api/runs/query` differs in both method and arity, so there is no shadowing. |
| `plugins/runs/server/internal/arms.ts` | Add `runArmForRow(kinds, kind, id)`: the one arm owning `kind`, its `where` ANDed with `id::text = $id`. Unknown kind → `[]` → empty result. Preserves the arm's always-on scope, so the list and the deep link cannot disagree about visibility. |
| `plugins/runs/server/internal/handle-get.ts` | **New.** `compileUnionPage({ arms: runArmForRow(…), extra: armFieldSpecs(kinds), limit: 1 })`, `executeRows` against `UnionRunSchema`. |
| `plugins/runs/server/internal/query-defaults.ts` | **New.** Lift `DEFAULT_SORT` + `resolver` out of `handle-query.ts` so the two reads cannot drift. |
| `plugins/runs/web/internal/use-run.ts` | **New.** `useRun({kind,id}): RunRead`, a four-state union — `pending` / `error` / `missing` / `found`. Four, not three: folding `error` into `missing` makes a transient 500 claim the run does not exist. The tick stays **out of the query key** and drives an in-place `refetch()` from an effect (the pattern in `use-server-data-source.ts:114-122`), so a running backup updates without flashing pending. |
| `plugins/runs/web/internal/arm-value.ts` | Add `armJson(specs, id, schema)`. A genuine gap in the family — [`payload.ts`](../plugins/backup/plugins/runs-arm/core/internal/payload.ts) currently hand-indexes the catchall, which `runs/CLAUDE.md` tells arms never to do. Same `bind` + `read` contract as `armText`/`armNumber`: `IdsWithType<S,"json">` rejects a wrong id, a null column is an answer, a wrong shape throws (the zod parse *is* the throw). `ZodParser` is a type-only import, so `runs/web` gains no zod runtime dep. |

---

## Step 2 — `message` becomes an ordinary truncating field

`message` **is already a declared `FieldDef`**
([`fields.tsx`](../plugins/runs/web/internal/fields.tsx)) — it just carries a
custom `cell` rendering `whitespace-pre-wrap` with a `title` tooltip. That
wrapping span is the single thing fighting the single-line row: the list's
one-line branch is a `region-line` + `SingleLineProvider` context where every
`<Text>` ellipsizes without asking.

It is non-null on only **two** arms — release (`release_runs.error`) and deploy
(`deploy_runs.message`). Build and backup both project `message: null`
deliberately, so on `/debug/build` it never renders at all.

- Drop the custom `cell`. The default `TextCell` is `<span className="truncate">`.
- Set `visible: false`, joining `finishedAt`. The failure is already stated by
  `outcome` (the leading dot), and more precisely by `build.status` /
  `deploy.phaseFailed` / `*.exitCode`. `message` stays sortable/filterable/
  searchable and one tick away in Properties.
- **Search is unaffected**: `RUN_SEARCH_COLUMNS` already lists `"message"`, and
  server-side full-text search is independent of the `visible` UI flag.
- **The verbatim text is not lost, but the two arms differ** — worth stating
  precisely rather than assuming symmetry:
  - *Deploy*: `run-cell.tsx:78-81` renders `last.message` with
    `whitespace-pre-wrap`, unclamped. Direct.
  - *Release*: `release-info.tsx` renders **no** error text at all — only a
    `StatusBadge` reading `"Failed (exit N)"`. The string does survive, because
    `run-release.ts:235` publishes the same text into the release log stream,
    which `release-log-section.tsx` renders verbatim. So it is reachable via
    **Logs**, not a dedicated error display. If that is judged too indirect,
    adding an error line to `release-info` is a small, separate change.
- `TextCell` provides **no** title tooltip. If a user opts `message` back on via
  Properties they get truncation with no hover-reveal — down from today. Giving
  `TextCell` an optional truncation tooltip is a primitive-level concern that
  many text fields would benefit from; do **not** bolt it onto this field's
  `cell` as a one-off.

**Do not add `align: "end"` to anything yet.** No runs field sets it today, so
the trailing cluster is empty and every field lands in the subtitle run. Whether
`duration`/`startedAt` should move right is a real question, but it is a
different one — see Open questions.

---

## Step 3 — backup gets a run-detail pane

### First: move `BACKUP_RUN_KIND` to `plugins/backup/core/`

**This is a prerequisite, not a detail.** `backup/web/panes.tsx` will need the
kind constant, and `runs-arm/web` will need `backupRunPane` from `backup/web` —
that closes `backup → backup.runs-arm → backup`, a cycle at plugin granularity.

This exact trap is documented in
[`build/plugins/runs-arm/CLAUDE.md`](../plugins/build/plugins/runs-arm/CLAUDE.md),
including the warning that the "different runtimes, so it's fine" argument is
**wrong** — the cycle rule collapses to plugin granularity, and there is no
parent/descendant exception. Build solves it by keeping `BUILD_RUN_KIND` in a
third plugin (`run-ledger/core`); `build/web` imports it from there, never from
the arm.

Backup's fix is simpler: `plugins/backup/core/` already exists and is the
*parent's own* core, so `backup/web → backup/core` is intra-plugin and always
legal. Move `runs-arm/core/internal/kind.ts` there; the arm's three runtimes
import it from the parent. **Do not re-export it from the arm's core** —
cross-plugin re-exports are banned transitively and would put the edge straight
back.

Verify with `./equin check plugin-boundaries`, not by argument.

### Routes and panes

`plugins/backup/core/routes.ts` (new):

```ts
export const backupRoute = defineRoute({ id: "backup", segment: "backup" });
export const backupRunRoute = defineRoute({
  id: "backup-run", segment: "r/:runId", parent: backupRoute,
});
```

`defineRoute({ id })` *is* the pane id, so `id: "backup"` reproduces the existing
one verbatim and the `slots` record and sidebar entry are untouched.

**Fix `segment: "debug/backup"` → `"backup"`.** `debugApp.basePath` is already
`/debug` and every sibling debug pane uses a bare segment (`health`, `logs`,
`profiling`, `boot-profile`, …), so the pane sits at `/debug/debug/backup`
today. Left alone, the child becomes `/debug/debug/backup/r/:runId` and the
doubled segment is baked into every shared link. **This breaks existing
bookmarks** — a deliberate, called-out cost, in a debug app.

`plugins/backup/web/panes.tsx` — rewrite to the `route:` form, and give the
detail pane a **real `resolve`** backed by `useRun` (not `resolve: false`). This
is a direct dividend of Step 1: `buildDetailPane` opts out only because it has no
by-id read, so its miss surfaces as an in-body string instead of the primitive's
own Loading / Not Found chrome. Map `error → { pending: false, found: false }`.

### Sections

`plugins/backup/web/slots.ts`: `defineDetailSections<{ run: UnionRun }>()` —
keyed by the **run**, not the runId. `BuildDetail<{runId}>` passes an id only
because each section must re-read a collection; here the pane resolves the row
once, so "not-known-yet" is handled in exactly one place.

Two sections contributed from `runs-arm/web`, using `useAvailable` (the host
paints the card before the body, so `return null` is not enough) and
`useDefaultOpen` on Targets when any target failed — the section holding the only
repair path opens itself, which is strictly better than today's collapsed
disclosure.

**Two sections, not two sub-plugins.** The modularity the split buys is already
bought by the slot: both decode two jsonb columns off the *same* row with the
*same* decoders, owned by the same arm. The seam is there for when
`backup/targets/google-drive` wants its own section — that is when a sub-plugin
is warranted.

### The two jsonb columns stay on the list projection — corrected

I originally planned to drop `backup.targetResults` / `backup.sources` from
`backupRunFields` and the arm's `extra` map once the detail moved to a pane, on
the grounds that shipping two blobs on every row of every page to feed one
expanded card is waste.

**This is not possible, and the reason is load-bearing.** Verified during
implementation: the list read and the by-id read share **one** projection —
`handle-get.ts` passes `extra: armFieldSpecs(kinds)`, which merges each arm's own
`defineRunArmFields` declaration, and `runArmForRow` reuses `runArms([found])`,
whose columns come from the same `defineRunKind` `extra` map. That sharing is
exactly what makes a by-id row byte-identical to a listed row, which is what lets
the detail sections decode it with the same accessors and keeps a second "detail
row" type from existing.

So removing the columns would blind the pane, not slim the list. They stay.

Trimming the list's payload would need **per-read column selection** in
`union-query` (a detail read that projects more than a list read). That does not
exist today and is a genuine follow-up — recorded in the arm's `CLAUDE.md` so the
next reader does not re-attempt what was just tried.

### Also

- Move `backupSources` / `backupTargetResults` from `runs-arm/core/internal/
  payload.ts` to `runs-arm/web/internal/`, rewritten on `armJson`. Their only
  consumers become web. Drop them from the arm's core barrel.
- `backup-panel.tsx` keeps its role, gains `selectedRunId`. Its `max-w-5xl`
  comment argues for the width **because the chevron wrapped onto its own line
  on every row** — that symptom is gone, so re-measure and either narrow it back
  or rewrite the comment. A comment citing a removed symptom is worse than
  either.

---

## Step 4 — deploy rows activate (convert the pane chain to the route form)

The merged deploy row **already carries both params the pane needs**:
`deploy.serverId` and `deploy.deploymentId` are declared arm fields and both are
**non-nullable**. Nothing is missing but the pane's form.

In the legacy form a pane's params are `ParentParams & InferParams<Path>`, and
`ParentParams` appears only in contravariant positions (`chrome.title`,
`useTitle`) so nothing supplies it and it defaults to `{}`. At runtime `openPane`
*would* accept a `serverId` — `extractOwnParams` reads ancestor `:param` names
out of the flat bag — but the type will not let one be passed. So the pane opens
correctly only from the server page, where the ancestor is already in the route
and its params are inherited.

Conversion is **per-chain, root-first**: `defineRoute({ parent })` takes a
`RouteDef`, not a pane. Convert all three, in `plugins/apps/plugins/deploy/`.

**A segment-less root route is expressible — no primitive change needed.** The
registry-sync guard only throws `if (internal.segment && internal.segment !== "/")`
(`pane.ts:2125`), so `defineRoute({ id: "deploy-servers", segment: "" })` is
legal and `fillSegment("")` contributes nothing to the path.

```ts
// servers/core/routes.ts
export const serversRoute = defineRoute({ id: "deploy-servers", segment: "" });
export const serverDetailRoute = defineRoute({
  id: "deploy-server-detail", segment: "server/:serverId", parent: serversRoute,
});
// deployments/core/routes.ts
export const deploymentDetailRoute = defineRoute({
  id: "deploy-deployment-detail", segment: "dep/:deploymentId",
  parent: serverDetailRoute,
});
```

`defineRoute({ id })` *is* the pane id, so all three ids are reproduced verbatim.
Put the `RouteDef`s in `core/` (as build and Studio do) so server code can build
the same link. No cycle here: `servers` imports nothing from `deployments`, so
`deployments/core → servers/core` is a new one-directional edge — unlike Step 3,
where the return edge already exists. Confirm with the check anyway.

**This is the repo's first true two-level param chain** (build's and Studio's
both have a paramless root), so two things are new and worth a deliberate `tsc`
pass — both benign:

- `deploymentDetailPane.useParams()` now returns the full chained
  `{ serverId, deploymentId }`. Existing call sites destructure only
  `deploymentId`, so nothing breaks.
- `useResolveDeployment` / `useDeploymentTitle` are declared against
  `{ deploymentId }` only and stay assignable by ordinary parameter
  contravariance. No signature change needed.

Call sites: `deployments-section.tsx:187` opens with `{ deploymentId: d.id }` and
becomes `{ serverId, deploymentId: d.id }` — `serverId` is already a prop of the
enclosing body, so it is a one-line addition. `:120`'s
`useRouteEntry()?.params.deploymentId` is unaffected, and `servers-list.tsx` is
untouched (`serverDetailPane`'s params are still exactly `{ serverId }`).

Then the arm gains `open` and **`DeployRunRow` is deleted** — every value it
renders is already a field, **including the 8-char commit truncation**:
`deploy.commitSha`'s cell already does `v.slice(0, 8)` inside a
`<Badge mono title={v}>`, tooltip included. Nothing to move.

`open` is a plain callback, so guard the two ids. Both columns are `.notNull()`
on `deploy_runs`, so a null is unreachable for a deploy row — which is exactly
why the guard should **throw** rather than `return`: it is an assertion about an
impossible state, and a silent return would be the "click that quietly does
nothing" this codebase rejects elsewhere.

---

## Step 5 — release rows activate

`releaseDetailPane` is legacy-form, `segment: "rel/:runId"`,
`defaultAncestors: [compositionDetailPane]`, `resolve: false`.

**Recommendation: reparent it onto the paramless `compositionsRoute`, not onto
`compositionDetailRoute` (`comp/:id`) — do not resolve name → uuid.** Every
section it renders (`release-info`, `release-logs`, `release-artifact`) fetches
via `useResource(releaseRunResource, { id: runId })`, a point resource on the
`release_runs` primary key. The `compositionDetailPane` ancestor supplies **no
data at all** — it is purely breadcrumb position.

```ts
// release/core/routes.ts
export const releaseDetailRoute = defineRoute({
  id: "release-detail", segment: "rel/:runId", parent: compositionsRoute,
});
```

This makes the uuid problem *moot* rather than solved. `Params` is `{ runId }`,
so **`release-history-section.tsx`'s call site is unchanged** and still
type-checks as written.

The alternative — keeping the nesting and resolving via the existing
`useManifestItemByName` — is worse: `Runs.Kind.open` is a plain callback and
cannot call hooks, so it would need an imperative config read at click time, to
buy a breadcrumb.

**Nothing is lost today.** A route parent is only a hint for opening from
scratch ("does NOT constrain where the pane can appear" — `pane/CLAUDE.md`), and
`ReleaseHistorySection` opens with `mode: "push"` from *inside* the composition
pane, so the pane still nests under it exactly as now. The only behaviour that
changes is a fresh open with no caller context — a bare deep link, or a click
from the merged runs list — and today that case does not work at all. This is a
fix, not a regression.

Then the arm gains `open` (two lines, matching build's precedent). Release
contributes no row, so there is nothing to delete.

---

## Step 6 — delete the slot

- Rename `web/components/generic-run-row.tsx` → `generic-run-leading.tsx`,
  keeping only `GenericRunLeading`. **It must survive** — it is the
  `Runs.Leading` fallback (the shared outcome dot).
- **`RunRowProps` must survive** — `Runs.Leading` is typed by it. Move the
  one-line interface into `web/internal/slots.ts` (which currently imports it
  *from* the deleted file — invert that edge). The **public** path
  `@plugins/runs/web` is unchanged, so `build-run-leading.tsx` needs no edit at
  all; only `web/index.ts`'s re-export source changes.
- Remove the `Runs.Row` slot from `slots.ts`, and from `runs-data-view.tsx` both
  the `rowRenderers` line and the `renderRow` spread; `viewOptions.list` keeps
  only `leading`. Keep the `defineDispatchSlot` import — `Leading` still uses it.
- Delete `BackupRunRow` and `DeployRunRow`. `backup/runs-arm/web/internal/
  format-bytes.ts` **stays** — it is shared with `backup-run-fields.tsx`.
- `runs-arm/web/__tests__/backup-run-row.test.tsx` — rewrite as a detail-section
  test asserting the same two things (the **Grant access** button on a
  consent-refused target; the manifest's source items) against the sections
  directly. It is the only place asserting those exist at all, so it must be
  rewritten, not dropped. No other test references any deleted component.

### Docs that currently assert the opposite

- `plugins/runs/CLAUDE.md` — "Presentation is dispatched; schema is not" loses
  `Runs.Row`; the "`renderRow` is only handed to the list when at least one arm
  contributes one" paragraph is now **false** (no arm *can* contribute one) —
  replace with "the list is unconditionally field-driven". The "Adding an arm"
  seam list drops `Runs.Row`. The paragraph explaining that release's pane wants
  a uuid it cannot resolve is **stale** after Step 5 — replace with the general
  principle and how deploy and release each actually resolved it. Add the by-id
  read and `armJson`.
- `plugins/backup/plugins/runs-arm/CLAUDE.md` — the whole "contributing no `open`
  is what makes the row work" section becomes false. **Keep** the "Grant access
  is the only repair path" paragraph — still load-bearing, now about a section.
- `plugins/apps/plugins/deploy/…/runs-arm/CLAUDE.md` — the "no row activation,
  and what it would take" section is resolved by Step 4. Its "`message` is
  rendered verbatim" section stays accurate.
- **Both** `kind.ts` docstrings — backup's *and* deploy's — say the discriminator
  is load-bearing in "four places… the `Runs.Row` dispatch key". Trim to three.
- **Hand-authored `description` strings** in four `web/index.ts` files (`runs`,
  and the backup / deploy / release arms) mention `Runs.Row` or "contributes no
  row activation". These are the *source* the `<!-- AUTOGENERATED -->` reference
  blocks regenerate from, so edit them by hand and let `./equin build`
  propagate.

---

## Verification

1. `./equin check plugin-boundaries` — **specifically** after Step 3's
   constant move and Step 4's route files. This is the check that catches the
   cycle; do not reason about it.
2. `./equin build` (background, per CLAUDE.md), then
   `http://<worktree>.localhost:9000/debug/build`.
3. **The original bug:** open Properties, untick `Kind` and `Namespace` — rows
   must change. Tick `Finished` — it must appear. This never worked before.
4. Every row is one line at the narrow width of the build popover; nothing wraps.
5. Click a row of each kind — build, backup, release, deploy — each opens its
   detail pane. Backup's Targets section is open when a target failed and shows
   **Grant access**.
6. Deep-link a backup run URL directly (fresh tab): it resolves, rather than
   showing Not Found. Deep-link a nonexistent id: the pane's Not Found chrome,
   not a spinner.
7. `./equin test plugins/runs plugins/backup` and the pane suites under
   `plugins/primitives/plugins/pane`.
8. `query_db` on `backup_runs` to pick a real id for step 6.

---

## Open questions

- **What the single-line row should show by default.** Seven fields are visible
  today (`kind`, `outcome`, `trigger`, `namespace`, `duration`, `startedAt`, and
  `message` until Step 2) and `outcome` is *also* the leading dot — redundant in
  the list, wanted in the table. The answer is per-view `visibleFields` in
  [`config/runs/runs.jsonc`](../config/runs/runs.jsonc), which none of the six
  views sets today; a `kind`-scoped tab (Builds, Backups) does not need the
  `kind` badge on every row. This is a config edit and now genuinely user-fixable
  once the Properties panel works.
- **Backup's absolute timestamp.** The old collapsed line showed both relative
  *and* absolute start time, with a stated reason ("a backup is the one run
  someone audits after the fact, and '3 days ago' is not a date"). A field-driven
  row loses it. Decide deliberately — `startedAt`'s cell rendering both, or an
  opt-in absolute field — rather than by omission.
- **Backup's arm fields default hidden.** All four (`status`, `archiveSize`,
  `sourceCount`, `targetCount`) are `visible: false`, so the `backups` view's
  rows would say less than the old card did. Same config edit as above.
- **`runs.revision` granularity.** The tick fires on *any* arm change, so an open
  detail pane refetches its one row on every build. One indexed pk lookup —
  negligible, and it is what makes a running backup live. State it so nobody
  "optimises" it into staleness. Note a run outside the 50-row fingerprint window
  hydrates once and never ticks; fine, old runs are finished.
- **Arm scope becomes user-visible.** `runArmForRow` keeps each arm's always-on
  `where`, so a build from another worktree deep-links to Not Found. Correct and
  consistent with the list, but it is a *new* surface for a rule that previously
  only hid rows — worth a line in `runs/CLAUDE.md`.

## Follow-ups this unlocks (not in scope)

- `BuildInfo` drops its `.find()` over a 50-row window for `useRun`, making old
  builds deep-linkable and killing the false "Run not found".
- `buildDetailPane` gains a real `resolve` instead of `resolve: false`.
- The legacy `Pane.define` segment form is removed repo-wide —
  filed as `task-1788262972344-he1xod`. Steps 3–5 convert three of the ~111
  remaining call sites.
