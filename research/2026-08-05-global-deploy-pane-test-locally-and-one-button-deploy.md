# Test locally, then deploy in one button

Status: **plan**
Touches: `plugins/apps/plugins/deploy`, `plugins/release`, `plugins/build`,
`plugins/apps/plugins/studio/plugins/compositions/plugins/auto-serve` (moved).
Supersedes the UI half of
[`2026-08-03-global-deploy-release-candidate-pipeline.md`](./2026-08-03-global-deploy-release-candidate-pipeline.md)
(P2's four-step surface, and P3's rehearsal step).

## Context

The deployment pane at `/deploy/server/:serverId/dep/:deploymentId` today shows a
four-step **Converge → Build → Rehearse → Ship** pipeline. Each step is a separate
button the user must press in order, one of them is a permanently inert
placeholder, and the last one is labelled *Ship without rehearsing* behind a
confirm dialog. Putting a new version of an app on a server therefore costs three
deliberate presses plus a dialog, and the pane never tells you where the app can
actually be looked at — neither locally nor in production.

The operator's ask is a different shape:

- **a section for testing the app locally**, with a link to the localhost URL,
  plus a shortcut on the deployments list row;
- **a section for the remote server with ONE button** that updates/deploys it;
- **the release history of the app**;
- **a link to inspect the deployed app** in both sections.

And one direct question: the server page's *Deploy output* card duplicates the
deployment pane's *Output* section — should it go? **Yes.** See the last section.

### Why the four steps existed, and why collapsing them is safe now

The pipeline was a faithful rendering of a real constraint chain: `ship` refuses
unless the host is converged, and refuses unless a *packed, platform-matched*
bundle exists. It exposed the chain because at the time nothing sequenced it.

Two facts make the chain automatable rather than instructional:

1. **Converge is genuinely a no-op the second time.** Every file write goes
   through `put` (content-compare before replace) and the unit restart is gated
   on "is the running process older than its configuration"
   ([`2026-07-31-deploy-converge-idempotence.md`](./2026-07-31-deploy-converge-idempotence.md),
   `plugins/framework/plugins/cli/bin/commands/internal/converge-script.ts`).
   Running it before every ship costs a warm host nothing and repairs drift.
2. **The bundle question already has one authority.** `resolveBundle` +
   `compareToHead` (`@plugins/release/plugins/bundles/server`, DB-free) answer
   *"is there a shippable bundle for this (composition, platform), and was it
   built from clean HEAD"*. So "do I need to build?" is a computed answer, not a
   question to ask the user.

The steps do not disappear — they become the **phases of one run**, reported as
they happen instead of typed in by hand.

### Intended outcome

```
┌ Test locally ───────────────────────────┐   ┌ Deploy to server ───────────────────────┐
│ ● Serving        [Stop]  [Reset]        │   │            [ Deploy ]                   │
│ 🔗 http://website.localhost:9000        │   │ ● Building linux-x64 candidate…         │
│                                         │   │   converge ✔ · build ⟳ · ship           │
│ The dev build on the shared gateway —   │   │                                         │
│ checks the composition and its closure, │   │ 🔗 https://equin.ai                     │
│ not the packed artifact.                │   │ live: a1b2c3d, shipped 2h ago           │
└─────────────────────────────────────────┘   └─────────────────────────────────────────┘
```

## Decisions taken (and the ones deliberately not asked)

| question | decision | why |
| --- | --- | --- |
| what "locally" runs | the **served namespace** `http://<composition>.localhost:9000` | the recorded operator call: one gateway, one namespace per composition. The `/tmp`-data-root packed-artifact preview was explicitly rejected in the P3 design and stays available in Studio. |
| "history of releases" | a durable **deploy ledger** — what went to this server, when, from which commit — with each row linking to the release run that built it | in a deployment pane, *the app's releases* are the ones that reached the box. It also retires the two apologies the current UI has to print ("runs are only remembered since the last backend restart"). |
| does the button always rebuild | **no** — it builds unless a bundle already resolves `ok` **and** its staleness is `current` | a retry after a failed ship, or deploying the same commit to a second server, costs no recompile. A dirty worktree is never `current`, so it always rebuilds there. |
| where the sequencing lives | the **deploy server plugin**, over an awaitable release engine | the build must be recorded in `release_runs` (hand-run CLI releases deliberately are not), which only the engine can do. |

