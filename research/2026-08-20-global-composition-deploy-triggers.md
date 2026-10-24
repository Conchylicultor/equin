# Composition deploy triggers — one-off, on push, on a schedule

Phase 6 of
[`2026-08-17-global-composition-build-serve-model.md`](./2026-08-17-global-composition-build-serve-model.md).

## Context

A composition can only be deployed by hand. The Studio serve panel has one
binary `Serve` / `Serving` chip, and that chip's config field (`autoBuild`) is
pure intent — since the compose-serve tail stage was deleted, nothing reads it
and nothing acts on it. The only automatic build in the system is main's own
rebuild on `git.refAdvanced(refs/heads/main)`, which covers main's namespace and
nothing else. A served composition therefore drifts: `sonata` keeps serving the
dist and running the server code of whatever commit last happened to build it.

Wanted: say **when** a composition should be rebuilt — only when I ask, on every
push, or on a cadence — with a manual "rebuild now" always available whatever the
mode says, and with the automatic modes doing nothing while there is nothing to
do.

The shape this lands in is deliberately not a new mechanism. `build` already
models auto-build as a **convergence loop** (`reconcileDeployment` +
`wantsBuild`), not a queue of push events, and that design is what survived the
2026-08-19 incident. A composition gets the *same* loop, the same pure policy
function, and the same termination guarantee — the only thing a "trigger mode"
adds is a **rate limit** on how often the loop may act.

## Decisions taken before writing this

- **Change signal = the deployed commit vs this checkout's HEAD.** The
  `composition.json` marker already records the commit its build ran from
  (`CompositionMarker.commit`), so `marker.commit !== HEAD` is free, never skips a
  build that was needed, and covers *everything* a rebuild moves — the web dist,
  the server tree the namespace's backend is spawned from, migrations, config.
  A closure-scoped inputs-hash gate was rejected: it would be a second
  implementation of "what is in this composition" that can drift from the build's,
  and it is blind to server/migration changes, so a served composition would keep
  running old server code after a push. The inputs hash still does its job — but
  *inside* the build, where an unchanged closure means every artifact is a cache
  hit and the vite stage is near-free.
- **One enum, not a bool plus a mode.** `serve` replaces `autoBuild`, so
  "rebuild on push but not served" has no spelling (ladder rung 1).
- **A manual rebuild is available in every mode**, including `push` and the
  cadences — it is the escape hatch for the one thing the commit gate cannot see
  (see *Known limitation* below).
- **Main only**, exactly like main's own auto-build (`deploymentWantsBuild`
  returns `false` off main) and like the durable `git.refAdvanced` event, which is
  emitted only from main. A worktree serving `sonata.att-x` keeps the explicit
  buttons, which work everywhere. This is the same reasoning
  `events.refresh-tick` gives for being main-only.

## The model

```
serve mode   automatic rebuild allowed …
off          — (not served at all)
manual       never
push         immediately (rate limit 0)
hourly       at most once an hour
daily        at most once a day
weekly       at most once a week
```

A mode's **entire content is its rate limit**. Every edge then evaluates every
mode through one predicate, so `push` needs no push-specific plumbing and a
cadence needs no cadence-specific edge:

```
rebuild <id> ⇔  autoRebuildIntervalMs(mode) !== null           (mode is automatic)
             ∧  isServableCompositionId(id)                     (never main's namespace)
             ∧  marker exists for namespaceFor(id, checkout)    (already served here)
             ∧  now − marker.builtAt ≥ interval                 (rate limit)
             ∧  wantsBuild({ target: HEAD, deployable: [marker as the `web` carrier] },
                            lastAttemptFor(id))                  (the SAME policy as main)
```

`wantsBuild` (`plugins/build/plugins/deployment/core/derive.ts`) is reused
verbatim, which buys three properties for free and unit-tested:

- **converged ⇒ no build** — `marker.commit === HEAD`.
- **termination** — a target already attempted (ok *or* failed) is not
  re-attempted, so a composition that cannot build does not rebuild forever.
