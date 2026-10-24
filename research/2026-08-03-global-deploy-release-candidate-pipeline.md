# Build → Rehearse → Ship: the release candidate pipeline in the Deploy app

Status: **plan**, approved for phased implementation (3 landings).
Scope: `plugins/framework/plugins/cli`, `plugins/release`, `plugins/apps/plugins/deploy`.

## Context

On a server's page in the Deploy app you can **Converge** a host and **Ship** a
bundle to it. What you cannot do is *make* that bundle, or look at it before it
goes to production. The prompt that started this was "it would be nice if this
was also integrated with the local composition build, so one can test the output
before deploying" — but the gap underneath is sharper than a missing link
between two pages:

- **`ship` requires a packed, target-platform bundle.**
  `resolveBundle` (`plugins/framework/plugins/cli/bin/commands/deploy.ts:648`)
  discovers bundles purely from the filesystem —
  `~/.singularity/releases/<ns>/<comp>-web/latest` → `RELEASE.json` — and refuses
  unless `target === "web"`, `platform` equals the server's *probed* platform,
  and `dist/<comp>-web-<platform>` exists.
- **The UI can only produce runs that fail every one of those conditions.**
  `run-release.ts:191-209` spawns `./equin release … --dev` and never
  passes `--platform`. Every UI-built run is host-platform and staged-only:
  previewable, never shippable.

So today the app builds exactly what it cannot ship, and ships exactly what it
cannot build. The only path to a shippable bundle is a hand-run CLI release, and
the deploy page shows nothing about which bundle `ship` would pick — you learn it
from the failure text.

Two more defects fall out of the same area and are fixed here because the feature
cannot be correct without them:

- **The `latest` pointer is clobbered across platforms.** It is
  `join(dirname(out), "latest")` (`release.ts:934`), keyed by `<comp>-<target>`
  only. A host `--dev` run and a `linux-x64` candidate of the same composition
  overwrite each other's pointer; `ship` then resolves the wrong one and refuses
  on platform mismatch. Worse, a `--dev` run claims the pointer at all, so the
  bare `ship` path can resolve a run that was never packed.
- **Nothing records what source a bundle was built from.** `RELEASE.json` carries
  `{composition, target, platform, builtAt, port, runId}` and `release_runs` has
  no sha column. "Is this bundle current?" and "did I test the code I am
  shipping?" are unanswerable.

### Intended outcome

From `/deploy/server/:serverId`, a user drills into a deployment and walks
**Converge → Build → Rehearse → Ship**, never leaving the app, with the app able
to state — from recorded provenance, not from timing — whether the thing they
rehearsed is the thing they are shipping.

### The one thing the UX must stay honest about

A `linux-x64` binary cannot execute on the macOS host, so nothing local ever runs
the bytes that ship. "Test it locally" means: **open the composition's served
namespace** — `http://<composition>.localhost:9000`, the dev build on the dev
cluster — and confirm the app composes and renders. That is a **rehearsal of the
composition**, not of the artifact. It catches plugin-membership and closure gaps
(the missing-DataView-renderer bug in `plugins/release/CLAUDE.md`); it does not
catch packaging, config vendoring, first-boot migrations, natives or
cross-compile. Every string in this UI says *rehearsal*, never *preview* or
*test the bundle*, and the pane states the limit in plain text.

## The model

**A release candidate** is one `release_runs` row of `kind: "candidate"`: packed,
built for the server's probed platform, pinned by run id when shipped.

**A rehearsal** is *not a build at all*. It is **the composition's one served
namespace** — `http://<composition>.localhost:9000`, the same URL Studio's
auto-serve produces and the user already knows. Rehearsing reuses that namespace
if it exists and creates it if it does not. There is exactly one gateway on the
host and exactly one namespace per composition.

The two are **paired by commit**, not by recency: the candidate's `commitSha`
against the commit of the main build that provisioned the served namespace. A
mismatch is reported loudly as *not* a rehearsal of this candidate, and anything
built from a dirty worktree is never claimed to be a rehearsal of anything.

### Two rejected designs, and what the chosen one costs

- **One invocation emitting both artifacts (`--with-preview`)** — makes the
  pairing a tautology, but pays a doubled compile and ~3× disk on *every* build
  including the ones nobody tests.
- **The release preview manager** (`preview-manager.ts`) — boots the staged
  `launch` binary with its own gateway process, its own embedded Postgres and a
  `/tmp/sgp-*` data root on a free port from 9101. It is the closest thing to the
  deployed stack, but it means **a second gateway on the host** and an unstable
  random-port URL. Explicitly rejected on the operator's call: one gateway, one
  composition namespace.

