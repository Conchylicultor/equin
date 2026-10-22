# deployment

One honest description of what is deployed, from which both the Build button's
chain and the auto-build decision are derived — so a wrong badge and a missed
rebuild are the same bug.

## The model

A **carrier** is a thing that executes repo code and can name the commit it was
materialized from. There are three:

| carrier  | pinned by                                          | moved by |
| -------- | -------------------------------------------------- | -------- |
| `server` | `git rev-parse HEAD` at module eval, re-checked at `onAllReady` | a build + restart |
| `web`    | `.build-commit` / `.build-graph` in the served dist | a build |
| `tab`    | the globals baked into the bundle it is running     | a reload |

`server` and `web` are the **deployable** carriers — the two a build can move.
The `tab` carrier is composed in client-side; the server cannot know it, and it
is deliberately absent from `deployable` so a tab nobody reloads can never mint a
build.

The **target** is this checkout's `HEAD`. No namespace branching: main's checkout
is on `main` and a worktree checkout is on its own branch, so `HEAD` is the target
in both, and git-watcher already tracks both refs.

## Everything else is derived

`core/derive.ts` holds the two answers, both pure and directly unit-testable
without db / config / git singletons (`core/derive.test.ts`):

- `convergenceOf(d)` → `converged | behind | diverged | unknown`
- `wantsBuild(d, lastAttempt)` → the ENTIRE auto-build policy

Two properties live there and nowhere else:

- **Termination.** `lastAttempt.commit === target` ⇒ no build. Without it a
  commit that cannot build rebuilds for ever, because a failed build leaves the
  carriers behind permanently. It is stated as its own fact rather than encoded
  in the choice of what to compare against — that encoding is what produced the
  2026-08-19 incident.
- **Deployable only.** `wantsBuild` ranges over `d.deployable`. A stale tab
  produces a reload affordance, never a build.

Every pin is `Resolvable`. A carrier that cannot name its commit says
`unresolved(reason)` — never a fake sha, never `""`. Three real cases: a release
bundle has no checkout; a dist published before the pin existed; and **mixed
boot**, where the checkout moved during the plugin import wave so the process is
genuinely a mix of two trees and no single commit is honest.

### Termination beats mixed boot — deliberately

An unresolved pin reads as *not converged*, so `convergenceOf` says `behind`.
But if that target has **already been attempted**, termination still wins and no
build is minted. The two properties pull against each other here, and this is how
it is resolved:

- Exempting unresolved pins from termination is an unbounded loop whenever a pin
  is unresolvable for a *persistent* reason — every build restarts the backend,
  the new process fails its module-eval sample again, and it rebuilds for ever.
  Termination is the only thing standing between the reconciler and that loop, so
  it does not get holes.
- The cost: **a mixed-boot server does not self-heal through auto-build.** It
  stays mixed until the target next moves (then it is an unattempted target, and
  it does build). Tolerable because mixed boot requires the checkout to move
  during the import wave, the state is now loudly visible in the chain rather
  than silent, and **a manual Build bypasses `wantsBuild` entirely** — that is
  the escape hatch for a server wedged this way.

If you are here because a backend is stuck reporting mixed boot: press Build.
That is working as designed, not a bug to fix by weakening termination.

## Why it is a leaf

`deployment/**` must NEVER import `build/server`. The reconciler
(`build/machine/internal/reconcile.ts`) lives where `triggerBuild` already is and
imports DOWN into this plugin. That direction is what keeps the plugin graph a
DAG. If you find yourself wanting the reverse edge, the thing you want belongs
in the reconciler.

## Where the answer comes from and when it changes

`readDeploymentState()` is the wire payload; `readDeployment()` projects the raw
facts back out of it for the reconciler — **one read, two consumers**, so the
badge and the build decision cannot be computed from different git snapshots.

The `build.deployment` live value (`deployment` in `core`, served as
`deploymentServed`) recomputes on exactly two edges — a tracked ref advancing
(`recomputeOn: [refHeadServed]`) and an explicit `notify()` when a build
republishes the dist. Nothing polls it.

