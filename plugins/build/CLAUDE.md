# build

Auto-build is a **convergence loop on "this checkout's HEAD is what is
deployed"**, not a queue of push events: a request that arrives while a build is
in flight is DROPPED — its claiming INSERT loses the in-flight index — so the
request is re-derived rather than remembered. `reconcileDeployment` (`internal/reconcile.ts`) is that
re-derivation, and it **takes no argument** — there is no baseline to carry, so
nothing is lost when a build kills the process that would have carried one.

It runs at five edges: the target moving (`buildRunJob`, on the durable
`refAdvanced` trigger), a build reaching terminal (the build job's `onEnded`,
`internal/run-state.ts`), this backend starting (`onReady`), the
`compositions` config changing (`watchConfig`), and the `build.composition-tick`
cron. The decision is stateless and idempotent,
so an extra edge is free and a missed edge degrades to "converges at the next
edge". `buildRunDebouncedJob` re-derives it again before spawning, which makes
the debounce a coalescing optimisation rather than a correctness mechanism.

The decision itself is NOT here — it is the pure `wantsBuild` in
`plugins/deployment/core`, over the pins that plugin owns, plus the pure
`compositionWantsRebuild` in `internal/composition-trigger.ts` for the served
compositions. `internal/wants-build.ts` only binds them to db/config and to the
main-only scope, in ONE `decideBuilds(now)` so every edge re-derives both halves
from one read. Read `plugins/deployment/CLAUDE.md` before touching any of it.

## The composition arm of the same loop

A served composition drifts: `sonata.localhost:9000` keeps running the dist and
the server tree of whatever commit last happened to build it. So the loop covers
it too, by the same mechanism rather than a new one — the manifest row's `serve`
mode contributes exactly ONE clause, a rate limit, and everything else is the
same `wantsBuild` main's own build runs, with the `composition.json` marker
modelled as the single `web` carrier.

Two things that look like omissions and are not:

- **A marker-less composition is never auto-built.** An automatic trigger may
  not MINT a namespace — claiming one provisions a gateway registry dir, a
  database and a spec dir, and pressing **Serve** is the only thing allowed to do
  that.
- **Main only**, both halves. `refs/heads/main` is tracked by every backend on
  the host, so a per-worktree scope would have every live agent worktree
  rebuilding the same compositions off one push — the fan-out
  `events.refresh-tick` refuses for its own cadence. The explicit Serve /
  Rebuild buttons still work everywhere.

Main's own build wins when both want one: a build claims a single durable
in-flight slot and the claim is target-blind, and the main build's terminal edge
reconciles again, so the composition build follows rather than being lost.

The commit gate answers "has the tree moved", so editing a composition's own
manifest row (contributors, entry points, `extends`) is deliberately NOT an
automatic trigger — **Rebuild now** is, and it is available in every mode for
exactly that reason.

## A run has TARGETS, not a target

`build_runs.targets` is a `text[]` of composition ids: `{singularity}` for a
plain build of this checkout's own app, or the ids of a
`./singularity build --composition a b`. One invocation is one shared build — one
install, one codegen, one checks pass, one transcript, one profile, one verdict —
so it is ONE row with N chips, and the history DataView renders the column as a
`tags` field (match-any filtering comes free). `isMainCompositionBuild(targets)`
(`build/core`) is the one answer to "is this a plain build?", so no surface spells
a literal. The old scalar `target` column is gone: the CLI's ledger INSERT now
names its own columns instead of going through drizzle's `.values()` (which names
EVERY column in the table def), so a column added by this same build no longer
breaks the CLI's write — see `run-ledger/CLAUDE.md`.

`buildJob.enqueue({ trigger, compositions })` is what the Serve button reaches:
it claims the same single in-flight slot and spawns `build --composition a b c`,
which publishes each `<id>.<checkout>.localhost:9000` from THIS checkout. The
field is a SET so N drifted compositions are one shared invocation, not N runs
queued behind each other's `.build.lock`; an empty set is rejected by the input
schema at the enqueue rather than quietly meaning "the main app".