**What that costs, stated plainly.** The served namespace is the *dev build on
the dev cluster*: filtered per-name registries, a web dist composed over the
shared artifact store, an empty DB, propagated config, served by the shared
gateway (`compose-serve.ts:1-15`). It validates the **composition** — plugin
membership, closure completeness, the UI actually rendering. It does **not**
exercise the release artifact: config vendoring into the bundle, first-boot
migrations under the launcher, native staging, the packed binary's
self-extraction, or the bare default-namespace route. So the claim the UI may
make is *"you tested this composition at `a1b2c3d`"* — never *"you tested this
artifact"*. `ship`'s remote health gate and revert become the only thing that
exercises the artifact before it is live, which raises their importance rather
than lowering it. Both release-completeness gaps recorded in
`plugins/release/CLAUDE.md` are instructive here: the missing-DataView-renderer
closure gap **is** caught by a served namespace; the unvendored-config-defaults
gap is **not**.

## Phase 1 — one bundle authority, plus provenance

No UI change. Independently useful: it fixes the pointer bug and makes `ship`'s
refusals reusable.

### New plugin: `plugins/release/plugins/bundles/`

The on-disk bundle registry, extracted from the CLI so there is exactly one
implementation of "which bundle would ship, and why not". It must be reachable
from **both** a CLI process and an HTTP handler, which fixes its shape: `core/` is
browser-safe, `server/` is Node-only and **DB-free** — the constraint recorded at
`release.ts:97-101` is that the CLI cannot import `@plugins/release/server`
because that barrel eagerly pulls `@plugins/database/server`.

```
plugins/release/plugins/bundles/
  core/index.ts          ReleaseManifestSchema, BundleResolution, bundleRefusalMessage(), Staleness
  server/index.ts        bundleRoot(), latestPointer(), resolveBundle(), compareToHead(), pruneReleaseRunDirs()
```

`resolveBundle` returns a discriminated result rather than calling `refuse()` and
exiting — the repo's own absorbable-failure rule, and what lets an endpoint act on
the same value the CLI acts on:

```ts
export type BundleResolution =
  | { ok: true; runId: string; localPath: string; binaryName: string; manifest: ReleaseManifest }
  | { ok: false; refusal: BundleRefusal };
```

`BundleRefusal` enumerates today's cases by name — `no-releases`, `no-pointer`,
`no-such-run`, `no-manifest`, `wrong-composition`, `wrong-target`,
`platform-mismatch`, `inconsistent-run-id`, `not-packed` — and
`bundleRefusalMessage()` reproduces the CLI's current wording **byte-for-byte**,
so this refactor is invisible at the terminal.

`deploy.ts` deletes its `Bundle` / `ReleaseManifest` / `bundleRoot` /
`namespaceHint` / `resolveBundle` block (~580-730) and calls the plugin.

### The pointer

- `latest` → **`latest-<platform>`**. Cross-platform clobbering becomes
  structurally impossible instead of a refusal.
- The write **moves after `packStagedTree`** (`release.ts:1002-1015`), so only a
  packed run ever claims a pointer. A `--dev` run claiming `latest` is the
  existing bug.
- Both the writer (`release.ts:931-936`) and the reader (now `bundles/server`)
  are the only two spellings of the name; they change together.

### Provenance

`git rev-parse HEAD` and `git status --porcelain` are read **before** step 1
(`build-composition` writes generated files and would perturb the dirty read),
via `tryRunGit` from `@plugins/primitives/plugins/commit-list/server` — already
DB-free and importable by the CLI. `RELEASE.json` and `release_runs` both gain
`commitSha` + `commitDirty`.

```ts
export type Staleness =
  | { kind: "current" }
  | { kind: "behind"; commits: number }      // sha is an ancestor of HEAD
  | { kind: "diverged"; sha: string }
  | { kind: "unknown"; reason: string };     // dirty build, absent sha, or sha unknown to this repo
```

`commitDirty` ⇒ **always `unknown`**, reason *"built from a dirty worktree — the
sha names the parent commit, not the bytes."* Never report `current` for
something unprovable. In an active worktree most UI-built candidates will read
`unknown`; that is the honest answer and the UI copy says so rather than
softening the rule.

### Retention