- **an unresolvable pin is `behind`, never converged** — a marker written before
  the `commit` field builds once and then self-heals.

The marker is modelled as the single `web` carrier with `graph` and
`ancestorOfTarget` `unresolved(...)` (determinate absences, not failures — we do
not read another namespace's dist graph and we do not pay an ancestry probe per
composition per edge). `convergenceOf` only compares `commit` for the converged
arm and only trips `diverged` on a *resolved* `false`, so this is exact.

**A marker-less composition is never auto-built.** An automatic trigger may not
mint a namespace nobody ever asked for; claiming one is what the explicit
`Serve` action does.

### Edges

The decision is stateless and idempotent, so an extra edge is free and a missed
edge degrades to "converges at the next edge" — the property
`plugins/build/CLAUDE.md` already documents. Composition rebuilds hang off the
same edges as main's, plus one:

| edge | exists today | new |
| --- | --- | --- |
| `refAdvanced(refs/heads/main)` → `build.run` | ✅ | — |
| a build reaching terminal (`triggerBuild`'s `finally`, `watchInflightBuild`) | ✅ | — |
| this backend starting (`onReady`) | ✅ | — |
| `build.composition-tick` cron, `*/15 * * * *`, singleton, main-only | — | ✅ |
| the `compositions` config changing (`watchConfig`) | — | ✅ |

The cron tick is the sanctioned `defineJob` schedule, never a timer — mirroring
`events.refresh-tick`, including the `*/15` choice (the finest cadence a
composition can pick is hourly, so the tick only has to be fine enough that
"hourly" is not visibly late). Its whole body is `await reconcileDeployment()`.

The config edge makes switching a composition to `push` act at once instead of
within 15 minutes; the debounce coalesces the burst a Studio edit produces and
the decision is re-derived anyway, so it cannot cause a wrong build.

### One in-flight build, main first

`triggerBuild` claims a single durable in-flight slot and is deliberately
target-blind. So the debounced job asks in priority order:

```ts
if (await deploymentWantsBuild()) { triggerBuild("auto"); return; }   // this checkout's own app
const ids = await compositionsWantingRebuild(new Date());
if (ids.length > 0) triggerBuild("auto", { compositions: ids });      // ONE invocation, N targets
```

The fan-out is **one** `./equin build --composition a b c`: one install,
one codegen, one checks pass, one transcript, one `build_runs` row with N chips —
which `targets: text[]` and `isMainCompositionBuild` already model. Main's build
and the composition build stay separate invocations on purpose: a run whose
`targets` were `["singularity","sonata"]` would not match `lastClosedAttempt`'s
`targets = [MAIN]` predicate, and main's reconciler would conclude main was never
built for that commit and build again.

## Known limitation (documented, not worked around)

The commit gate answers *"has the tree moved"*. Editing a composition's own
manifest row — contributors, entry points, `extends` — changes what should be
served without moving HEAD, so it is **not** an automatic trigger. The explicit
**Rebuild now** button is the answer, and it is available in every mode for
exactly this reason.

Folding a digest of the flattened manifest row into the marker would close it,
but it needs its own termination axis (`BuildAttempt` records a commit, not a
digest), and without one a composition whose build fails on a manifest edit would
rebuild forever. That is a follow-up, not this phase.

## Work

### 1. `serve` replaces `autoBuild` — `plugins/plugin-meta/plugins/composition`

- `core/serve-mode.ts` (new): `SERVE_MODES` / `ServeMode`, the total
  `Record<ServeMode, number | null>` of rate limits, `autoRebuildIntervalMs(mode)`
  and `isServed(mode)`. A total record so adding a mode is a `tsc` error here
  rather than a mode that silently never fires — the rule
  `events/refresh/schedule.ts` states for `CADENCE_INTERVAL_MS`.
- `core/config.ts`: `autoBuild: boolField` → `serve: enumField({ options: [...], default: "off" })`,
  with labelled options. All ~40 seeds and the `app()` / `subsystem()` / `pack()`
  helpers change `autoBuild: false` → `serve: "off"`. Rewrite the field's docblock
  (it currently ends "Re-wiring it to a trigger is Phase 6").
- `core/activated.ts`: `activatedCompositionIds` filters on
  `isServed(i.serve) && isServableCompositionId(i.id)`. Name and callers unchanged.
- `core/config.test.ts`, `web/internal/manifests.ts` (`setAutoBuild` →
  `setServeMode(id, mode)`).

**Migration cost is zero right now** — verified: no user-layer
`compositions.jsonc` exists (only `compositions.origin.jsonc`), and no
`~/.singularity/worktrees/*/composition.json` marker exists, so nothing is served
and no user layer can go stale on the origin-hash bump. Land it anyway as its own
commit, per the Phase 1 note.

### 2. The decision — `plugins/build/server`

- `internal/wants-build.ts`: add `compositionsWantingRebuild(now: Date): Promise<string[]>`
  implementing the predicate above, plus `lastCompositionAttempt(id)` — the same
  query as `lastClosedAttempt` with the `targets` predicate swapped from
  `eq(targets, [MAIN])` to "array contains `id`" (`arrayContains`, or the explicit
  `@>` via `sql`). `readDeployment()` is read **once** per pass and its `target`
  shared with main's decision, so this adds no git spawn.
- The pure half — mode + marker + head + attempt + now → boolean — lands in
  `plugins/build/server/internal/composition-trigger.ts` with a `bun:test` beside
  it, mirroring `deployment/core/derive.test.ts`. **Not `core/`**, unlike
  `derive.ts`: nothing web-facing asks this question, and `core/` is external to
  the `web` artifact, so putting it on that barrel would route the compositions
  manifest it imports into `build/web`'s chunk for a predicate the browser never
  runs.
- `internal/build-run-debounced-job.ts`: the main-first / compositions-second body
  above.
- `internal/reconcile.ts`: enqueue the debounced job when **either** main or some
  composition wants a build.
- `internal/run-build.ts`: `triggerBuild(trigger, opts?: { compositions?: readonly string[] })`.
  Row `targets: opts?.compositions ?? [MAIN_COMPOSITION_ID]`; argv
  `--composition a b c`. Update `handle-serve-composition.ts` to pass
  `{ compositions: [body.composition] }`.
- `internal/composition-tick-job.ts` (new): `defineJob({ name: "build.composition-tick",
  hold: "instant", dedup: "singleton", schedule: { cron: "*/15 * * * *" }, maxAttempts: 3 })`
  whose `run` is `reconcileDeployment()`. `perWorktree` left unset ⇒ main only.
- `server/index.ts`: register the tick job; in `onReady`, add
  `watchConfig(compositionsConfig, () => { void reconcileDeployment(); })`.

### 3. Status read — `plugins/build/plugins/serve-composition`

- `shared/endpoints.ts`: add `autoTriggersHere: z.boolean()` to
  `ServeStatusResponseSchema`; `handle-status.ts` answers `isMain()`. Without it a
  worktree's panel would offer "On every push" and silently never act — the
  surface must not promise a trigger this backend does not run.
- `web/internal/use-serve-composition.ts`: `{ serve, stop }` →
  `{ setMode(id, mode), rebuildNow(id) }`. `setMode` writes the config and, when
  it moves the row off `"off"`, also POSTs `serveCompositionEndpoint` (today's
  serve behaviour). `rebuildNow` POSTs only.

### 4. UI — the serve panel and the list

`web/components/serve-target-panel.tsx`:

```
[ Serving ]   sonata.localhost:9000   a1b2c3d   built 4m ago   [ Rebuild now ]  [ Reset ]

Rebuild:  ( Manual · On push · Hourly · Daily · Weekly )

Automatic rebuilds run only when this checkout's commit has moved past the one
sonata was built from, and only from the main checkout.
```

- the `Serve` / `Serving` `ToggleChip` stays as the off ↔ served switch (turning
  on restores the last non-`off` mode, defaulting to `manual`);
- a `SegmentedControl` (`primitives/css/toggle-chip`) picks the mode, rendered
  only while served;
- **Rebuild now** is a plain `Button`, shown whenever the composition is served,
  in every mode;
- `ServeStatusNote` gains an arm for "this mode is automatic but
  `autoTriggersHere` is false", and its "intent is off but it is still live" arm
  now points at **delete** as the way to reclaim (Phase 5 landed) instead of
  naming Phase 5 as future work.

`plugins/apps/plugins/studio/plugins/compositions/web/components/compositions-list.tsx`:
the `autoBuild` bool field becomes a `serve` **enum** field (group / filter / sort
for free); the cell keeps a one-click `ToggleChip` for off ↔ `manual` and shows
the mode's label when it is anything else. Its copy still says "compose-serve
stage" / "Auto-serve" — rewrite.
`config/apps/studio/compositions/studio.compositions.jsonc`: `visibleFields`
`"autoBuild"` → `"serve"`.

### 5. Check + docs

- `checks/plugins/composition-closure/check/index.ts` rule 0d:
  `mainRows[0].autoBuild` → `mainRows[0].serve !== "off"`, message updated.
- `plugins/plugin-meta/plugins/composition/CLAUDE.md`, `plugins/build/CLAUDE.md`
  (a new section: the composition arm of the convergence loop and why it is
  main-only), `plugins/build/plugins/serve-composition/CLAUDE.md` (§"Intent is not
  liveness" becomes "the mode is not liveness"; drop the "Phase 5"/"Phase 6"
  forward references).
- Mark Phase 6 **LANDED** in
  `research/2026-08-17-global-composition-build-serve-model.md`, pointing here.

### Out of scope, worth filing

`compositions-list.tsx`'s `serveHost()` composes `asNamespace(it.id)` in web code
— precisely what `serve-composition/CLAUDE.md` §"Pass the item's `id`" says is a
bug: from a worktree the list links at main's namespace. Fixing it needs the
server-resolved namespace per row (N status reads or a batch endpoint), which is
its own change.

## The copy that went stale

The phase brief names the serve panel's "Still live from an earlier build; the
next main build stops serving it". That sentence is **already gone** — Phase 4
replaced it with "The serve intent is off, but {host} is still live from an
earlier build", which is still true (deactivation is deliberately never a reclaim
trigger). What is stale now is the *surrounding* prose: three comments and a
docblock still say reclaiming is future Phase 5 work. Those are item 4 above.