The slot is target-blind on purpose: a live `build --composition sonata` in this
checkout makes a plain auto-build request be dropped. That is correct, not an
oversight — the per-checkout `.build.lock` serializes the two anyway, so the
second would only queue behind the first and then rebuild a tree that has not
moved. Do not "fix" it by scoping the index per target.

## The build is a supervised JOB

`./singularity build` is a **supervised job**
(`@plugins/infra/plugins/jobs/plugins/supervised-job`) named
`build.run.supervised`, declared once in `internal/run-build.ts`. There is no
`triggerBuild` any more and nothing calls a spawner directly: every request —
the Build button, the Serve button, the auto-build debounce — is
`buildJob.enqueue({ trigger, compositions? })`.

The wrapper composes `defineJob` + a `supervised-run` kind + `ctx.waitFor`, and
the handler is short at both ends and empty in the middle: claim the row, spawn
the detached child, SUSPEND. `ctx.waitFor` returns from the handler through the
jobs plugin's suspend sentinel, so a 20-minute build holds a worker slot for
milliseconds and the workflow comes back as a fresh dispatch when the child's
exit marker lands. Read `supervised-job/CLAUDE.md` before changing any of it.

What each arm of `internal/run-build.ts` owns, and why the split is where it is:

- **`claim`** — `claimBuildRun`, and the claiming INSERT against
  `build_runs_inflight_uniq` IS the lock. A request that loses returns `null`,
  the handler stops, and nothing is queued: auto-build is a convergence loop, so
  the request is re-derived at the next edge. The `auto` "started" bell is rung
  here, which is the last moment this plugin owns before the child exists.
- **`argv`** — `--allow-main` before `--composition` (commander's variadic is
  greedy up to the next flag), plus the two env overrides that are ADDED to the
  backend's own environment: `SINGULARITY_BUILD_ID`, and
  `SINGULARITY_BUILD_DETACHED`, which is what stops the CLI's orphan guard from
  killing a build whose invoking backend it is about to restart.
- **`closeRow`** — the bare `WHERE finished_at IS NULL` stamp of `finished_at` +
  `exit_code`, and NOTHING else. It runs in the supervised-run reconciler of
  every backend that sees the marker, including one that knows nothing about the
  workflow, and that is what stops a dead workflow from leaving the in-flight
  index held against every future build.
- **`onEnded`** — the terminal WORK, exactly once, in the owning workflow: the
  bell, `deploymentServed.notify()`, and `reconcileDeployment()`. **The row is
  already closed by the time this runs** — the CLI stamps its own row ~100 s
  before its child exits, and failing that `closeRow` runs before the
  announcement that resumes the handler. So nothing here is gated on
  `finished_at IS NULL`; the row is read BACK and the bell describes what the
  ledger carries.

`runAttempts` stays at the default **1**. A failed build stays failed and
visible; whether to build again is the convergence loop's call, made from the
state of the world, not a retry budget. And a non-zero exit code is DATA, not an
exception: the handler records it and returns normally, so a failed build files
no crash report and no dead-letter.

What that buys, and what moved:

- **Nothing waits for a build.** A caller enqueues and returns. Everything that
  used to sit after `await proc.exited` — the bell, the row's terminal stamp,
  `reconcileDeployment` — is now the durable workflow's, resumed by whichever
  backend is alive when the exit marker lands. **This is a repair, not a
  refactor:** the build restarts the backend that spawned it, so the process
  holding that await was routinely killed first. On `main`: 33 `Auto-build
  started` bells against **2** `Build succeeded` bells, ever. The only failures
  that notified were the ones that failed before the deploy step.
- **The in-process `inflight` boolean is gone.** It only ever collapsed two
  clicks inside one process, and the durable claim already does that across all
  of them. So is `failUnstartedBuild`: closing a claimed row whose spawn threw
  is `spawnClaimedRun` in the wrapper now, once for build, release and deploy.
- **The build log keeps scrolling across the restart.** The child's output goes
  to a transcript FILE and the supervisor publishes by tailing it, so the new
  backend re-attaches to a build already in flight. With a pipe it stopped dead
  at the restart and never resumed.
