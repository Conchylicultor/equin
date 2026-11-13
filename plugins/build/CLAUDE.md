# build

Auto-build is a **convergence loop on "this checkout's HEAD is what is
deployed"**, not a queue of push events, and **main's runs outside main's
backend**. The gateway — the one process up whenever anything is — watches
`refs/heads/main` and, on every advance (debounced), on its own boot, when its
previous run exits with an edge pending, and when a backend asks, starts ONE
`./equin build --allow-main --converge` in main's checkout
(`gateway/main_deploy.go`). That run decides from durable state — git, the
served dist, the `build_runs` ledger, config on disk — and builds what is
wanted, looping until nothing is (`plugins/converge`, the loop in
`framework/cli/build`'s `cli/internal/converge.ts`). The gateway holds no
policy: the commit being deployed decides with its own code.

**Why it moved (2026-11-08).** Every edge of the old loop — the durable
`refAdvanced` trigger, `build.run.debounced`, the boot / terminal / config
reconciles — and its runner lived in main's backend, so "main can serve" was a
precondition of "main gets redeployed": the fix 2baf0e2a3b sat on main for
eleven minutes while main had no backend, until a person reloaded the gateway.
Those jobs and `reconcileDeployment` are deleted, not kept as a second runner.

**No retry per commit.** A HEAD whose automatic build failed is decided, not
re-run (`wantsBuild`'s termination); the next push is the next attempt. So
while successive commits each fail to boot, main stays down until the first one
that boots — healed by a push, never by a person. A convergence run that itself
fails (cannot decide, cannot start) is a `main-deploy-failed` report the
gateway files; nothing retries it before the next edge.

**What the backend still does for the loop** (`machine/`) is optional and only
what a backend alone sees: the `compositions` config changing, the
`build.composition-tick` cadence, and a button build ending each `POST /gateway/deploy/converge`
(`requestConvergence`, main only). An extra edge is free — the run re-derives the
whole decision and the gateway runs one at a time — and none is needed for
main's own recovery. And the bell: the convergence run's builds have no workflow
in any backend, so `onAutoBuildTerminal` rings for an `auto` row when its exit
marker lands (`onRunTerminal`) and, at boot, for each one that ended in the last
day — a build that ended while main had no backend is told once main is back,
at most once per run.

The decision is NOT here — it is the pure `wantsBuild` in
`plugins/deployment/core` and the pure `compositionWantsRebuild` in
`plugins/converge`, bound to durable state by `decideConvergence`. Read
`plugins/deployment/CLAUDE.md` and `plugins/converge/CLAUDE.md` before
touching any of it.

## Two halves: what every host serves, and what runs builds

`server/` is **portable**: the build-run id kind, the build
config (`ConfigV2.Register`), the Build task category and the `build.history`
collection — reads a host without the computer (the in-browser demo) serves on
its own database. Everything that RUNS a build from a backend is `machine/`: the Build and
Serve routes (both endpoints declared `needsMachine`, so a host without the
computer answers them "not available" and the Build button renders disabled),
the supervised build job, the composition tick and config-watch edges, the bell
for auto builds, and the run-terminal watcher (`onRunTerminal`, the machine
barrel's one export). The claim-time settle of a dead in-flight holder is
`run-ledger/machine`'s, for the same reason: it reads the disk.

`build.history` scopes to `runtimeNamespace()` at module eval, which a browser
host answers too: its worker entry declares its composition as its namespace
(`website/demos/workspace/bin/declare-namespace.ts`).

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
- **Main only.** `refs/heads/main` moves under every checkout on the host, so a
  per-checkout scope would have every live agent worktree rebuilding the same
  compositions off one push — the fan-out `events.refresh-tick` refuses for
  its own cadence. The gateway runs convergence for main alone, and
  `decideConvergence` reads the compositions only on main's checkout. The
  explicit Serve / Rebuild buttons still work everywhere.

Main's own build wins when both want one: one build per pass, main first, and
the convergence run loops — the composition build is the next pass, not lost.

The commit gate answers "has the tree moved", so editing a composition's own
manifest row (contributors, entry points, `extends`) is deliberately NOT an
automatic trigger — **Rebuild now** is, and it is available in every mode for
exactly that reason.

## A run has TARGETS, not a target

`build_runs.targets` is a `text[]` of composition ids: `{<main composition id>}` for a
plain build of this checkout's own app, or the ids of a
`./equin build --composition a b`. One invocation is one shared build — one
install, one codegen, one checks pass, one transcript, one profile, one verdict —
so it is ONE row with N chips, and the history DataView renders the column as a
`tags` field (match-any filtering comes free). `isMainCompositionBuild(targets)`
(`build/core`) is the one answer to "is this a plain build?", so no surface spells
a literal. The old scalar `target` column is gone: the CLI's ledger INSERT now
names its own columns instead of going through drizzle's `.values()` (which names
EVERY column in the table def), so a column added by this same build no longer
breaks the CLI's write — see `run-ledger/CLAUDE.md`.

`buildJob.enqueue({ trigger, compositions })` is what the Build and Serve buttons reach:
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

`./equin build` is a **supervised job**
(`@plugins/infra/plugins/jobs/plugins/supervised-job`) named
`build.run.supervised`, declared once in `machine/internal/run-build.ts`. There is no
`triggerBuild` any more and nothing calls a spawner directly: every backend request —
the Build button, the Serve button — is
`buildJob.enqueue({ trigger, compositions? })`. Main's auto-build is not one:
the convergence run claims its row and runs its build itself (above).

The wrapper composes `defineJob` + a `supervised-run` kind + `ctx.waitFor`, and
the handler is short at both ends and empty in the middle: claim the row, spawn
the detached child, SUSPEND. `ctx.waitFor` returns from the handler through the
jobs plugin's suspend sentinel, so a 20-minute build holds a worker slot for
milliseconds and the workflow comes back as a fresh dispatch when the child's
exit marker lands. Read `supervised-job/CLAUDE.md` before changing any of it.

What each arm of `machine/internal/run-build.ts` owns, and why the split is where it is:

- **`claim`** — `claimBuildRun`, and the claiming INSERT against
  `build_runs_inflight_uniq` IS the lock. A request that loses returns `null`,
  the handler stops, and nothing is queued: auto-build is a convergence loop, so
  the request is re-derived at the next edge.
- **`argv`** — `--allow-main` before `--composition` (commander's variadic is
  greedy up to the next flag), plus the two env overrides that are ADDED to the
  backend's own environment: `EQUIN_BUILD_ID`, and
  `EQUIN_BUILD_DETACHED`, which is what stops the CLI's orphan guard from
  killing a build whose invoking backend it is about to restart.
- **`closeRow`** — the bare `WHERE finished_at IS NULL` stamp of `finished_at` +
  `exit_code`, and NOTHING else. It runs in the supervised-run reconciler of
  every backend that sees the marker, including one that knows nothing about the
  workflow, and that is what stops a dead workflow from leaving the in-flight
  index held against every future build.
- **`onEnded`** — the terminal WORK, exactly once, in the owning workflow: the
  bell, `deploymentServed.notify()`, and on main an optional convergence edge
  (`requestConvergence("a build ended")`): a push landing while a button build
  held the in-flight slot made the gateway's run stop at its claim, so the run
  is asked for again once the slot is free. **The row is
  already closed by the time this runs** — the CLI stamps its own row ~100 s
  before its child exits, and failing that `closeRow` runs before the
  announcement that resumes the handler. So nothing here is gated on
  `finished_at IS NULL`; the row is read BACK and the bell describes what the
  ledger carries.

`runAttempts` stays at the default **1**. A failed build stays failed and
visible; whether to build again is the convergence run's call, made from the
state of the world, not a retry budget. And a non-zero exit code is DATA, not an
exception: the handler records it and returns normally, so a failed build files
no crash report and no dead-letter.

What that buys, and what moved:

- **Nothing waits for a build.** A caller enqueues and returns. Everything that
  used to sit after `await proc.exited` — the bell, the row's terminal stamp —
  is now the durable workflow's, resumed by whichever
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
- **A build's record is its run's transcript + exit marker, for every build.**
  `runs/build-<id>.log` holds every line the build printed (the verdict
  included) and `runs/build-<id>.exit-code` its status. A build the backend
  starts gets both from the shim; a hand-run `./equin build` re-runs itself
  under `runAttached` (supervised-job's `cli`), which writes the same two files
  with the terminal attached and echoes the transcript to it. The build pane
  (`build-logs`) cuts the transcript into the step blocks the build prints
  (`op-runtime/core`'s `parseStepBlocks`, beside the renderer) and the output
  between them; the ledger's claim-time settle reads the marker. The old step
  log (`build-logs-<id>.json` + `build-<id>.log`) is gone: it held only the
  blocks, so the pane missed every serial line — the backend restart, the health
  probe, the verdict — and showed a failed restart as three green steps.
  (`research/2026-11-04-build-unified-run-record.md`.)

### Why the convergence loop still terminates

The convergence run is `wait out the build lock → decide → claim → build →
close the row → decide again`. A finished build cannot ask for itself again
because its attempt is in the ledger before the next decision: the build closes
its own row on every verdict, and the run closes it (first writer wins) when the
build ended without one. `lastClosedRun` then names this build's commit and
`wantsBuild` answers no — for an ok build and a failed one alike.

The two other edges of the same argument:

- A pass that would repeat the build it just ran (same HEAD, same targets) means
  the ledger did not record the attempt; the run throws rather than loop, and
  the gateway files that as `main-deploy-failed`.
- With no ledger at all (no `build_runs` table yet — a machine's first build),
  nothing can record an attempt, so the run builds once and stops; the next edge
  decides against the ledger that build created.

A request that arrives mid-run is never dropped: the gateway remembers an edge
that lands while a run goes and starts one more run after it — one at a time.

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
  three list readers (the button, the popover and the build-activity hook)
  take the default window, `useLive(buildHistory)`, read its newest rows and
  never page past it. (`serve-composition`'s Serve panel no longer folds it:
  its status is its own notified `build.serve-status` value.) A window is never
  L2-persisted, so a cold boot loads its 50 rows fresh.
- **One run** — `build-info` and `build-fix` read
  `useLive(buildHistory, { id: runId })`, the `:rows` point read: a run older than
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

**A reload is advised only when a reload can help.** `useReloadAdvice` and
`useServerBehind` (`hooks/use-reload-advice.ts`) read the same two facts — the
server's `skew` refusals of this tab's live reads, and whether this tab runs
exactly the served bundle (`useStaleFrontend().current`). A tab that does not
(or is not known to) is out of date: Reload. A tab that does is current, so the
refusals mean the backend's own code is behind the bundle it serves — a deploy
that published the frontend and never got its backend up — and a reload would
fetch the same bundle into the same refusals. The tray then says **Server out
of date** (red ring, no Reload pill; the collapsed bar's activity ring says the
same), and it clears on its own once the backend catches up: live-state drops a
tuple's refusal the moment that tuple is answered. The deploy now rolls the
frontend back when its backend fails to come up (`cli/plugins/build`'s
`deploy-namespace.ts`), so this is the backstop, not the common case.

`ReloadButton` (`components/reload-button.tsx`) is the ONE Reload control: a
filled pill at the control height in the solid fills (`info-solid` when the tab
is only stale, `destructive-solid` when something already fails), named by its
full `reload-copy.ts` message. Its label is the solid foreground with 18% of
the fill mixed back in (a tinted light, not stark white); its glyph end keeps
the plain control padding and only the label end takes the pill's extra. The collapsed bar's `ActionBar.Glance` is
`ReloadGlance`: the same tray holding only `ReloadButton`, so Reload is the same
control whether the bar is open or closed. The chrome theme deepens the solid
fills to navy and oxblood — see `apps-core/chrome-theme`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Trigger `./equin build` from the toolbar. Build, portable half: the build-run id kind, the build config, the Build task category and the build.history collection over build_runs — what a host without the computer serves too. Running builds (the jobs, the routes, the auto-build reconcile) is build/machine.
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
  - Uses: 37 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `network/live/live-state` ×4
    - `primitives/css/ui-kit` ×4
    - `infra/endpoints` ×3
    - `primitives/log-channels` ×2
    - `primitives/pane` ×2
    - `apps-core/tabs.useAppLink`
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
    - `shell/notifications.useToast`
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
  - Uses:
    - `build/run-ledger._buildRuns`
    - `config_v2.ConfigV2`
    - `ids.IdKinds`
    - `network/live.serveCollection`
    - `tasks/task-category.TaskCategory`
  - Resources:
    - `build.history` (keyed, window)
    - `build.history:groups` (push)
    - `build.history:rows` (keyed, point)
- Machine:
  - Uses:
    - `build/deployment.deploymentServed`
    - `build/run-ledger.settleDeadInflightRun`
    - `infra/endpoints.implementMachine`
  - Exports (values): `onRunTerminal`
  - Register:
    - `defineJob('build.composition-tick')`
    - `defineSupervisedJob('build.run.supervised')`
    - `defineFileWatcher('build.run-terminal')`
  - Routes:
    - `POST /api/build`
    - `POST /api/build/serve`
- Core:
  - Uses:
    - `build/run-ledger.buildRunFields`
    - `build/run-ledger.buildRunsEntityRef`
    - `config_v2.defineConfig`
    - `fields.fieldsToZodObject`
    - `fields/bool/config.boolField`
    - `infra/endpoints.defineEndpoint`
    - `infra/namespace.MAIN_COMPOSITION_ID`
    - `network/live.liveCollection`
    - `primitives/pane.defineRoute`
  - Exports (types): `BuildRun`
  - Exports (values):
    - `BUILD_CATEGORY_ID`
    - `BUILD_LOG_CHANNEL`
    - `buildConfig`
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
    - `apps/desktop/fullscreen-budget`
    - `build/build-commits`
    - `build/build-fix`
    - `build/build-info`
    - `build/build-logs`
    - `build/build-profiling`
    - `build/converge`
    - `build/runs-arm`
    - `build/serve-composition`
    - `companions/menu-bar`
    - `debug/reports`
  - Endpoint callers: `restart-skip`
- Sub-plugins:
  - **`build-commits`** — Commits included since the previous build, shown in the build detail pane.
  - **`build-fix`** — Launch-agent button in the build detail pane for failed builds, and the same launch as a Build failed notification's Fix (the fix-build notification action).
  - **`build-info`** — Status, trigger, commit hash, and timing section in the build detail pane.
  - **`build-logs`** — Logs section in the build detail pane: the run's transcript as its steps and lines (build.run-logs, newest first, paged by viewport).
  - **`build-profiling`** — Per-run build profiling Gantt section in the build detail pane.
  - **`build-status`** — Single source of truth for build-run status display metadata — label, badge variant, and dot color per BuildStatus.
  - **`build-termination`** — Per-run termination record, desktop-only: the build.run-termination live value — what the host-global signal-origin sink recorded about the death of one build run (which signal, and who sent it)…
  - **`central-build-id`** — Central's code build, central's half: at register, starts the source digest of the entry central runs and, once it lands, names it as the central live-resource runtime's build…
  - **`converge`** — Main-deploy-failed report renderer: a one-line Debug → Reports summary for the main-deploy-failed kind (how main's convergence run ended, what started it). The main-deploy-failed report kind — filed…
  - **`deployment`** — The client half of the deployment description: `useDeployment()` composes THIS tab's own baked pin in beside the server's two deployable carriers, and `<DeploymentChain/>` renders the four arms…
  - **`restart-skip`** [exempt] — The restart-skip-cannot-judge report kind — filed by `./equin build` through the report outbox when the backend or central it asked to adopt a deploy could not measure its own code (the closure walk…
    - Plugins:
      - **`hooks`** — Restart-skip's contribution kinds, a leaf every contributor imports (so contributing never pulls in the judgement and its imports): RestartSkip.BootInput (files a backend reads once and holds — a…
  - **`run-ledger`** [exempt] — Build-runs ledger leaf: the build_runs entity, and (cli/) the hand-SQL build-run recorder the `./equin build` CLI imports without the table or the heavy build barrel.
  - **`runs-arm`** — The build arm's presence on the merged run surface: its rows' link into the existing build run-detail pane, and the status / targets / commit / exit-code columns only a build row has. The build arm…
  - **`serve-composition`** [exempt] — Serve capability for a composition: the live-serve toggle panel, the enable→build hook (a `build --composition <id>` of THIS checkout), the served-liveness read (the server-resolved namespace plus…
  - **`server-build-id`** [exempt] — Served-bundle and server pin leaf: the commit this backend process was materialized from (serverPin — HEAD sampled at module eval, sealed by build/deployment at onAllReady, unresolved on a mixed…
  - **`step-baseline`** — Build-step-regression report kind's Debug → Reports summary view: one line naming the step, its value against its baseline, and for file calls where the extra calls went. Filed by main's build…

<!-- AUTOGENERATED:END -->