`~/.singularity/releases/` has no retention policy today
(`pruneWorktreeReleaseArtifacts` prunes logs, not run dirs) and this feature
multiplies run dirs. `pruneReleaseRunDirs(namespace, comp, target, keep = 3)`
runs after the pointer write and never deletes the run a `latest-<platform>`
points at, nor one with a live preview.

**Files:** new `plugins/release/plugins/bundles/**`; modify
`plugins/framework/plugins/cli/bin/commands/{deploy,release}.ts`,
`plugins/release/server/internal/{tables,run-release}.ts`,
`plugins/release/core/resources.ts`.

## Phase 2 — build and ship a pinned candidate from the deploy page

### Engine

`triggerReleaseEndpoint`'s body takes a discriminated intent, so "a candidate
always names its platform" is unrepresentable-otherwise and the omitted case is
byte-identical to today's Studio behaviour:

```ts
export const ReleaseIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("staged") }),                                 // --dev, host platform (today)
  z.object({ kind: z.literal("candidate"), platform: PlatformTagSchema }), // --platform <tag>, packed
]);
```

`triggerRelease({composition, target, intent})` builds argv from the intent;
`release_runs` gains `kind`. Add `PlatformTagSchema` to
`plugins/release/core/platforms.ts`.

**`GET /api/release/candidate?composition&platform`** → `{ resolution, run,
staleness }`. Owned by `plugins/release`, not by deploy: "which run would ship
for composition C on platform P" is a release-engine question, and the only
deploy-specific input is P, which the UI already has from `useServerHealth`. This
adds **no server-side edge between deploy and release**. The split inside the
handler is the design statement: *the filesystem says whether a shippable bundle
exists and matches; the DB says where it came from and whether it was rehearsed.*
The UI renders `bundleRefusalMessage()` verbatim and never re-derives
shippability.

An endpoint with `dedupe: true`, refetched on the existing
`release.history-revision` tick, rather than a new live resource — a
per-composition collection resource would be unbounded, which the resource
contract forbids.

`DeployRunSchema` gains `release: string | null`, set from `body.release`, so
"what is live on this box" is answerable from the run record instead of by
reading the log.

### UI

**A per-deployment Miller column.** The deployments DataView is the only
dead-end list in an app that otherwise drills in everywhere, and a 4-verb pipeline
with two artifacts and two revisions does not fit a row's rigid trailing region
(already three `RowActionButton`s and a run chip). The pane copies
`compositionDetailPane` verbatim in shape.

```ts
// plugins/apps/plugins/deploy/plugins/deployments/web/panes.tsx  (new)
export const deploymentDetailPane = Pane.define({
  id: "deploy-deployment-detail",
  defaultAncestors: [serverDetailPane],
  segment: "dep/:deploymentId",
  width: 460,
  resolve: useResolveDeployment,
  useTitle: useDeploymentTitle,   // titleOwner NOT set — the server page keeps the tab title
});
```

Its body is only `<DeploymentDetail.Host deploymentId={id}/>`, where

```ts
// deployments/web/slots.ts  (new)
export const DeploymentDetail = defineDetailSections<{ deploymentId: string }>(
  "deployment-detail", { collapsible: true, defaultOpen: true });
export const Deployments = { Fields: defineFieldExtensions<Deployment>("deploy.deployments.fields") };
```

**The pipeline steps are not a slot.** Converge → Build → Rehearse → Ship is a
closed, ordered list whose gating between steps *is* the content — plain data, per
CLAUDE.md's closed-list rule. The pane *sections* are the open set.

| section | owner |
| --- | --- |
| `overview` — hostnames, port, derived install names | `deployments` (existing content, moved) |
| `pipeline` — the four steps | new `deploy/plugins/release-pipeline` |
| `output` — logs | new `deploy/plugins/release-pipeline` |

**The row gains a `Release` field** contributed through `Deployments.Fields`, so
`deployments` never names the release feature — the `Servers.Fields` ←
`health.StatusField` precedent. A `FieldDef` of `type: "enum"` with a custom
`cell`, which buys the filter chip and group-by free (*what on this box is
stale?*). States, resolved in priority order:

```
building → failed (only when no bundle exists at all) → none
→ platform-mismatch → stale → rehearsal-failed → rehearsed → built
```

A build that fails *after* a good bundle exists does **not** flip the row to
failed — the field states what Ship would pick, and Ship would still pick the old
bundle. The failure surfaces in the Build step. (Same rule as `RunFailureNotice`:
a refusal reaches the user unsummarised, in the place it belongs.)