**Everything expensive is behind a `createSignedMemo`.** The whole answer is a
function of four cheap inputs (target sha, server pin, `.build-commit`,
`.build-graph`), which is an exact signature — not an over-approximation. That
matters because `refs/heads/main` is tracked in every backend on the host, so one
push to main wakes this loader 100+ times; in all but one the target is that
worktree's own branch, unmoved, and the recompute collapses to the single
`rev-parse` the probe already costs. The same bound signature feeds `revalidate`,
so a resubscribe herd is answered "still current" without a recompute.

Deliberately **not** behind `withHeavyReadSlot`: post-memo the compute runs once
per build (or per advance of this checkout's own branch), and its body is two
`merge-base` probes plus a log walk bounded by how far a checkout drifts between
builds. `host-read-pool` leaves cheap interactive git ungated, and this paints
the Build button.

The resource is a scalar `push` resource and is explicitly exempt from the
membership-bounded rule for DB-backed collections — see
`research/2026-07-18-global-bounded-working-set-resource-contract.md:225`, which
names `mainAheadCount` (this resource's direct ancestor) as the precedent.

## One chain, one renderer, one cap

### Every answerable arm carries a chain

`converged` and `behind` both carry a `Chain` — `{ commits, truncated }`.
Converged's is the walk from `target` to itself: exactly one row, for HEAD.

That costs one `git log -1` on the recompute, and it is worth it. Converged used
to carry a bare sha and no rows, so the client hand-drew a row the normal
renderer could not produce. Two ways to draw a row meant two copies of "which
carrier goes where", and when one was changed the other drifted: every carrier
rendered twice, once as a chip on the synthetic row and once below it as
"not among the commits above". Do not reintroduce the bare-sha arm to save the
walk.

### The chain covers all three carriers, not just the two the server knows

`build.deployment` draws from the oldest DEPLOYABLE pin up to HEAD. That range
is chosen on the server, which cannot know where a browser tab is — so a tab that
has not reloaded since the last build sits BELOW the start of it and has no row
to stand on. It used to render as a line under the chain saying its commit was
not there, which is true and useless: the question a stale tab raises is *how far
behind*, and that is exactly what a row position answers.

The live value `build.chain-from`, keyed by `commit` (`shared/chain-from.ts`),
closes the gap. The client hands back the pin only it holds, the server walks
`commit..HEAD` through the same `chainTo`, and the popover renders one chain with
every carrier on its own row. It is served external (git only), `notified` by
`recomputeOn: [refHeadServed]` — HEAD moving is the one thing that changes the
walk, so an open popover redraws on a ref advance. `web/internal/use-chain-from.ts` is the read; `ChainArm` in
`deployment-chain.tsx` composes. The extension REPLACES the server's chain rather
than merging with it — it is a walk from further back to the same target, so it
is a superset by construction.

**At most one carrier can ever need it**, and structurally so: the server's chain
starts at the oldest deployable pin, so a deployable carrier is always on it, and
the tab is the only other carrier there is. `extensionBase` therefore takes the
first off-chain pin without needing git to order anything.

The endpoint is not memoized and not gated, for the same reason
`computeDeploymentState` is not: one `merge-base` probe plus a capped log walk,
run only when a human opens the Build popover on a tab that is actually stale.
`dedupe: true` collapses a concurrent burst; `staleTime: Infinity` on the client
means opening the popover five times does one walk.

### The walk is capped at `CHAIN_CAP`

Nothing bounds the range on its own. The deployable pins drift by a working
session, but a tab left open for a fortnight asks for hundreds of commits, and
nobody wants that walked, shipped and rendered to answer "how far behind am I".

`chainTo` asks git for `CAP + 1` and keeps `CAP`. Asking for one more than it
keeps is what makes the cap *detectable*: a full walk and one cut short are
otherwise identical from the rows. A capped walk does not read the base's own row
— it never got there — so the carrier that asked has no row, and both facts are
stated on screen: a line inside the list saying older commits are below, and the
carrier's own line saying it is more than `CAP` behind. A chain that simply
stopped would read as "this is all of it".

### Failure and not-yet are types, not values

`ChainFrom` is `chain | unplaceable`, never a possibly-empty `commits` — an empty
list would read as "this tab is at HEAD". A commit git cannot place (a dist built
on a branch since pruned) and a checkout rebased under the tab both come back as
`unplaceable` with the reason, and that reason is what the off-chain line shows.
While the walk is in flight the line says it is placing the commit, rather than
asserting the commit is not on a chain that is about to contain it.

### A tab running the served bytes sits with `web`

A commit that changes nothing the browser runs (server, CLI, gateway) rebuilds
the dist with the SAME graph hash, so the tab is not stale — the Build button
correctly offers no Reload. Placing the tab chip on its own build commit would
still draw it behind. `placementCommit` (`web/internal/carrier-badge.tsx`)
instead puts a tab whose graph equals the served one on `web`'s commit — the
newest commit known to compose those bytes — and the chip's hover keeps the
real build commit. The chain and the Reload segment now ask the same question,
so a tab chip below `web` always comes with a Reload.

Each carrier chip also says its distance out loud (`This tab · 5 behind`), read
straight off the row index — rows run newest-first, so the index IS the count.

## `sameCommit` is tolerance for the past, not the mechanism

Both writers of `build_runs.commitHash` now store the FULL sha — the backend's
`getHeadCommit()`, and the CLI's ledger mint, which records the same
`headAtStart` it stamps into the dist as `.build-commit`. Do not "simplify" one
back to `rev-parse --short`: an abbreviated row against a 40-char pin makes the
termination comparison silently always-false, and a commit that cannot build
would rebuild for ever. `sameCommit` stays only because rows written before that
change are still in the column.

## Background

`research/2026-08-19-global-deployment-convergence-carriers.md` — the incident
this replaces (a push landing 13 s before a build finished, three separate
convergence mechanisms all missing it) and the design.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The client half of the deployment description: `useDeployment()` composes THIS tab's own baked pin in beside the server's two deployable carriers, and `<DeploymentChain/>` renders the four arms — one commit row when converged, the chain with a carrier chip on each carrier's own commit when behind, and the raw pins plus the reason when there is no line to draw. Also eagerly registers the boot-critical build.deployment resource descriptor so boot-snapshot can hydrate it before first paint.
- Server:
  - Contributes:
    - `resource.declare` "build.chain-from"
    - `resource.declare` "build.deployment"
  - Resources:
    - `build.chain-from` (push, notified)
    - `build.deployment` (push, notified)
- Web:
  - Uses:
    - `conversations/commit-conversation.OpenCommitConversation`
    - `network/live.useLive`
    - `primitives/commit-list.CommitRowItem`
    - `primitives/css/badge.Badge`
    - `primitives/css/fill.Fill`
    - `primitives/css/inline.Inline`
    - `primitives/css/line.Line`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.ControlSizeProvider`
    - `primitives/live-state.mapResource`
    - `primitives/live-state.ResourceErrorInline`
    - `primitives/live-state.ResourceResult`
    - `primitives/live-state.ResourceUnavailable`
    - `primitives/loading.Loading`
    - `ui/icons.Icon`
  - Exports (types): `DeploymentReading`
  - Exports (values):
    - `DeploymentChain`
    - `useDeployment`
- Machine:
  - Uses: `network/live.serveValue`
  - Exports (values):
    - `deploymentServed`
    - `readDeployment`
    - `readDeploymentState`
    - `serverPin`
- Core:
  - Uses:
    - `network/live.liveValue`
    - `primitives/commit-list.CommitRowSchema`
    - `primitives/live-state.Resolvable`
    - `primitives/live-state.resolvableSchema`
    - `primitives/live-state.resolved`
    - `primitives/live-state.unresolved`
  - Exports (types):
    - `BuildAttempt`
    - `Carrier`
    - `CarrierId`
    - `Chain`
    - `ConvergenceKind`
    - `Deployment`
    - `DeploymentState`
  - Exports (values):
    - `CARRIER_IDS`
    - `CarrierIdSchema`
    - `CarrierSchema`
    - `CHAIN_CAP`
    - `ChainSchema`
    - `convergenceOf`
    - `deployment`
    - `deploymentOf`
    - `DeploymentStateSchema`
    - `NO_CHAIN`
    - `sameCommit`
    - `wantsBuild`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --primary-text`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --spacing`
  - Imported by: `build`

<!-- AUTOGENERATED:END -->