## The model

One new verb, `update`, alongside `converge` and `ship`. It is **not** a CLI
subcommand: it is a sequence of the two existing CLI verbs with an engine release
between them, so no refusal, host mutation or health gate is re-implemented.

```
update := converge  →  [build candidate, unless the bundle is already current]  →  ship --release <runId>
```

`DeployRun` gains `phase`, so the UI reports which of the three is running
without parsing a log.

## Phase A — one button

### A1. The release engine becomes awaitable

`plugins/release/server/internal/run-release.ts` already has `doRunRelease`, a
plain `async` function that awaits both pipes and the child's exit. Promote it:

```ts
// plugins/release/server  (new export)
export type ReleaseOutcome =
  | { ok: true; runId: string; artifactPath: string }
  | { ok: false; reason: "already-running" | "unimplemented-target" | "failed";
      runId: string | null; message: string };

export async function runRelease(opts: TriggerReleaseOptions): Promise<ReleaseOutcome>;
```

A discriminated result, not a thrown error: `already-running` is a legitimate
outcome a caller branches on, not a fault. `triggerRelease` becomes
`void runRelease(...)` with its existing log/`inflight` wrapper, so there is
exactly one implementation and today's Studio behaviour is byte-identical.

`doRunRelease`'s current early `return`s (`isUniqueViolation`, `isAnyReleaseAlive`,
unimplemented target) become the corresponding `ok: false` arms.

### A2. The `update` orchestrator

`plugins/apps/plugins/deploy/plugins/deployments/`:

- `core/runs.ts` — `DeployVerbSchema` gains `"update"`; `DeployRunSchema` gains
  `phase: z.enum(["converge","build","ship"]).nullable()` (null for the two
  single-verb runs) and keeps `release`.
- `core/endpoints.ts` — `RunDeploymentBodySchema` gains `{ verb: "update" }`.
  Converge and ship stay, unchanged: the pane no longer offers them but the row
  actions and any scripted caller still can.
- `server/internal/run-deploy.ts` — today `startDeployRun` builds one argv and
  pumps it. Split it so the pump is reusable, then add the sequence:

  ```ts
  async function runUpdate(deployment, platform): Promise<void> {
    setPhase(deployment.id, "converge");
    if (await spawnVerb(deployment, ["converge"]) !== 0) return fail(...);

    setPhase(deployment.id, "build");
    const bundle = resolveBundle({ composition, platform });          // bundles/server, DB-free
    const current = bundle.ok && compareToHead(bundle.manifest).kind === "current";
    if (!current) {
      const outcome = await runRelease({ composition, target: "web",
                                         intent: { kind: "candidate", platform } });
      if (!outcome.ok) return fail(outcome.message);
    }

    setPhase(deployment.id, "ship");
    const pinned = resolveBundle({ composition, platform });          // re-resolve: the build just moved the pointer
    if (!pinned.ok) return fail(bundleRefusalMessage(pinned.refusal));
    await spawnVerb(deployment, ["ship", "--release", pinned.runId]);
  }
  ```

  The exclusivity guard is unchanged and now holds the server for the whole
  sequence — correct, since converge and ship both mutate host-wide state.
  `setPhase` writes the in-memory run and notifies `deploy.runs`, the same path
  `startRun`/`finishRun` already use (`server/internal/run-state.ts`).

  New import edge `apps/deploy → release` (server). Directionally correct — deploy
  consumes release artifacts — and acyclic: `release` imports nothing under
  `apps/`.

- The platform comes from the health probe exactly as today (`useBlockedReason`
  already refuses when there is none); the orchestrator reads it server-side from
  `deploy_servers_ext_health` rather than trusting the client.

### A3. The section

Rename `plugins/apps/plugins/deploy/plugins/release-pipeline/` →
`.../remote-deploy/` (the old name describes a surface that no longer exists).
It keeps its three contributions but the pipeline component is replaced:

