# deployments

The **deployment record**: `(composition × server) → { hostnames, loopbackPort }`.
_Where_ a composition is served and under what URL. Design:
[`research/2026-07-29-global-composition-production-deployment.md`](../../../../../../research/2026-07-29-global-composition-production-deployment.md)
(D2b).

## Why this is not repo state

Every field of a deployment is an _operational placement_ fact, not a property of
the software: the same composition can be served at many URLs on many surfaces,
and the loopback port is a property of the box it lands on. The composition
itself **is** the software and stays in the `compositions` config. So this plugin
adds nothing to git, and the tradeoff is stated plainly: which composition is
served at which URL is DB state, not reviewable in a diff, and covered by the
`backup` plugin rather than by version control. What stays reproducible is what
the original complaint was about — the _host_ is derived from code and the
_artifact_ is built from a commit.

## Nothing about the install is stored

`runUser`, `installDir`, the systemd unit, the Caddy site path and the whole dir
layout are **derived from the composition name** in [`core/derive.ts`](./core/derive.ts),
which is the only place they may be spelled. `runUser` is the reason: its one
real requirement is _not root_ (embedded Postgres refuses `initdb` as uid 0), and
a configurable field with a default is a field someone can set back to `root`.
Deriving `svc-<composition>` makes "never root" **inexpressible** rather than
merely discouraged — the same move as the uid-0 guard, not a second place to get
it right.

The **platform** is likewise not here. It is read off the server's health probe
(`deploy_servers_ext_health.platform`, D2a) — _discovered_ on every reachability
check, never typed by a human, so moving from an x86 box to an ARM box is a fact
about hardware rather than a commit.

## The two unique constraints are the invariants

Both live in [`server/internal/tables.ts`](./server/internal/tables.ts), so
neither needs a `./singularity check` and neither can be lost to a concurrent
write:

- `(compositionId, serverId)` — **one install of a composition per server.** This
  is what buys the single-name property: with no second deployment to
  disambiguate, the composition name alone names the install dir, the systemd
  instance, the runtime namespace and the database. Staging and prod of one
  composition therefore live on different servers. A `slot` discriminator is the
  documented way to lift this if a real need appears.
- `(serverId, loopbackPort)` — the port is the only resource two installs on one
  box contend for.

`internal/constraint-violation.ts` maps each violation back to a 409 naming the
invariant, so "the DB rejected it" is never what a caller sees. Anything it does
not recognise is rethrown untouched — an unmapped DB error stays a loud 500.

## `compositionId` is validated at write time, not by a repo check

The row is runtime data, so a stale composition name must fail loudly **when
someone saves it**, not at the next build. `internal/assert-known-composition.ts`
reads the `compositions` config through its own descriptor (never `config_v2`
paths) and 400s a name that is not live, listing what is known. It matches on the
composition **name** — the identity every derived install name has to agree with,
since `release --composition <name>` takes it, `RELEASE.json.composition` carries
it, and the launcher makes it the runtime namespace.

`category` is deliberately not consulted: it is documented as organisation
metadata the engine never reads, so refusing to deploy a `subsystem` here would
give it engine semantics it disclaims. The honest refusal for a composition that
cannot produce a bundle comes from `ship`, which will not find one.

## The contract lives in `core/`, not `shared/`

The `servers` sibling puts its schemas / endpoints / live declaration in
`shared/`, which is plugin-private. This plugin's contract has a consumer outside
the plugin — the `singularity deploy converge` / `ship` CLI — so it lives in
`core/` instead, the same call `release/core/{endpoints,resources}.ts` makes for
the same reason. Nothing here is plugin-private, so there is no `shared/` at all.

`compositionId` / `serverId` are **create-only** (see
`UpdateDeploymentBodySchema`): editing that pair in place would leave the old host
converged and running an install no row describes any more.

## Live reads