**The steps** use `Steps`/`Step`/`StepNote` from `primitives/setup-steps` —
already the Deploy app's vocabulary in `health` and `ssh-setup`. The load-bearing
property: `state="upcoming"` renders a step dimmed **and inert**, so gating is
structural rather than a pile of `disabled` props.

1. **Converge the host** — existing action. Note: *"Idempotent — re-run it any
   time to repair drift."* Plus the honest caveat that runs are only remembered
   since the last backend restart (the recorded "no run ledger, on purpose" rule).
2. **Build for {platform}** — `intent: {kind:"candidate", platform}`, the platform
   read from the probe, never a picker (a field with a default is a field someone
   sets back to the wrong value — the `deriveInstall` argument). Blocked reasons
   reuse `useBlockedReason`'s exact sentences, plus *"A build of "{comp}" is
   already running"* — structural, since the engine's inflight unique index is
   `(namespace, composition)`. While running: an inline `LiveLogChannel` on the
   `release` channel — the CLI has no progress protocol, and the log *is* the
   progress.
3. **Rehearse** — P3. In P2 the step renders with its explanatory note and a
   disabled control.
4. **Ship {platform} bundle** — pins `--release <runId>`. The always-rendered
   provenance block is the "you tested X, you are shipping X" surface:
   candidate `[linux-x64] [a1b2c3d] built 12m ago` / rehearsal / `HEAD`, with one
   sentence resolving them. In P2 that sentence is *"This bundle has never been
   rehearsed."* and the button reads **Ship without rehearsing** (`outline`,
   destructive tone) behind a confirm dialog.

**Logs**: one Output section, a `ViewSwitcher` over the two channels (`deploy`,
`release`) with `LiveLogChannel key={activeId}` — remount-on-switch resets the
buffer, the `debug/logs` trick, but through the sanctioned switcher chrome rather
than a second hand-rolled `role="tablist"`. Each tab carries a scope caption,
because the asymmetry is real: `deploy` is server-scoped SSH output; `release` is
worktree-scoped and covers *every* composition. The server page's existing
"Deploy output" card is untouched.

**Extract `LiveLogChannel`** into the existing
`@plugins/primitives/plugins/log-channels/web` barrel first: the WS-subscribe +
sticky-scroll + copy-button body already exists in three near-identical copies
(`deploy-log-panel.tsx`, the release log section, `log-viewer.tsx`). Without the
extraction this feature adds a fourth.

**Files:** new `plugins/apps/plugins/deploy/plugins/release-pipeline/**`, new
`deployments/web/{panes,slots}.tsx`; modify `deployments-section.tsx`,
`deployments/core/runs.ts`, `plugins/release/core/{endpoints,platforms}.ts`,
`plugins/release/server/internal/{run-release,handle-candidate}.ts`,
`plugins/primitives/plugins/log-channels/web/**`.

## Phase 3 — rehearsal on the served namespace, and the boot check

**Rehearse builds and spawns nothing.** It ensures the deployment's composition
occupies its one served namespace, then hands over the stable URL
`http://<composition>.localhost:9000`.

**Reuse or create**, in that order:

1. `readCompositionMarker(id)` — a `composition.json` marker means
   `compose-serve` already owns that namespace. Reuse it; open the URL.
2. No marker → `useServeComposition().serve(id)`
   (`auto-serve/web/internal/*.ts`): `setAutoBuild(id, true)` writes **main's**
   config so the stage keeps serving it, and `POST /api/build/serve` kicks an
   immediate main build whose `compose-serve` stage provisions registries → dist
   → empty DB → config → `spec.json` → gateway restart.

Nothing new is invented for either path — both already exist and are used by the
Studio compositions list today. The deploy pane becomes a second consumer.

**Two constraints, surfaced rather than worked around:**

- **Serving is main-only.** `handle-serve-composition.ts:8-10` refuses off-main
  with *"Serve builds run on the main instance only — open
  singularity.localhost:9000."*, and `compose-serve` reads **main's** resolved
  config, so a toggle from a worktree is inert (the auto-serve CLAUDE.md's
  authoritative-worktree caveat). The Rehearse step disables with that exact
  sentence when the deploy app is open in a worktree namespace. Reusing an
  already-served namespace still works everywhere — only *creating* one is
  main-only.
- **The namespace is shared, not per-deployment.** Two servers running the same
  composition rehearse against the same URL. That is correct — the rehearsal is a
  property of *(composition, commit)*, not of a deployment — and is why the
  verdict is stored keyed that way (below).