- **`DeploymentDetail.Section` "Deploy to server"** — `RemoteDeploySection`:
  - one primary **Deploy** button (`useEndpointMutation(runDeployment)` with
    `{ verb: "update" }`), disabled with `useBlockedReason`'s exact sentence;
  - while running: a compact three-phase strip driven by `DeployRun.phase`
    (`converge ✔ · build ⟳ · ship`) — `Steps`/`Step` from `primitives/setup-steps`
    reused as a **report**, not a set of controls;
  - the existing `Provenance` block, unchanged, minus the never-rehearsed
    sentences: what would ship, its platform / sha / staleness chips, and
    `bundleRefusalMessage()` verbatim when nothing can;
  - **the inspect link**: `publicUrls(deployment.hostnames)` as `LinkChip`s
    (`window.open(url,"_blank","noopener")` — the `serve-target-panel.tsx`
    precedent), plus the loopback-only sentence when `hostnames` is empty.
    New pure helper in `deployments/core/derive.ts`, the declared owner of remote
    host facts, mirroring the CLI's own `https://${hostname}`
    (`cli/bin/commands/deploy.ts:906-912`);
  - the ship confirm dialog **goes away**. It existed to make "you never
    rehearsed this" deliberate; the Test-locally section is now the rehearsal, and
    a confirm on the app's one primary action is friction, not safety. Ship's
    remote health gate + automatic revert are the real protection and are
    untouched.
- **`DeploymentDetail.Section` "Output"** — unchanged switcher over the `deploy`
  and `release` channels, except its active tab now **follows `DeployRun.phase`**
  (build → `release`, otherwise `deploy`) until the user picks a tab by hand.
- **`Deployments.Fields` "release"** — kept; the row chip is still what states
  what a deploy would pick.

Delete: `ship-confirm-dialog.tsx`, the four-step `pipeline-section.tsx`.
`use-release-info.ts` and `core/release-state.ts` survive as-is.

## Phase B — Test locally

### B1. Move the serve capability out of Studio

`auto-serve` (`ServeTargetPanel`, `useServeComposition`, the reset endpoint) is
not a Studio concern — it depends only on `plugin-meta/composition`,
`build/core`, `infra/*` and primitives, and its own CLAUDE.md records that it is
deliberately a leaf others pull from. Deploy consuming it where it sits would
create the repo's **first `apps/X → apps/Y` edge**; there are none today.

Move it to **`plugins/build/plugins/serve-composition/`** — `build` already owns
`POST /api/build/serve` and the `compose-serve` stage, and there is no edge in
either direction between `build` and `plugin-meta` today, so the move introduces
no cycle. A mechanical move: same files, same exports; update the two Studio
importers (`compositions/web/components/*` and
`compositions/plugins/release/web/components/release-section.tsx`), then
`./equin build` regenerates the registries and docs.

### B2. Honest liveness

`autoBuild` is a declared *intent*; the truth is the `composition.json` marker
`compose-serve` writes, readable today only from server code
(`hasCompositionMarker`/`readCompositionMarker`,
`plugins/infra/plugins/worktree/server`) and used only inside the reset guard.
Add to `serve-composition`:

```
GET /api/build/serve/status?composition=<name>  →  { served: false } | { served: true; commit; builtAt }
```

so the section never offers a link to a namespace that would 502, and can say
*"serving a1b2c3d"* next to it. `ServeTargetPanel` gains the served state as a
prop rather than reading `autoBuild` as ground truth.

### B3. The section and the row shortcut

New `plugins/apps/plugins/deploy/plugins/local-serve/`:

- **`DeploymentDetail.Section` "Test locally"** — `ServeTargetPanel` for the
  manifest item found by **name** (`useManifestItems().find(i => i.name ===
  deployment.compositionId)` — `id` and `name` diverge for UI-created
  compositions, and deploy is name-keyed throughout), plus the caption stating
  what this does and does not prove (dev build on the shared gateway: composition
  membership and closure completeness, **not** packaging, config vendoring or
  first-boot migrations), plus the main-only refusal sentence rendered up front
  when the app is open in a worktree namespace — *"Serve builds run on the main
  instance only — open equin.localhost:9000."*
- **`DeploymentItemActions` "serve"** — a `RowActionButton` on the deployments
  list: opens `http://<composition>.localhost:9000` when served, otherwise
  starts serving it (`useServeComposition().serve`) and toasts that the build is
  running. This is the shortcut asked for.

## Phase C — the history

`deploy.runs` is in-memory and forgotten on restart, so nothing can answer *"what
is live on this box, and what happened before"* after a reboot. One table, owned
beside the runs that write it (`deployments/server/internal/tables.ts`):

