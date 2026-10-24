# Deployment convergence: carriers, honest pins, one reconciler

Date: 2026-08-19
Category: global (cli · build · web-artifacts · primitives)

## Context

On 2026-08-19 commit `34557b01f` was merged to main at 11:30:24, 13 seconds before
the running build (for `8d7f38a85`) finished at 11:30:37. No rebuild followed. The
frontend served from `equin.localhost:9000` is still `8d7f38a8`'s bundle
while the backend, having restarted out of the checkout at 11:30:32, runs
`34557b01f`'s code. The build even printed
`BUILD OK — deployed (superseded — main moved to 34557b01f mid-build, rebuild follows)`.
No rebuild followed, and nothing in the UI said so.

Three separate mechanisms were supposed to catch it and all three missed:

1. `triggerBuild`'s `finally` → `convergeMain(forCommit)` — the process holding
   `forCommit` is the one the build restarts. On a main auto-build this path
   never runs.
2. `watchInflightBuild`'s boot-adopted watch — must find the `build_runs` row
   still open to adopt it. The backend became ready at 11:30:36.761; the CLI
   closed the row at 11:30:36.866. It lost a 105 ms race.
3. The boot "is main ahead?" check — compares main against
   `webDistDir()/.build-commit`, which `app-artifacts.ts:958` stamps with a
   **fresh `git rev-parse HEAD` after the compile**, i.e. the post-swap head. It
   read `34557b01f`, so main looked already deployed. Count 0, no catch-up build,
   no banner.

The root cause is one shape, not three bugs: **convergence is carried by
processes and races instead of being derived from durable state**, and the one
durable value available (`.build-commit`) records a commit the bundle was not
built from. `run-build.ts:344` and `build.ts:1673` both already document that
`.build-commit` is wrong for exactly this case, and each works around it locally
rather than fixing the pin.

Intended outcome: one honest description of what is deployed, from which both the
Build button's display and the auto-build decision are derived — so a wrong badge
and a missed rebuild become the same bug.

### Decisions

- **Auto-build stays main-only.** `target` becomes per-namespace and the chain
  renders everywhere, but only main auto-builds on a ref advance. Worktrees keep
  building via explicit `./equin build`. No behaviour change beyond the bug.
- **"N commits behind main" leaves the Build button.** That relationship is
  already owned by `tasks/attempt-work` and surfaced by the conversation
  commits-graph. The button answers deployment freshness only.
- **Staged in three steps, landed in one session.** Each step is independently
  correct and separately reviewable; see Execution.

## The model

A **carrier** is a thing that executes repo code and can name the commit it was
materialized from. Everything else is derived.

```ts
// plugins/build/plugins/deployment/core/
type CarrierId = "server" | "web" | "tab";

type Carrier = {
  id: CarrierId;
  commit: Sha;            // the tree it was materialized from
  graph: Hash | null;     // content identity of the served web graph (web/tab only)
  since: Date;
};

type Deployment = {
  target: Sha;                       // this checkout's HEAD
  deployable: Carrier[];             // server + web — what a build can move
  // the `tab` carrier is composed in client-side; the server cannot know it
};
```

Two derived questions, both pure:

```ts
convergenceOf(d: Deployment): "converged" | "behind" | "diverged"
wantsBuild(d: Deployment, lastAttempt: { commit: Sha; ok: boolean } | null): boolean
```

`wantsBuild` is the whole auto-build policy:

```ts
if (d.deployable.every(c => c.commit === d.target)) return false;  // converged
if (lastAttempt?.commit === d.target) return false;               // already tried this target
return true;
```

The second clause is what terminates on a commit that cannot build. It is the
same argument `needsRebuild` makes today, stated as its own fact instead of
encoded in the choice of which commit to compare against — the encoding that
produced the `.build-commit` gap. No new storage: `build_runs.commitHash` +
`exitCode` already are `lastAttempt`.

**`wantsBuild` ranges over `deployable` only.** A stale tab produces a reload
affordance, never a build — otherwise a tab nobody reloads would loop the
reconciler forever.