**Reset to first launch.** `POST /api/studio/compositions/auto-serve/reset` wipes
only that composition's DB and config dir back to what `compose-serve` provisions
on a fresh serve, then restarts its backend. The step surfaces it as a secondary
destructive action — it is how you see the genuine new-user experience, which is
the one thing the rejected `/tmp`-data-root preview gave for free.

**The boot check is programmatic.** `plugins/release/e2e/release-boot-verify.ts`
already exits 0/1 asserting the SPA truly mounted (real `#root` tree re-checked
after a settle window, zero console/page errors, no gateway↔backend 502/404
storm); the only missing piece was a caller. A new handler in the deploy
`release-pipeline` plugin spawns it against
**`http://<composition>.localhost:9000/`** and records the verdict.

**The verdict is keyed by `(composition, commit)`, not by deployment or by run.**
What was checked is a served namespace at a source state; one rehearsal legitimately
serves every deployment of that composition on every server. A small table owned
by `release-pipeline` (its only consumer — putting it in `auto-serve` would create
an edge from a Studio plugin toward deploy):

```
deploy_composition_checks(composition, commit, verdict, checkedAt, error)  PK (composition, commit)
```

`CompositionMarker` (`infra/worktree/server/internal/composition-namespace.ts:15-19`)
gains a `commit` field alongside `composition/builtAt/buildId` — `compose-serve`
already receives `buildCommit` in its options, so this is one field threaded to the
marker write. It is what makes "the namespace currently serves `a1b2c3d`"
answerable at all.

**Step 4's provenance sentence** then resolves to one of:

| case | sentence |
| --- | --- |
| commits match, check passed | "You rehearsed `a1b2c3d`, and you are shipping `a1b2c3d`." |
| commits match, check failed | "The rehearsal of `a1b2c3d` failed its boot check." |
| commits differ | "The served composition is `e4f5a67`; this bundle was built from `a1b2c3d`. **You are shipping code you did not rehearse.**" |
| candidate built dirty | "This bundle was built from a dirty worktree, so it cannot be proven to match what you rehearsed." |
| never served | "This composition has never been served — nothing has been rehearsed." |
| always, muted | "A rehearsal runs the dev build on the dev cluster. It checks the composition, not the linux-x64 bundle — which has never been executed on this machine." |

A failed boot check keeps the URL chip visible; the user should go look.

**Files:** new `deploy/plugins/release-pipeline/server/**` (check table, verdict
handler, boot-check runner) and its step components; modify
`plugins/infra/plugins/worktree/server/internal/composition-namespace.ts` and
`cli/bin/commands/internal/compose-serve.ts` (marker `commit`).

**Follow-up, not in scope:** Studio's release-artifact section still starts a
`preview-manager` stack — a second gateway, a second Postgres, a `/tmp` data root.
If "one gateway on the host" is a global rule rather than a rule for this flow,
that surface needs its own task.

## Schema

`_releaseRuns` (`plugins/release/server/internal/tables.ts`), mirrored into
`ReleaseRunSchema` (`pid` stays stripped):