```
deploy_runs(id, deployment_id → cascade, server_id, composition_id,
            verb, release_run_id, commit_sha, status, phase_failed,
            started_at, finished_at, exit_code, message)
```

`finishRun` writes the terminal row; `startRun` writes the opening one. The
in-memory `deploy.runs` resource stays exactly as it is — it is the *live* view,
and the table is the record. Add a keyset query endpoint
(`POST /api/deploy/deployments/:id/runs/query`) built from `primitives/keyset` +
`data-view/server-query`, the shape `queryReleaseHistory` already uses.

New `plugins/apps/plugins/deploy/plugins/deploy-history/`:
**`DeploymentDetail.Section` "History"** — a server-delegated `DataView`
(list + table) over that endpoint: outcome badge, verb, short sha, release run
id, duration, relative time, and the failure message verbatim on a failed row.
Rows link to the release run detail via the release run id. Copy
`release-history-section.tsx`'s shape; it is the working precedent for a
server-delegated, keyset-paginated, tick-refreshed history DataView.

Retention: `defineRetention` on `started_at`, 90 days.

## The duplicate Deploy output card — removed

`deployments-section.tsx:89-91` wraps `DeployLogPanel` in a `SectionCard` on the
**server** page; the deployment pane's Output section shows the same `deploy`
channel plus the `release` one. Two live subscriptions to one channel, one of
them under a heading in a pane that no longer hosts the actions.

Delete the card and `deploy-log-panel.tsx`. Nothing is lost: the channel replays
its ring buffer on subscribe, so the pane shows the last run's tail on open, and
`RunFailureNotice` still surfaces a failed run on the server page itself with the
CLI's own words. The row's `onRowActivate` already opens the pane, which is where
output now lives.

## Files

**Modify** — `plugins/release/server/internal/run-release.ts` + `server/index.ts`
(awaitable `runRelease`); `plugins/apps/plugins/deploy/plugins/deployments/`
`core/{runs,endpoints,derive}.ts`, `server/internal/{run-deploy,run-state,tables}.ts`,
`web/components/deployments-section.tsx`; the two Studio importers of `auto-serve`.

**Move** — `apps/studio/compositions/auto-serve` → `build/plugins/serve-composition`.

**Rename + rewrite** — `apps/deploy/release-pipeline` → `apps/deploy/remote-deploy`
(`pipeline-section.tsx` → `remote-deploy-section.tsx`; delete
`ship-confirm-dialog.tsx`).

**New** — `apps/deploy/plugins/local-serve/**`,
`apps/deploy/plugins/deploy-history/**`, one migration for `deploy_runs`.

## Verification

1. `./equin build`, then open
   `http://<worktree>.localhost:9000/deploy/server/<id>/dep/<id>`.
2. **Sections render and gate correctly** — drive it rather than snapshot it:
   ```bash
   bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --url http://<worktree>.localhost:9000/deploy/server/<sid>/dep/<did> \
     --click "Test locally" --out /tmp/deploy-local
   ```
   In a worktree the Test-locally section must render the main-only sentence and
   no live link; the Deploy button must carry `useBlockedReason`'s sentence when
   the server is unverified.
3. **The one-button sequence, against the real equin.ai server** (the only way to
   exercise converge → build → ship): press **Deploy** on a deployment whose
   bundle is already `current` and confirm the log shows converge, *skips* the
   build with a stated reason, and ships; then dirty the worktree, press again,
   and confirm it rebuilds. Watch phases advance in the strip and the Output tab
   follow into the `release` channel during the build.
4. **Ledger** — after each run:
   ```
   query_db: select verb, status, commit_sha, release_run_id, started_at,
             finished_at, message from deploy_runs order by started_at desc limit 10;
   ```
   Then restart the backend (`./equin build`) and confirm the History
   section still shows them while `deploy.runs` is empty — the exact gap this
   phase closes.
5. **Serve liveness** — toggle serve off in Studio and confirm the deploy pane's
   link disappears rather than pointing at a dead namespace.
6. `./equin check` (boundaries: the new `apps/deploy → release` edge is
   allowed and acyclic; no `apps/X → apps/Y` edge was introduced; registries and
   plugin docs regenerated by the build).