- **`deployments`** (`core/resources.ts`) — a `liveCollection` over
  `deploy_deployments`, served by `serveCollection` (the projection is exactly
  `DeploymentSchema`'s keys; the change feed drives it). One deployment — the
  pane's resolve and title, the overview, and the sibling plugins' sections — is
  `useLiveRow(deployments, deploymentId)`, whose `found: false` is "this
  deployment no longer exists". A server's list is `useLive(deployments, {
  where: { serverId } })`; `serverId` is the one filterable column. The
  timestamps are `z.coerce.date()`, so the collection projects the columns as
  they are and the endpoints parse rows through the same schema
  (`toDeployment`). A `Deployments.Fields` contribution gets no rows of its own
  (data-view field extensions never do); `useDeploymentsListServerId()`
  (`web/internal/list-server-id-context.tsx`, published by `DeploymentsBody`
  around its `<DataView>`) hands it the same `serverId` so it can run the
  identical `{ where: { serverId } }` query rather than guessing at the
  collection's default window.
- **`deployRuns`** (`core/runs.ts`) — a `liveValue`, the run map below, read
  whole with `useLive(deployRuns)`.

## The UI launches the CLI; it does not reimplement it

`POST /api/deploy/deployments/:id/run` spawns exactly
`./singularity deploy converge|ship <composition> --server <serverId>` and streams
its output into the durable **`deploy`** log channel — the split `release`
(CLI) / Studio (UI) already uses. (`update` is a _sequence_ of those two spawns —
see below — not a third command.) The endpoint owns two verdicts and no others:

- **404** — no such deployment.
- **409** — a run is already in flight **on this server**. Scoped to the server,
  not the deployment: converge writes `/etc/caddy/Caddyfile` and runs `apt-get`,
  so two of them on one box race even for different compositions. **The claiming
  INSERT is the lock** — a partial unique index on
  `(launched_from, server_id) WHERE finished_at IS NULL` — so there is no
  check-then-act pair to keep in one turn, and the lock survives a restart. It
  used to be an in-memory `Map` read, which meant the promise evaporated at every
  restart and held only as long as nobody put an `await` in the wrong place.

Every other refusal is the CLI's, and reaches the user _after_ a 200: the command
exits non-zero, its message lands on the log channel and on the run's `message`,
and the UI repeats it verbatim (`RunFailureNotice`). That is deliberate — the
refusals (never-verified server, non-Linux host, owner-data closure behind a
public hostname, platform mismatch, missing bundle, un-converged host) are the
CLI's to own, and restating any of them here would be a second place to keep
right. The one exception is a _pre_-check the UI can make about its own state: the
row actions disable, with the reason in the tooltip, when the server has no
successful probe — the platform a deploy needs is discovered by that probe, so the
button would certainly be refused.

### `update` — the one verb that is not a CLI subcommand

`{ verb: "update" }` is the app's one primary action, and it is a **sequence of
the two real verbs with an engine release between them**:

```
update := converge → [build a candidate, unless the bundle is already current] → ship --release <runId>
```

It re-implements no refusal, no host mutation and no health gate: both legs are
the same `./singularity deploy` commands the row actions launch, and the
build/no-build decision is `resolveBundle` + `compareToHead` — the same authority
`ship` itself consults, asked one step earlier so nobody has to ask the user. So
"the CLI is the engine" still holds; what lives here is the _ordering_.

Three things are load-bearing about how it is built:

- **The body carries no fields.** The platform is read server-side off
  `deploy_servers_ext_health` and the release run id comes from `resolveBundle`
  after the build, so there is no way to ask for a deploy of the wrong bundle to
  the wrong host. That platform read happens _before_ the converge: an update
  that cannot resolve a bundle is going to fail anyway, and failing first means
  the user reads the real reason instead of a converge log to scroll past.
- **The bundle is re-resolved after the build**, never reused from before it — a
  build that just ran moved the `latest-<platform>` pointer, and the whole point
  of pinning by run id is that what was resolved is what goes out.
- **The exclusivity guard holds the server for the whole sequence.** That is
  correct rather than coarse: converge and ship both mutate host-wide state.

`DeployRun.phase` reports which leg is live, as a field rather than something a
UI parses out of the log. It stays pointing at the leg a failed run died on.

**The sequence is a supervised job with a `steps` body** (`deploy.run`,
`internal/run-deploy.ts`):

```ts
defineSupervisedJob({
  name: "deploy.run", input: { runId }, channel: deployLog, hold: "seconds",
  ledger: deployRunLedger,            // internal/run-state.ts
  steps: (input, { step, ctx }) => …, // converge step → decide build → awaitRelease → pin → ship step
});
```

- **Each leg is a `step`**: spawned detached inside a memoized step, then waited
  on with `supervised-job`'s observe-then-wait loop, holding no worker slot. A
  single verb is one step; `update` is converge step → build decision →
  `awaitRelease(ctx, …)` → pin → ship step. The step names ARE the leg names, so
  a step's child id is `legRunId(runId, leg)`.
- **The ledger** (`deployRunLedger`) is `deploy_runs`: `claim` ADOPTS the row the
  endpoint already claimed (`null` once it is closed; a missing row throws),
  `listUnfinished` / `setPid` / `closeRow` (`closeDeployRow`) / `onReattach`
  (`reattachRun`) as below, and `beginStep` = `beginLeg`, which names the leg on
  the row before the spawn and refuses once the run is closed — the body then
  gets `run-closed` and stops. An `update`'s pinned bundle is written by its own
  memoized step (`pinShipBundle`) just before the ship step.
- **Every gap is a `ctx.step` or `ctx.waitFor`**, so the handler returns through
  the jobs plugin's suspend sentinel and comes back as a fresh dispatch in
  whichever backend is alive by then. The middle phase enqueues a release
  (`enqueueRelease`) and waits with `awaitRelease` — the build must be recorded in
  `release_runs`, which only that engine can do.
- **A thrown error is stamped** with `failRun` and rethrown as a
  `NonRetryableError` (original as `cause`): once the run carries its verdict a
  retry would only replay memoized steps against a closed run. Suspend signals
  pass through untouched (`isSuspendSignal`).
- **A leg whose process never started** (`not-started`) is logged as
  `[failed] could not run …` and stamped by `failRun` as "could not run `deploy
  <leg>`: …"; the factory's last-resort hard-kill close runs after, and is then
  a no-op.
- **The durable names are the pre-`steps` sequence's** (`platform`,
  `spawn:<leg>`, `<leg>:<i>`, `ended:<leg>`, `begin-ship`, `bundle-decision`,
  `enqueue-release`, `release:<i>`, `pin-bundle`; only `claim` and `pin-ship` are
  new and replay harmlessly), so a deploy suspended across that change resumes
  rather than spawning a leg twice.
- `hold` is `seconds`: what bounds a dispatch is one `git` read
  (`compareToHead`) plus a few indexed queries.

### Converge's idempotence contract

A converge on an already-correct host must change nothing — re-running it is how
you inspect or repair one. Two rules in the generated script
(`cli/plugins/deploy/cli/internal/converge-script.ts`) carry that; a new step has to
honour both:

- **Every generated file lands through `put`**, which replaces the target only
  when the bytes differ — so an unchanged file keeps its mtime, and `[=]` is a
  comparison rather than a string the step assumed.
- **The restart is gated on the running process predating `env` / the unit**, not
  on what this run did. That also repairs an install whose last converge wrote a
  new `env` and died before restarting — which a "did I just change it" flag
  never would.

The child is spawned with `cwd` at this backend's own checkout, which is what
makes the CLI act on the same namespace as the app you clicked in: a CLI process
mints its namespace from the checkout it stands in (`checkoutNamespace(root)`),
and reads the deployment record over HTTP from `<worktree>.localhost:9000` and
the server row from that worktree's DB fork with it. Nothing rides in the
environment.

### A run is recorded twice, and the two are not redundant

- **`deploy.runs`** — the **live view**: an in-memory `Map` served as the
  `deployRuns` value's external arm (`deployRunsServed.notify()` on every
  write; the `release.previews` shape), bounded at one entry per deployment
  row, carrying `phase` so a running `update` reports which leg it is on. It is
  rebuilt at boot from the ledger and never persisted, so it cannot go stale.
  Two things rebuild it, and they cover different runs: the ledger's
  `onReattach`, for a run with a live LEG, and this plugin's own
  `onReady` (`reconcileDeployLiveView`), for every other open run — which is the
  case this migration created, an `update` sitting in its release build with no
  leg of its own. The phase is derived rather than remembered: a named leg with
  no transcript has not spawned, and for an `update` the only leg that is
  named-but-unspawned is `ship`, which means the build is what is running.
- **`deploy_runs`** — the **record**: one row per launched run, so _what is live
  on this box, and what happened before_ survives a restart. Read back as the
  `deployRunHistory` live collection (`deploy.run-history`, a `scroll: true`
  window whose `columnScope` is the History surface; `deploy-history`'s section
  scopes it per deployment and renders it), swept at 90 days. It is also the **lock** (above) and the
  **re-attach index** (below).

Both are written by `internal/run-state.ts` and only there, and they share the
run's `id` so the two name one run. Two rules in that file look like fussiness
and are correctness:

- **`claimRun` INSERTs before anything is spawned**, and it runs in the
  ENDPOINT, not in the job. The row is the exclusivity lock and the only handle a
  restarted backend has on the child, so it must exist first — and its refusal is
  a 409 that has to reach the button that was clicked, which a claim taken inside
  a queued handler could not deliver. The endpoint then enqueues `deploy.run` and
  returns; a failed enqueue closes the row rather than leaving the server held.
- **The live view is DERIVED from the row, never accumulated** (`publishLiveRun`
  is the only writer of the map). Everything the UI shows except the live `phase`
  is on the row, so a phase change does not require the process pushing it to be
  the one that started the run — which is not a nicety: a resumed `update` is
  routinely in a different backend from the one that claimed it.
- **A leg's outcome is stamped by the ledger's `closeRow`, in the reconciler** —
  not by the sequencer. That is what records a deploy's verdict whether or not
  its workflow is still alive, and it is why the ledger no longer needs an
  in-memory "is somebody sequencing this?" flag. `failRun` is the sequencer's
  own terminal write and covers only the failures that are not a leg's: an
  unreachable server, a platform nothing builds for, a release that refused, a
  bundle that will not resolve. Both are first-writer-wins
  (`WHERE finished_at IS NULL`).

`commit_sha` comes from the pinned bundle's own manifest at the instant it
resolves, and is null wherever it genuinely is not (a converge; a bare `ship`,
whose bundle the CLI picks inside its own process). HEAD is never substituted.

The `deploy` log channel's `logs/deploy.jsonl` is still the deeper archive — the
full transcript, where the ledger holds the one-line outcome.

### A run survives the backend that started it

The CLI is spawned as a **supervised run**
([`infra/jobs/supervised-job`](../../../../../infra/plugins/jobs/plugins/supervised-job/CLAUDE.md)),
which is the fix for the incident this plugin used to lose runs to: a plain child
shares the backend's process group, the gateway signals that whole group when it
hot-restarts a backend, and every `./singularity build` of this worktree does
exactly that. `drun-1787890652933-wr3v6d` lost its `ship` 0.9 s after spawning it
and was recorded as `Exited with code 143` — a sentence about a command that
never exited and never refused.

Four things follow, and none of them are optional:

- **The child is detached and its output goes to a transcript FILE**, tailed into
  the `deploy` channel by the primitive. A restart mid-run republishes it, and
  `verbFailureMessage` picks its sentence from that same file — the one copy, for
  a leg this process started and for one it merely adopted. stdout and stderr are
  merged (one fd), so the per-line stream classification is gone; the `deploy: `
  refusal scan is keyed on line _content_ and is unaffected, while the fallback
  that was "the last non-blank **stderr** line" is now "the last non-blank line".
- **`signalCode` is observed, never derived.** It comes from the shim's signal
  trap having fired. `128 + signo` cannot tell a kill from a program that chose
  `exit(143)`; that ambiguity is what produced the sentence above, so nothing here
  may re-derive killed-ness from `exitCode > 128`. `verb-outcome.ts` and its tests
  are where that is pinned down.
- **The unit the primitive supervises is a _leg_, not a run.** A `converge` or a
  `ship` is one leg; an `update` is two, with a release build between them that
  spawns nothing of its own here. Each leg needs its own transcript and exit
  marker, so its supervised id is `<runId>.converge` / `<runId>.ship`
  (`internal/legs.ts` owns the grammar — a dot, because a run id is already full
  of dashes), and the ledger row records which leg it is waiting on — durably,
  _before_ that leg is spawned, since it is the only thing a restarted backend
  has to find the child with.
- **`listUnfinished` reports a leg only once it has actually been SPAWNED.** The
  row names its next leg before that leg exists — an `update` points at `ship`
  for the whole length of its release build, tens of minutes with no child of its
  own and this backend's pid on the row. Offer that leg to the reconciler and the
  close rule reads it as a run whose process disappeared the moment this backend
  restarts, and closes a deploy that is going perfectly well. `legStarted` is the
  crisp signal: the primitive creates the transcript file before it spawns, and
  nothing else creates it.
- **`listUnfinished` is scoped to `launched_from`.** A worktree DB is a fork of
  main's and inherits its rows; unscoped, a worktree would adopt and close another
  machine's runs. The column is deliberately not called `namespace` — a deploy
  targets a remote host, so the worktree is the _launcher_, which is also why the
  runs-arm reads `namespace: null`.

**The sequence survives the restart too, and that is what the two in-memory maps
were standing in for.** `legs.ts` used to hold a `waiters` map (per leg) and a
`driving` set (per run), and `run-state.ts` asked both before closing a row:
a supervised leg's outcome arrives at the kind's `finish` rather than at the call
that started it, so while _this_ process was driving the run it was handed the
outcome directly, and the absence of a waiter meant the sequencer was gone. Both
are deleted. The sequence is a suspended workflow now, so "is somebody sequencing
this run" is not a question anyone has to answer from process memory.

**Which leg ends the RUN is a pure function of the row.** `closeDeployRow` closes
the ledger unless the leg both succeeded AND is not the verb's `finalLeg` — i.e.
an `update`'s converge, the one ending that means "more is coming". Every other
ending is the run's. That rule is readable by a reconciler in any backend, which
is exactly why no flag is needed.

**A leg's end is detected like every other supervised child**: its exit marker,
else a dead pid ⇒ hard kill (`-1`). A SIGKILLed leg therefore reaches the body as
a failed terminal — announced, and the sequence stops — while the reconciler
closes the row through `closeRow` with the same outcome. A run closed before a
leg could begin reaches it as `run-closed` from `beginStep`.

The old third arm — "an update's converge succeeded and the sequence was cut, so
record the run as an interrupted failure" — is gone, because the thing it
described cannot happen any more. That sentence existed because the middle leg
was an in-process `await runRelease(...)` with nothing durable to resume from.
An `update` now keeps going across the restart, which was the whole point.

### The row is a list row; the record lives in the pane

The list row carries only what a person scans — composition, last run, and the
contributed `Release` state. The record's editable fields (hostnames, loopback
port) and the derived install names (`runUser` / `installDir` / `unit` /
`caddySite`, each a pure function of the composition name and therefore never
editable) live in the `overview` section of the row's own pane
(`dep/:deploymentId`), which is also where the `remote-deploy` section acts. The
pane is where a deploy is read and launched; the row's rigid trailing region only
holds the single-verb shortcuts, so the row navigates instead of growing.

There is deliberately **no log panel on the server page**: the pane's Output
section subscribes to the same `deploy` channel, and a second live subscription
to one channel — under a heading, on a page that no longer hosts the actions —
was duplication rather than a view. The channel replays its ring buffer on
subscribe, so the pane shows the last run's tail on open.

`DeploymentDetail` (sections) and `Deployments.Fields` (extra columns) are the
two slots that make that pane and that row extensible without this plugin naming
any consumer — the `Servers.Fields` ← `health.StatusField` precedent.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Deployments section of a server's page: this server's deployments as a DataView (composition, last run, plus contributed columns), an add affordance whose composition picker reads the compositions config, a Deploy row action that launches the CLI's whole converge-build-ship run, and the per-deployment pane whose sections (overview, plus contributed ones) carry the record, its derived install and the remote-deploy surface. Owns the deploy_deployments table: where a composition is served and under what URL ((composition × server) → { hostnames, loopbackPort }), its live collection, and the CRUD endpoints. Also launches `./singularity deploy converge|ship` for a deployment — and orchestrates the `update` sequence (converge → build a candidate unless one is already current → ship that pinned run id) over the awaitable release engine — streaming the CLI's output into the durable `deploy` log channel, each run's phase and outcome into the in-memory `deploy.runs` live view, and every run into the durable `deploy_runs` ledger it serves back as a live history window — the record that survives the restart the live view does not. The install itself — run user, dir layout, systemd unit, Caddy site — is derived in core/, never stored.
- Web:
  - Slots:
    - `DeploymentDetail.Section`
    - `Deployments.Fields`
    - `DeploymentItemActions`
    - `deploymentDetailPane.Actions`
  - Slot contributors:
    - `DeploymentDetail.Section` ← `apps.deploy.analytics.dashboard`
    - `DeploymentDetail.Section` ← `apps.deploy.composition`
    - `DeploymentDetail.Section` ← `apps.deploy.deploy-history`
    - `DeploymentDetail.Section` ← `apps.deploy.deployments`
    - `DeploymentDetail.Section` ← `apps.deploy.local-serve`
    - `DeploymentDetail.Section` ← `apps.deploy.remote-deploy`
    - `Deployments.Fields` ← `apps.deploy.remote-deploy`
    - `DeploymentItemActions` ← `apps.deploy.deployments`
    - `DeploymentItemActions` ← `apps.deploy.local-serve`
    - `deploymentDetailPane.Actions` ← `primitives.pane`
  - Contributes:
    - `IdKinds.Kind` "dpl"
    - `IdKinds.Kind` "drun"
    - `ServerDetail.Section` "Deployments" → `DeploymentsSection`
    - `Pane.Register` "deploy-deployment-detail"
    - `DeploymentDetail.Section` "Overview" → `DeploymentOverview`
    - `DeploymentItemActions` "deploy" → `DeployAction`
    - `DeploymentItemActions` "delete" → `DeleteDeploymentAction`
  - Uses: 49 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×9
    - `primitives/data-view` ×7
    - `primitives/pane` ×5
    - `infra/endpoints` ×4
    - `network/live` ×3
    - `primitives/live-state` ×3
    - `apps/deploy/health` ×2
    - `apps/deploy/servers.ServerDetail`
    - `ids.IdKinds`
    - `plugin-meta/composition.useManifestItems`
    - `primitives/css/badge.Badge`
    - `primitives/css/bouncing-dots.BouncingDots`
    - `primitives/css/fill.Fill`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/detail-sections.defineDetailSections`
    - `primitives/editable-field.useEditableField`
    - `primitives/icon-button.IconButton`
    - `primitives/loading.Loading`
    - `primitives/overlay/imperative-dialog.openDialog`
    - `primitives/relative-time.RelativeTime`
    - `ui/icons.Icon`
  - Exports (values):
    - `DeploymentDetail`
    - `deploymentDetailPane`
    - `DeploymentItemActions`
    - `Deployments`
    - `useBlockedReason`
    - `useDeploymentsListServerId`