- **`reconcileOrphanBuilds` and `watch-inflight-build.ts` are deleted.** They
  were the two halves of the primitive's one reconciler. So is
  `hasLiveInflightBuild`: the claiming INSERT against `build_runs_inflight_uniq`
  is the lock, and a pre-flight pid probe in front of it was a TOCTOU window plus
  a second copy of the liveness question.
- **`build-logs-<id>.json` did two jobs and only one moved.** Its
  `exitCode` + `finishedAt` were the terminal record — that is the exit marker's
  job now, written by the shim for any command rather than by a CLI that
  remembers to. (One reader remains: the claim-time settle of a dead holder of
  the in-flight index reads its `exitCode` and mtime, because a hand-run build
  has no shim and no exit marker — see `run-ledger/CLAUDE.md`.) Its `steps` are
  structure only the build itself can know, so the CLI still writes them and
  nothing changed there. `recoverBuildArtifacts`, which
  reconstructed a one-step stand-in from the parent's pipe for a hard-killed
  build, is gone: the recovery moved to the READ path, where `build-logs`
  synthesises the same single block from the child's own transcript — which
  exists even when the parent died too, the case the old backstop could not
  cover.

### Why the convergence loop still terminates

The loop is `onEnded → reconcileDeployment → build.run.debounced →
buildJob.enqueue → onEnded`, so the question is whether a finished build can
immediately ask for itself again. It cannot, and the reason is an ORDERING that
the migration preserves by construction: `closeRow` writes `finished_at` +
`exit_code` **before** the `runEnded` announcement that resumes the workflow, so
by the time `onEnded` reconciles, `lastClosedAttempt` already sees this build's
own commit as an attempt and `wantsBuild` answers no. (Before the migration the
same ordering held for a different reason — `finishBuild` stamped the row as its
first statement and reconciled as its last.)

The two other edges of the same argument:

- A build whose SPAWN failed never reaches `onEnded` at all, so it never
  reconciles — while `spawnClaimedRun` still closes its row with the hard-kill
  sentinel. The attempt is recorded, `ok` is false, and the loop does not
  re-derive it into a five-second retry storm.
- A request that arrives mid-build is dropped by the claim, not queued, so N
  edges firing during one build produce N cheap `instant` dispatches and one
  build.

## The build history — `buildHistory`

`build.history` is a live collection (`core/resources.ts`) over `build_runs`,
served by `serveCollection` with a base `where` of this backend's own namespace
(`server/internal/build-history-resource.ts`): a worktree DB is forked from
main, and unscoped it would surface main's stale runs as this checkout's own.
Its row is `BuildRunSchema`, so the ledger's internal `pid` never reaches the
wire.

- **The window** — newest `startedAt` first, 50 a page (at most 100: every
  window is read as key-range pages, and a page that splits is read at twice
  its step), declared `preload: "boot"`: the Build button's label is
  first-paint chrome, so the boot snapshot hydrates the default window. All
  four list readers take the default window, `useLive(buildHistory)`, and none
  pages past it: the button, the popover and the build-activity hook read its
  newest rows, and `serve-composition`'s freshness signature folds it for the
  newest finished run naming its composition. A window is never
  L2-persisted, so a cold boot loads its 50 rows fresh.
- **One run** — `build-info` and `build-fix` read
  `useLiveRow(buildHistory, runId)`, the `:rows` point read: a run older than
  the newest 50 is still found, and `found: false` means this namespace has no
  such run.

The list of runs is NOT this collection: it is the merged `runs` surface, which
pages every ledger off its own keyset query (`runs-arm`).

## The toolbar control — wrench, tray, Reload pill