## Verification

1. `./equin build` (background), then `./equin check` — in particular
   `composition-closure`, `config-stable-list-ids`, `data-view:configs-authored`,
   `plugins-doc-in-sync`.
2. `./equin test plugins/build` — the new pure trigger test plus the
   existing `derive.test.ts` / `run-build.test.ts`.
3. In Studio → Compositions → `sonata` → Build & serve: press **Serve**, confirm
   `http://sonata.<worktree>.localhost:9000` comes up and
   `~/.singularity/worktrees/sonata.<worktree>/composition.json` carries a
   `commit`.
4. Set the mode to **On push**, leave the tree alone, and confirm no build is
   minted (the marker's commit equals HEAD). `mcp__singularity__query_db`:
   `select id, targets, trigger, commit_hash, exit_code from build_runs order by started_at desc limit 10`.
5. Commit something, and confirm the reconciler mints **one** run whose `targets`
   is `{sonata}` — after main's own auto-build run, not merged into it.
6. Set the mode to **Hourly** with a fresh marker and confirm the `*/15` tick
   files nothing; check `build.composition-tick` is present and singleton in
   Debug → Queue.
7. Press **Rebuild now** while the mode is **On push** and the tree is converged —
   it must build anyway (the escape hatch is the point).
8. From a worktree backend, confirm the panel says automatic rebuilds do not run
   here and that **Serve** / **Rebuild now** still work.