- Server:
  - Contributes:
    - `ids.kind` "dpl"
    - `ids.kind` "drun"
    - `resource.declare` "deploy.deployments"
    - `resource.declare` "deploy.deployments:groups"
    - `resource.declare` "deploy.deployments:rows"
    - `resource.declare` "deploy.run-history"
    - `resource.declare` "deploy.run-history:groups"
    - `resource.declare` "deploy.run-history:rows"
    - `resource.declare` "deploy.runs"
  - Uses: 24 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/jobs` ×3
    - `ids` ×2
    - `infra/endpoints` ×2
    - `infra/jobs/supervised-job` ×2
    - `infra/paths` ×2
    - `network/live` ×2
    - `release/bundles` ×2
    - `release` ×2
    - `apps/deploy/health.serverHealth`
    - `apps/deploy/servers._deployServers`
    - `config_v2.getConfig`
    - `database/derived-updated-at.deriveUpdatedAt`
    - `database.db`
    - `infra/retention.defineRetention`
    - `primitives/log-channels.defineLogSink`
  - DB schema: `plugins/apps/plugins/deploy/plugins/deployments/server/internal/tables.ts`
  - Exports (values):
    - `_deployDeployments`
    - `_deployRuns`
  - Register:
    - `defineJob('retention.deploy_runs')`
    - `defineSupervisedJob('deploy.run')`
  - Resources:
    - `deploy.deployments` (keyed, window)
    - `deploy.deployments:groups` (push)
    - `deploy.deployments:rows` (keyed, point)
    - `deploy.run-history` (keyed, window)
    - `deploy.run-history:groups` (push)
    - `deploy.run-history:rows` (keyed, point)
    - `deploy.runs` (push, notified)
  - Routes:
    - `GET /api/deploy/deployments`
    - `POST /api/deploy/deployments`
    - `GET /api/deploy/deployments/:id`
    - `PATCH /api/deploy/deployments/:id`
    - `DELETE /api/deploy/deployments/:id`
    - `POST /api/deploy/deployments/:id/run`
- Core:
  - Uses:
    - `apps/deploy/servers.serverDetailRoute`
    - `ids.defineIdKind`
    - `ids.IdOf`
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveCollection`
    - `network/live.liveValue`
    - `network/live/filter.liveInstant`
    - `network/live/filter.liveText`
    - `primitives/pane.defineRoute`
  - Exports (types):
    - `CreateDeploymentBody`
    - `Deployment`
    - `DeploymentId`
    - `DeployPhase`
    - `DeployRun`
    - `DeployRunId`
    - `DeployRunRecord`
    - `DeployVerb`
    - `InstallLayout`
    - `RunDeploymentBody`
    - `UpdateDeploymentBody`
  - Exports (values):
    - `CADDY_SITES_DIR`
    - `createDeployment`
    - `CreateDeploymentBodySchema`
    - `currentAppPath`
    - `DEFAULT_LOOPBACK_PORT`
    - `deleteDeployment`
    - `DEPLOY_LOG_CHANNEL`
    - `deploymentDetailRoute`
    - `deploymentIdKind`
    - `deployments`
    - `DeploymentSchema`
    - `DeployPhaseSchema`
    - `deployRunHistory`
    - `deployRunIdKind`
    - `DeployRunRecordSchema`
    - `deployRuns`
    - `DeployRunSchema`
    - `DeployVerbSchema`
    - `deriveInstall`
    - `getDeployment`
    - `INSTALL_ROOT`
    - `listDeployments`
    - `listenAddress`
    - `LOOPBACK_HOST`
    - `loopbackOnlySentence`
    - `publicUrls`
    - `releaseAppPath`
    - `releaseDir`
    - `REMOTE_SCRIPT_SHEBANG`
    - `runDeployment`
    - `RunDeploymentBodySchema`
    - `SYSTEMD_INSTANCE`
    - `UNIT_TEMPLATE_PATH`
    - `updateDeployment`
    - `UpdateDeploymentBodySchema`
- Cross-plugin:
  - Imported by:
    - `apps/deploy/analytics/dashboard`
    - `apps/deploy/composition`
    - `apps/deploy/deploy-history`
    - `apps/deploy/deployments/runs-arm`
    - `apps/deploy/local-serve`
    - `apps/deploy/remote-deploy`
- Exemptions:
  - Exempts itself from: `paths:no-hardcoded-paths` — `core/derive.ts` (sanctioned)
- Sub-plugins:
  - **`runs-arm`** — The deploy arm's presence on the merged run surface: the Deploy kind (whose rows open the deployment detail pane on the server the run went to), and its eight own columns (verb, failed phase, server…

<!-- AUTOGENERATED:END -->