`BuildButton` (`ActionBar.Item`) is one quiet ghost wrench while there is
nothing to say: no build running, no failure, no reload due. Anything to report
turns it into the **tray** (`components/build-tray.tsx`): one faint pill (the
`sunken` surface role, which also re-publishes `--hover-fill` a step further so
the ghost status inside still hovers) holding the status as a ghost text button
— a ring spinner (`Spinner shape="ring"`) and "Building" + elapsed time, "Server restarting…", "Server
updated", or "Build failed" with a solid-destructive dot — and, when a reload
is due, the **Reload pill** nested at its end. A failed build rings the tray in
`destructive-solid` at 45%.

`ReloadButton` (`components/reload-button.tsx`) is the ONE Reload control: a
filled pill at the control height in the solid fills (`info-solid` when the tab
is only stale, `destructive-solid` when something already fails), named by its
full `reload-copy.ts` message. Its label is the solid foreground with 18% of
the fill mixed back in (a tinted light, not stark white); its glyph end keeps
the plain control padding and only the label end takes the pill's extra. The collapsed bar's `ActionBar.Glance` is
`ReloadGlance`: the same tray holding only `ReloadButton`, so Reload is the same
control whether the bar is open or closed. The chrome theme deepens the solid
fills to navy and oxblood — see `apps-core/chrome-theme`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Trigger `./singularity build` from the toolbar.
- Web:
  - Slots:
    - `BuildDetailSlots.Section`
    - `buildPane.Actions`
    - `buildDetailPane.Actions`
  - Slot contributors:
    - `BuildDetailSlots.Section` ← `build.build-commits`
    - `BuildDetailSlots.Section` ← `build.build-fix`
    - `BuildDetailSlots.Section` ← `build.build-info`
    - `BuildDetailSlots.Section` ← `build.build-logs`
    - `BuildDetailSlots.Section` ← `build.build-profiling`
    - `buildPane.Actions` ← `primitives.pane`
    - `buildDetailPane.Actions` ← `primitives.pane`
  - Contributes:
    - `IdKinds.Kind` "build"
    - `ActionBar.Item` → `BuildButton`
    - `ActionBar.Activity` "build"
    - `ActionBar.Glance` → `ReloadGlance`
    - `Pane.Register` "build"
    - `Pane.Register` "build-detail"
    - `DebugApp.Sidebar` "Builds"
    - `ConfigV2.WebRegister` "config"
  - Uses: 36 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×4
    - `primitives/live-state` ×4
    - `infra/endpoints` ×2
    - `primitives/log-channels` ×2
    - `primitives/pane` ×2
    - `apps-core/tabs.appLink`
    - `apps/debug/shell.DebugApp`
    - `build/deployment.DeploymentChain`
    - `config_v2.ConfigV2`
    - `ids.IdKinds`
    - `network/live.useLive`
    - `primitives/css/line.Line`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Stack`
    - `primitives/css/spinner.Spinner`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/text.Text`
    - `primitives/detail-sections.defineDetailSections`
    - `primitives/icon-button.IconButton`
    - `primitives/link-gesture.activationProps`
    - `primitives/loading.Loading`
    - `primitives/overlay/popover.InlinePopover`
    - `primitives/relative-time.ElapsedTime`
    - `runs.RunsDataView`
    - `shell/action-bar.ActionBar`
    - `shell/notifications.toast`
    - `ui/icons.Icon`
  - Exports (types): `ReloadAdvice`
  - Exports (values):
    - `buildDetailPane`
    - `BuildDetailSlots`
    - `buildPane`
    - `useReloadAdvice`
    - `useStaleFrontend`