### Failure is a type, not an absorbable value

Every pin is `Resolvable`. A carrier that cannot name its commit returns
`unresolved(reason)`, never a fake sha:

- release bundle → `unresolved("no checkout")` (the chain renders "Release build")
- checkout moved during the plugin-import wave → `unresolved("mixed boot")`,
  which `wantsBuild` treats as **not converged**, forcing a rebuild+restart —
  the correct answer for a server that is genuinely a mix of two trees.

## Step 1 — three honest pins

No behaviour change. The data becomes true.

**Web pin — sample at the right instant.** `plugins/framework/plugins/cli/bin/commands/build.ts:1102`
already computes `headAtStart` (used by `supersededBy()`), and it is in scope at
the `buildAndPublishWebDist` call site (`build.ts:1529`). Add `headAtStart` to
`BuildWebDistOptions` (`internal/app-artifacts.ts:717`) and use it at
`app-artifacts.ts:958-966` in place of the late `Bun.spawnSync(["git","rev-parse","HEAD"])`.
`compose-serve.ts:305` reuses `build.ts`'s `buildCommit`, so every composition's
pin is fixed by the same change. `hermetic-build.ts` needs its own pre-stage-1
sample (mirroring `release.ts:710`'s already-correct `readGitProvenance`).

**Web content identity — replace the nonce.** `compose.ts:156` injects
`__SINGULARITY_BUILD_ID__ = <nonce>` into `index.html`. It is the only
non-content-derived value there; everything else (import map values, `entryUrl`,
`cssHref`, the preload closure) is content-addressed already. This is why
`frontendHash` (md5 of `index.html`) churns on every build even when the graph is
byte-identical.

Add `computeGraphHash({ importMap, preloads, entryUrl, cssHref })` in
`compose.ts` (using the existing `sha256Hex` from `web-artifacts/core/hash.ts`),
inject `__SINGULARITY_GRAPH__` and `__SINGULARITY_COMMIT__` in place of the
build-id global, and write `.build-graph` beside `.build-commit`. `buildId` stays
what it honestly is — the run id (`build_runs.id`, log filenames, profiler
`opId`) — and leaves the browser.

This also fixes a bug found during exploration: every compose-serve child is
currently stamped with **main's** `buildId` (`compose-serve.ts:311`), so all
composition namespaces report the same artifact identity despite different
graphs. A content hash distinguishes them for free.

**Server pin.** New leaf `plugins/build/plugins/deployment/server` samples
`git rev-parse HEAD` at module eval (during the plugin import wave — the tree the
graph was imported from) and re-samples at `onAllReady`; a difference yields
`unresolved("mixed boot")`. Nothing records this today.

**Consumers to move onto the new values** (all identified, small):
`use-stale-frontend.ts:12` (buildId → graph), `use-action-bar-status.ts:37`
(md5 hash → graph; this deletes the second, weaker stale-tab detector),
`reports/server/internal/record-report.ts:169` `staleOrigin` and
`backfill-noise.ts:21` (both are artifact-identity comparisons wearing a run id).

To keep this step self-contained, `frontendHashResource` **stays** here and gains
a `graph` field; its `hash` (md5 of `index.html`) is dropped once both consumers
read `graph`. Step 2 folds the resource into `deploymentResource` and deletes it.

Files: `cli/bin/commands/build.ts`, `internal/app-artifacts.ts`,
`internal/hermetic-build.ts`, `web-artifacts/core/internal/compose.ts`,
`web-artifacts/core/internal/vite-builder.ts`.

## Step 2 — one reconciler, three edges

New sub-plugin `plugins/build/plugins/deployment/` (`core` + `server` + `web`),
kept a **leaf** so it never imports `build/server` — the reconciler lives in
`build/server` where `triggerBuild` already is, and imports downward. This is
what keeps the graph a DAG.

- `deployment/core` — the types above, `convergenceOf`, `wantsBuild`, the zod
  schemas and the resource descriptor. Pure; no imports beyond zod + live-state
  core.
- `deployment/server` — the server pin (module constant), reads the web pin from
  `${webDistDir()}/.build-commit` + `.build-graph`, resolves `target` from
  `git rev-parse HEAD` in `REPO_ROOT`, exports `readDeployment()`, declares
  `deploymentResource` (scalar `mode: "push"`, `dependsOn: refHeadResource` —
  explicitly exempt from the membership-bounded rule per
  `research/2026-07-18-global-bounded-working-set-resource-contract.md:225`,
  which names `mainAheadCount` as the precedent).

`target` needs no namespace branching: main's checkout is on `main` and a
worktree checkout is on its own branch, so `HEAD` of `REPO_ROOT` is the target in
both. `computeTrackedRefs` already watches both refs, so `refHeadResource` fires
either way.

Then in `build/server/internal/reconcile.ts`:

```ts
export async function reconcileDeployment(): Promise<void> {
  if (!isMain()) return;                                  // v1 policy
  if (!getConfig(buildConfig).autoBuild) return;
  const deployment = await readDeployment();
  if (!wantsBuild(deployment, await lastClosedAttempt())) return;
  await buildRunDebouncedJob.enqueue({}, { runAt: new Date(Date.now() + DEBOUNCE_MS) });
}
```

Called at the three edges — note it takes **no argument**, which is the whole
point: there is no baseline to carry, so nothing is lost when the build kills the
process that would have carried it.

| edge | wiring |
|---|---|
| target moves | `buildRunJob` (already on `Trigger(refAdvanced)`) calls it. Durable — keep the trigger rather than a `defineRefReaction`, which is main-only-by-accident and has no retry. |
| build reaches terminal | `triggerBuild`'s `finally` and `watchInflightBuild`'s `settle`, both now calling `reconcileDeployment()` instead of `convergeMain(baseline)`. |
| observer starts | `build/server/index.ts` `onReady`, replacing the `getMainAhead()` check. |

Because the decision is stateless and idempotent (the existing
`build_runs_inflight_uniq` partial index already makes a redundant trigger a
no-op), an extra edge is free and a missed edge degrades to "converges at the
next edge". Today every net is load-bearing, which is why all three failing at
once produced a permanent miss. In today's incident, the boot edge alone would
have caught it once the web pin is honest.

`buildRunDebouncedJob` re-checks `wantsBuild` before spawning — the debounce
becomes purely a coalescing optimisation, not a correctness mechanism.

**Deleted:** `convergeMain`, `needsRebuild`, `getMainAhead` (`git-status.ts`),
`main-ahead-resource.ts`, `mainAheadCountResource`, `frontendHashResource`,
`liveInflightBuildCommit` and `adoptedCommit` in `watch-inflight-build.ts` (the
watcher keeps its real job — closing the orphan row promptly). The
`convergeMain` paragraph at the top of `plugins/build/CLAUDE.md` is rewritten.

## Step 3 — the Build button shows the chain

`MainAheadSection` (`build-popover-content.tsx:73-102`, the only consumer of
`mainAheadCountResource`) is replaced by `<DeploymentChain/>` from
`deployment/web`. `useDeployment()` reads the resource and composes in the `tab`
carrier from the bundle's own baked globals — the tab's pin is the tab's own
fact, not something the server can report.

Four arms, all honest:

- **converged** — one commit row carrying every badge.
- **behind** — the chain from the oldest deployable pin to `target`, one badge
  per carrier on its row. A carrier at the right commit but a different `graph`
  sits on **that** row with a distinct marker: it really is at that commit, and
  really is running different bytes.
- **diverged** — `deployable.some(c => !isAncestor(c.commit, target))`. Renders
  "App diverged" plus the raw pins, because there is no line to draw. Use
  `tryRunGit(["merge-base", "--is-ancestor", …])` — its docstring names this
  exact exit-1 case.
- **release / no checkout** — "Release build" plus the pins.

Reuse `CommitRowItem` from `primitives/commit-list/web`; add an optional
`markers?: React.ReactNode` prop for the carrier badges (the existing
`pushed?: boolean` prop is the same idea, hard-coded). The conversation
commits-graph (`conversations/.../commits-graph/web/components/commits-graph-body.tsx`)
is the working precedent for multi-band chains built from this primitive — mirror
its shape.

Note `>` `!=` distinction to preserve: `Head != Server` is the normal transient
state during a build and must still draw the chain. Only a non-ancestor pin is
"diverged".

## Execution

The three steps are **sequential, not parallel** — step 2's reconciler reads the
pins step 1 makes honest, and step 3's UI reads the resource step 2 declares.
Each is delegated to its own implementation agent (`model: "opus"`; this is
load-bearing deploy infra, not lookup work), reviewed before the next starts:

| agent | scope | touches |
|---|---|---|
| **1 · pins** | `headAtStart` threading, `computeGraphHash`, `.build-graph`, globals swap, consumer moves | `cli/bin/commands/build.ts`, `internal/app-artifacts.ts`, `internal/hermetic-build.ts`, `web-artifacts/core/internal/{compose,vite-builder}.ts`, `build/core/resources.ts`, `use-stale-frontend.ts`, `use-action-bar-status.ts`, `reports/server/internal/{record-report,backfill-noise}.ts` |
| **2 · reconciler** | new `plugins/build/plugins/deployment/{core,server}`, `reconcileDeployment`, the deletions | `build/server/**`, new sub-plugin, `build/CLAUDE.md` |
| **3 · chain UI** | `deployment/web`, `<DeploymentChain/>`, `CommitRowItem` `markers` prop | `deployment/web/**`, `build-popover-content.tsx`, `primitives/commit-list/web` |

One `./equin build` after step 3 (backgrounded — the median is ~10 min,
over the foreground cap), then the end-to-end checks below. Steps 1 and 2 are
verified by their pure tests and by reading the staged dist's dotfiles, so they
do not each need a full deploy cycle.

## Verification

**Pure tests** (`./equin test plugins/build/plugins/deployment`) — the
value of extracting `wantsBuild`/`convergenceOf` is that the properties are
testable without the db/config/git singletons, exactly as `run-build.test.ts:300`
does for `needsRebuild` today:

- converged ⇒ no build; behind ⇒ build; same target already attempted (ok or
  failed) ⇒ no build (termination); superseded attempt (`lastAttempt.commit` ≠
  `target`) ⇒ build (this is today's incident as a unit test); `unresolved`
  server pin ⇒ build.

**End-to-end, step 1:** `./equin build`, then confirm the pin matches the
commit the build claimed:

```bash
cat ~/.singularity/worktrees/<wt>/web/.build-commit          # == receipt "commit"
jq -r .commit ~/.singularity/worktrees/<wt>/build-status.json
```

**End-to-end, step 3:** in this worktree (auto-build is main-only, so the state
holds still for inspection) `git commit --allow-empty -m x` on the branch, then
open the Build popover at `http://<worktree>.localhost:9000` — the chain must
show Head one row ahead of Server and Web. Rebuild ⇒ collapses to one row. Use
`plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts` with
`--click` on the Build button to capture before/after.

**End-to-end, step 2 (the actual incident):** on main, push twice within the
build window, or push once mid-build. Then:

```sql
-- mcp query_db, database "singularity"
select id, commit_hash, started_at, finished_at, exit_code
from build_runs where started_at > now() - interval '1 hour' order by started_at desc;
```

A second row for the newer commit must appear after the first closes. Cross-check
`git log -1 --format=%H main` against `web/.build-commit` — they must converge
without manual intervention.

## Risk

The pins touch the deploy path for main, worktrees, compositions and releases.
Step 1 changes no behaviour (only which value is written), which is why it lands
first and separately; a regression there shows up as a wrong badge, not a failed
deploy. Step 2 changes when builds are triggered — the `build_runs_inflight_uniq`
index remains the backstop against overlapping builds, and the config's
`autoBuild: false` remains the kill switch.