| column | type | phase | why |
| --- | --- | --- | --- |
| `commitSha` | `text` | P1 | provenance / pairing |
| `commitDirty` | `boolean` | P1 | forces `Staleness.unknown` |
| `kind` | `text NOT NULL DEFAULT 'staged'` | P2 | `candidate` (shippable, built here) vs `staged` (Studio's `--dev` runs) |

P3 adds **no** `release_runs` columns: a rehearsal is not a release run. It adds
one small table, `deploy_composition_checks`, keyed `(composition, commit)`, plus
a `commit` field on `CompositionMarker`.

Deliberately **no `shippable` column**: shippability is `resolveBundle`'s verdict
against the filesystem, and a cached boolean is a second, drift-prone answer.
Migrations are generated by `./equin build` — never by hand.

## Verification

Per phase, in the worktree, after `./equin build`:

**P1** — behaviour must be unchanged at the terminal.
- `./equin release --composition website --target web --platform linux-x64`
  then confirm `~/.singularity/releases/<ns>/website-web/latest-linux-x64` exists
  and no bare `latest` is written; `RELEASE.json` carries `commitSha` /
  `commitDirty`.
- `./equin release --composition website --target web --dev` → asserts
  **no** pointer is claimed.
- `./equin deploy ship website --server <id>` against a stale/absent bundle
  → refusal wording identical to before the extraction (diff against
  `git show $(git merge-base HEAD main):…/deploy.ts`).
- `mcp__singularity__query_db`: `select id, kind, commit_sha, commit_dirty from release_runs order by started_at desc limit 5`.

**P2** — end to end in the app at `http://<worktree>.localhost:9000/deploy`.
- Drill into a deployment; confirm the pane pushes as a fourth Miller column and
  the row highlights from the route, not local state.
- Build with an unprobed server → every control inert with the existing
  "run Verify connection" sentence.
- Build → the `release` log streams inline → the row chip goes
  `Building` → `Built` → Ship pins the run id: check the argv line published to
  the `deploy` channel contains `--release release-…`.
- An E2E script at
  `plugins/apps/plugins/deploy/plugins/release-pipeline/e2e/pipeline-verify.ts`
  driving the pane through the blocked/enabled states via the shared harness.

**P3**
- Rehearse a composition that is **already served** (e.g. `sonata`) → the step
  reuses the namespace with no build, and the URL chip reads
  `http://sonata.localhost:9000`. Confirm no second gateway process appears:
  `ps ax | grep -c gateway` is unchanged before and after.
- Rehearse a composition that is **not** served → a main build runs, the
  namespace is provisioned, the URL resolves.
- Boot check → `select * from deploy_composition_checks` shows one row per
  `(composition, commit)` with `verdict = 'pass'`; the provenance sentence reads
  "You rehearsed X, and you are shipping X."
- Open the deploy app in a **worktree** namespace and confirm Rehearse-to-create
  is disabled with the verbatim "Serve builds run on the main instance only"
  sentence, while Rehearse-to-reuse still works.
- Force a mismatch: rehearse, then rebuild the candidate at a later commit, and
  confirm the "you are shipping code you did not rehearse" sentence appears and
  the button becomes **Ship without rehearsing**.
- `bun plugins/release/e2e/release-boot-verify.ts --url http://sonata.localhost:9000/ --settle 15000`
  by hand, to confirm the programmatic caller and the manual invocation agree.

## Orchestration

Each phase is one landing, reviewed before the next starts. Per phase:

1. **Pre-flight** — one `Explore` (sonnet) over the exact files the phase touches,
   re-reading them at current HEAD rather than trusting this doc's line numbers.
2. **Implement** — one `Agent` (opus, load-bearing) scoped to that phase only,
   handed this doc plus the pre-flight report. P2's UI and P2's engine half can
   run as two parallel opus agents (disjoint files: `plugins/release/**` +
   `core/runs.ts` vs `deploy/plugins/**` + `log-channels`), joined by the endpoint
   contract fixed in this doc.
3. **Verify** — `./equin build`, then the phase's verification block above,
   run by me, not delegated.
4. **Review** — `/code-review` on the phase diff before it is offered for push.

Nothing is pushed without an explicit instruction.

## Risks

- **The extraction in P1 is the only step that can regress a working path.** It
  lands alone, wording-diffed, before anything else moves.
- **`--dev` runs no longer claim a pointer.** A hand-run `release --dev` followed
  by a bare `ship` now refuses *"no `latest-<platform>` pointer"* instead of
  *"staged but never packed"*. Better message, but a different one.
- **`commitDirty` noise.** In an active worktree, most candidates read
  `Staleness.unknown` and most rehearsal pairings read "cannot be proven to
  match". That is honest, and the copy says so — but it means the signal is only
  sharp for releases cut from a clean tree.
- **The rehearsal drifts from the candidate by construction.** The served
  namespace is built from **main**, the candidate from the worktree the deploy app
  runs in. They agree only once the work has landed on main. The commit comparison
  is loud, never silent, and the normal flow (push, then ship) converges — but a
  ship straight from a worktree will honestly report an unrehearsed candidate.
- **A green boot check proves much less than it looks like.** It proves the
  *composition* renders on the dev cluster. It says nothing about config vendoring,
  first-boot migrations under the launcher, native staging, or the packed binary.
  `ship`'s remote health gate and revert are now the only thing that exercises the
  artifact, and must not be weakened on the strength of a green check. The
  CLAUDE.md text will say exactly this.
- **Rehearsing mutates shared state.** Serving a composition writes main's config
  and triggers a main build; Reset-to-first-launch wipes that composition's DB.
  Both are pre-existing Studio affordances, but the deploy pane makes them reachable
  from a production-shipping context, so the destructive one stays behind a confirm.
- **Disk.** Candidates + rehearsals multiply run dirs under a tree that has never
  been pruned. `pruneReleaseRunDirs(keep = 3)` lands in P1, before the volume
  arrives.