- Server:
  - Contributes:
    - `ids.kind` "build"
    - `ConfigV2.Register` "config"
    - `taskCategory` "build"
    - `resource.declare` "build.history"
    - `resource.declare` "build.history:groups"
    - `resource.declare` "build.history:rows"
    - `trigger` "build.run"
  - Uses: 25 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/paths` ×4
    - `config_v2` ×3
    - `build/deployment` ×2
    - `build/run-ledger` ×2
    - `infra/endpoints` ×2
    - `database.db`
    - `ids.IdKinds`
    - `infra/events.Trigger`
    - `infra/file-watcher.defineFileWatcher`
    - `infra/git/git-watcher.refAdvanced`
    - `infra/jobs/supervised-job.defineSupervisedJob`
    - `infra/jobs.defineJob`
    - `infra/worktree.readCompositionMarker`
    - `network/live.serveCollection`
    - `primitives/log-channels.Log`
    - `shell/notifications.recordNotification`
    - `tasks/task-category.TaskCategory`
  - Exports (values): `onRunTerminal`
  - Register:
    - `defineJob('build.run')`
    - `defineJob('build.run.debounced')`
    - `defineJob('build.composition-tick')`
    - `defineSupervisedJob('build.run.supervised')`
    - `defineFileWatcher('build.run-terminal')`
  - Resources:
    - `build.history` (keyed, window)
    - `build.history:groups` (push)
    - `build.history:rows` (keyed, point)
  - Routes:
    - `POST /api/build`
    - `POST /api/build/serve`
- Core:
  - Uses:
    - `build/run-ledger.buildRunFields`
    - `fields.fieldsToZodObject`
    - `infra/endpoints.defineEndpoint`
    - `infra/namespace.MAIN_COMPOSITION_ID`
    - `network/live.liveCollection`
    - `primitives/pane.defineRoute`
  - Exports (types): `BuildRun`
  - Exports (values):
    - `BUILD_CATEGORY_ID`
    - `BUILD_LOG_CHANNEL`
    - `buildDetailRoute`
    - `buildHistory`
    - `buildRoute`
    - `BuildRunSchema`
    - `isMainCompositionBuild`
    - `serveCompositionEndpoint`
    - `triggerBuildEndpoint`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive-solid`
    - `ui/tokens/color-palette --destructive-solid-foreground`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --info-solid`
    - `ui/tokens/color-palette --info-solid-foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --control-gap-sm`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/shape --pill-pad-extra`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-semibold`
  - Imported by:
    - `active-data/build-run`
    - `build/build-commits`
    - `build/build-fix`
    - `build/build-info`
    - `build/build-logs`
    - `build/build-profiling`
    - `build/runs-arm`
    - `debug/reports`
- Shared:
  - Exports (types): `BuildRun`
  - Exports (values):
    - `buildConfig`
    - `isMainCompositionBuild`
- Sub-plugins:
  - **`build-commits`** [exempt] — Commits included since the previous build, shown in the build detail pane. Per-run commit list data endpoint.
  - **`build-fix`** [exempt] — Launch-agent button in the build detail pane for failed builds.
  - **`build-info`** [exempt] — Status, trigger, commit hash, and timing section in the build detail pane.
  - **`build-logs`** [exempt] — Live log stream section in the build detail pane. Per-run build log data endpoint.
  - **`build-profiling`** [exempt] — Per-run build profiling Gantt section in the build detail pane. Per-run build profiling data endpoint.
  - **`build-status`** — Single source of truth for build-run status display metadata — label, badge variant, and dot color per BuildStatus.
  - **`build-termination`** — Per-run termination endpoint: what the host-global signal-origin sink recorded about the death of one build run (which signal, and who sent it).
  - **`deployment`** — The client half of the deployment description: `useDeployment()` composes THIS tab's own baked pin in beside the server's two deployable carriers, and `<DeploymentChain/>` renders the four arms…
  - **`run-ledger`** — Build-runs ledger leaf: the build_runs entity, and (cli/) the hand-SQL build-run recorder the `./singularity build` CLI imports without the table or the heavy build barrel.
  - **`runs-arm`** — The build arm's presence on the merged run surface: its rows' link into the existing build run-detail pane, the six-way build status dot as the list row's leading indicator, and the status / targets…
  - **`serve-composition`** [exempt] — Serve capability for a composition: the live-serve toggle panel, the enable→build hook (a `build --composition <id>` of THIS checkout), the served-liveness read (the server-resolved namespace plus…
  - **`server-build-id`** — Served-bundle pin leaf: reads the .build-commit (the tree the bundle was built from) and .build-graph (content identity of the served web graph) trailers out of the served dist, fresh on every call…

<!-- AUTOGENERATED:END -->
