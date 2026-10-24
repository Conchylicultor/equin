# One dist per namespace: unify the two composition-dist producers

## Context

`./equin release --composition website` on 2026-08-05 replaced the app served at
`equin.localhost:9000` with the public website, permanently, until main was rebuilt
(`No registered app for id "agent-manager"`). This is not failure-specific — a fully
successful release does the same.

Two checkout-global mutable slots cause it:

1. **The dist.** `buildAndPublishWebDist` hardcodes `livePath = resolve(webDir, "dist")`
   (`app-artifacts.ts:611`) — the exact symlink `~/.singularity/worktrees/singularity.json`
   points the gateway at — and `publishDistAtomic` *reclaims* the previous release
   (`dist-publish.ts:130-132`). Main's bundle isn't shadowed, it's deleted.
2. **The registries.** `build-composition` emits the *singleton*
   `web/server/prewarm.composition.generated.ts` and nothing ever removes them.
   `plugins-active.ts:38` falls back to `server.composition.generated.ts` for **any**
   namespace, so main's *backend* also boots the composition's filtered server plugin set
   on its next restart — dropped tables, jobs and endpoints — until a plain `build` runs
   `clearCompositionRegistries`. This half was not in the original report and is the more
   dangerous one.

Underneath sits a duplication nobody intended. Two paths produce a composition dist:

| | compose-serve | build-composition (release) |
|---|---|---|
| trigger | last stage of **main's** `build`, per `autoBuild: true` (`build.ts:1298`) | `./equin release`, from any checkout |
| consumer | the dev gateway — *deployed* at `<id>.localhost:9000` | the packer — *copied* into a shippable bundle |
| registry | per-name `*.composition.<id>.generated.ts` | singleton `*.composition.generated.ts` |
| frontend | web-artifacts pipeline (content-addressed store) | monolithic rollup, zero cache sharing |
| output | `~/.singularity/worktrees/<id>/web` | the checkout's live `dist` symlink |

They are two *consumers* of one artifact — serve it here vs pack it to ship — and that
difference is real. Everything **upstream** of the dist should never have differed. It does
only because the migration was explicitly deferred:
`research/2026-07-17-global-composition-auto-serve.md:9,41` — *"The monolith is a long-term
removal target; this design must make that possible (release migration itself is a
follow-up)"* and *"unifying release onto per-name files is a follow-up the fallback chain
makes trivial."* This plan is that follow-up.

**Outcome:** no global "this checkout is currently composition X" state exists. Every dist
path derives from identity, so two releases — or a release and main — cannot interfere *by
construction*, not by remembering to clean up. Cache sharing is unaffected because the cache
was never the dist: it is the content-addressed store at `~/.singularity/web-artifacts/`,
already host-global and shared by every producer.

## Target model

The dist is keyed by **purpose**, not by main-vs-composition.

- **Served dist** — the gateway serves it at `<namespace>.localhost:9000`. Keyed by
  namespace. Published atomically (symlink swap) because a live reader exists.
- **Release dist** — scratch, copied into a bundle, served by nobody. Keyed by *(producing
  checkout, composition)*.

| producer | namespace | web dist | server | DB |
|---|---|---|---|---|
| main checkout | `singularity` | `worktrees/singularity/web` | main's `server-core` from source, full registry | `singularity` |
| agent worktree | `<branch>` | `worktrees/<branch>/web` | that checkout's source, full registry | fork of `singularity` |
| auto-served composition | `<id>` | `worktrees/<id>/web` | **main's** source + `server.composition.<id>.generated.ts`, picked at boot from `SINGULARITY_WORKTREE` | empty `<id>` |
| composition release built by worktree `<wt>` | none — nothing is served | `worktrees/<wt>/release-web/<id>` → copied to `<out>/web` | compiled binary; same registry file, bound at *compile* time via the `--compile` alias | created by the launcher |

Everything lives under one root, `~/.singularity/worktrees/<name>/`. The two shapes differ
only in what the **first segment means**: for a served dist it is the *namespace being
served*; for a release dist it is the *worktree that built it*. Those sets are not equal —
every worktree is a namespace, but a composition namespace (`website`) has no worktree of its
own, and a release has no namespace at all. Concretely, with main and one agent both having
released `website`:

```
~/.singularity/worktrees/
  singularity/                 worktree + namespace (main checkout)
    web/                       -> served at equin.localhost:9000
    release-web/
      website/                 scratch: main's build of the website composition
      sonata/                  scratch: main's build of the sonata composition
  att-1785964183-wqzj/         worktree + namespace (one agent)
    web/                       -> served at att-1785964183-wqzj.localhost:9000
    release-web/
      website/                 scratch: THIS agent's build of website
  website/                     namespace only — no worktree, no checkout
    web/                       -> served at website.localhost:9000 (auto-serve)
```

Today **all five of those trees are the same single directory** —
`<checkout>/plugins/framework/plugins/web-core/dist` — which is the bug. After this change
that path ceases to exist and the checkout carries no build output at all.

There is no "server dist": the server runs from source (registry picked at boot) or is a
`bun --compile` binary (registry bound at compile time) — same file, different binding moment.

Collisions, exhaustively: two compositions from one worktree differ in the `<id>` segment;
one composition from two worktrees differs in the `<wt>` segment; release vs auto-serve are
different trees. Same composition released twice from one worktree shares a slot, serialized
by that worktree's `.build.lock`.

### Why a release dist sits under the *building* worktree, not the served namespace

Sharing `worktrees/<id>/web` between auto-serve and release looks tempting (one dist per
composition; a release also refreshes the live preview). Four independent reasons not to,
any one disqualifying:

1. It re-creates this bug one level up: releasing `sonata` from an agent worktree would have
   `publishDistAtomic` reclaim the tree the auto-served `sonata` namespace is being served from.
2. `sweepDistLeftovers` deletes every `<base>.live.*` except the one the symlink names
   (`dist-publish.ts:88-100`) — two checkouts sharing a dir means A's sweep deletes B's
   in-flight release.
3. `.build.lock` is per-checkout by necessity (it guards registry codegen writes *into* the
   checkout), so it cannot serialize two checkouts. Checkout-scoping makes the existing lock
   sufficient by construction — that is the whole argument.
4. `WORKTREES_DIR` is the gateway's registry root; `web.staging.<pid>` siblings there collide
   with compose-serve's `namespaceCollision`/`probeNamespace` ownership guards
   (`compose-serve.ts:196-205`) and land under the gateway's watch.

*This is the one flip-able decision in the plan.*

## Stages

Each stage is independently deployable, green, and revertable.

**Ordering correction (load-bearing):** the monolith is a *prerequisite*, not cleanup.
`resolveFrontendMode` hard-forces `artifactsMode = false` for any composition
(`app-artifacts.ts:284-285`), so today's release ships a Vite monolith; and `viteJob` passes
`VITE_OUT_DIR` as a *basename* with `cwd = webDir` (`app-artifacts.ts:672,677`) which
`vite.config.ts:45` resolves against `__dirname` — a monolith build is **structurally
incapable** of writing outside `web-core`. Relocating any dist is blocked behind removing it.

### S0 — path source of truth (no behavior change)

`plugins/infra/plugins/paths/core/internal/paths.ts`, add to `worktreeArtifacts` (:137-168):

```ts
webDist: (name: string) => join(worktreeDataDir(name), "web"),
releaseWebDist: (worktree: string, composition: string) =>
  join(worktreeDataDir(worktree), "release-web", composition),
```

These are the first **directory** entries in that object — amend its docblock, which
currently asserts every entry is a file with an id-less "most recent" variant. Cleanup is
already covered: `removeWorktreeSpec` `rm -rf`s `worktreeDataDir(id)` (`spec.ts:97-102`).

Repoint `compose-serve.ts:234` (`join(specDir, "web")`) at `worktreeArtifacts.webDist(id)` —
a byte-identical string, but now one producer of the spelling.

### S1 — per-name registries everywhere (fixes cause #2 on its own)

- `plugin-registry-gen.ts:435-439`: collapse `COMPOSITION_RUNTIME_DIRS` and
  `NAMED_COMPOSITION_RUNTIME_DIRS` into **one** set including `prewarm`; make
  `generateCompositionRegistry`'s `name` **required**. `listNamedCompositionRegistries`
  then also lists per-name `prewarm` files, so compose-serve's deactivation sweep
  reclaims them — intended.
- ~~delete `collectedDirCompositionRegistryPath`~~ — **wrong, corrected during
  implementation.** `clearCompositionRegistries` needs the singleton spelling to
  REAP pre-S1 leftovers from developer checkouts, so both survive, marked
  legacy-only and deleted together in S5.
- `web-core/vite.config.ts:90` — **missing from the original plan.** The monolith
  frontend (the mode a release still ships until S2) resolves
  `@composition-web-registry` at the singleton path; it must become
  `web.composition.${VITE_COMPOSITION}.generated.ts` in the SAME commit or a
  release's frontend build breaks.
- `app-artifacts.ts:372-381`: pass `name: composition`.
- `run-prewarm.ts:9-13`: takes a required `composition` param instead of hardcoding the
  singleton path. Its only caller is `release.ts:932`.
- `release.ts:96-99`: `FILTERED_SERVER_REGISTRY` / `FILTERED_WEB_REGISTRY` become functions of
  the composition name. The `bun --compile` `aliasOverride` (`release.ts:776-782`) is already
  an explicit path — it just gets a different one.
- **Keep `clearCompositionRegistries` for now.** It becomes the legacy-singleton reaper: a
  checkout that ran a pre-S1 release still carries a poisoning `server.composition.generated.ts`
  and only a plain `build` removes it.
- Update `plugin-registry-gen.test.ts:77-140`.

*Observable:* a release no longer reconfigures main's backend. `plugins-active.ts:38`'s
singleton branch is dead but retained as the drain path.

### S2 — composition frontend onto the artifacts pipeline, and delete the monolith

The risky stage: releases have never shipped an import-map dist.

- `resolveFrontendMode` **deleted**, along with `--monolith`, `--artifacts`,
  `SINGULARITY_WEB_MONOLITH`, `SINGULARITY_WEB_ARTIFACTS`, `viteJob`,
  `web-core/vite.config.ts`, its `bun run build` script, and the `rollup-plugin-visualizer`
  dep. Also `build.ts:620-627`'s `--serve-composition` artifact-mode preflight and
  `build.ts:1297-1306`'s compose-serve monolith skip, and `map-in-sync`'s
  absence-of-`.web-artifacts.json` branch (`check/index.ts:117,135`).
- **Thread the fleet source — highest-consequence step in the plan.**
  `buildAndPublishWebDist` calls `runWebArtifactsPipeline` with **no `source`**
  (`app-artifacts.ts:630-644`), so it plans from the committed full registry. Flipping to
  artifacts mode without adding
  `source: composition ? await compositionFleetSource({ root, name: composition }) : undefined`
  ships a *green build containing every plugin*. This is why S1 must land first —
  `compositionFleetSource` (`plan.ts:77-90`) requires the per-name file.
- **Do not pass `vendors`.** `readFleetVendorMeta` throws unless the full non-composition
  fleet is already in this host's store (`expected.ts:148-155,169-174`), so it is unusable on
  the hermetic path; `pipeline.ts:184-204` resolves its own set when `vendors` is omitted.
  Comment this — "reuse main's vendor set like compose-serve does" is the obvious wrong
  optimization.
- Add `materialize?: boolean` to `ComposeOptions` / `WebArtifactsPipelineOptions`; at
  `compose.ts:87-92` swap `symlinkSync` for `cpSync(storePath, dest, { recursive: true })`.
  This covers vendor sets too — they ride the same `links` array (`pipeline.ts:274`).
  `build-composition` passes `materialize: true`; `build` and `compose-serve` do not.
  Preferred over `cpSync({dereference:true})` at `release.ts:906` because the release dist is
  written in phase 1 and read in phase 3 with `.build.lock` released in between, where a
  concurrent build's store pruning can dangle the links.
  `scanStagedModules` uses plain `fs` and passes identically either way.

Import-map URLs are root-absolute (`/artifacts/<dir>/index.js`, `plan.ts:129`) and the bundle
serves `<bundleRoot>/web` as its static root, so a materialized copy is relocatable.

**Corrected during implementation (S2, landed):**

- `map-in-sync`'s `cacheSignature` returned the literal `"monolith-dist"` when the marker was
  absent (`check/index.ts:117`). With the absence now a FAILURE, that must become `null`
  (never cache) — the fix for the new failure is a `build`, which changes the dist but not
  the tree hash the runner keys on, so a cached fail would stick after the fix.
- `tsconfig.tools.json:9` is an **exclude**, not an include: `plugins/**/*.config.ts` would
  otherwise claim `vite.config.ts`, which `web-core/tsconfig.node.json` owned. Deleting
  `vite.config.ts` therefore requires deleting `tsconfig.node.json` **outright** (its
  `include` was `["vite.config.ts"]` alone, and an empty include is a tsc error) plus its
  `references` entry in `web-core/tsconfig.json`. That also drops the `web-core-node` tsc
  target `discoverTscTargets` synthesizes from a sibling `tsconfig.node.json`.
- `web-core/package.json`'s `vite` / `@tailwindcss/vite` / `tailwindcss` devDeps were LEFT in
  place (only `rollup-plugin-visualizer` removed, per plan). `@vitejs/plugin-react` is still a
  real dependency there — `core/vite-contributions.ts:13` type-imports it. The other three are
  now plausibly unused (web-artifacts carries its own copies in its own `package.json`, which
  is what its programmatic `import("vite")` resolves through), but removing them is a separate
  verifiable step, not S2's.
- `scanStagedModules`' symlink-transparency was **verified**, not assumed:
  `readdirSync(linkDir, {recursive:true, withFileTypes:true})` resolves the top-level symlink
  and enumerates nested real dirs, and `dirent.parentPath` reports the staged path — so the
  computed `distRel` is byte-identical between a symlinked and a materialized artifacts tree.

**S2 verification evidence (2026-08-06, this worktree):** staged `--dev` website release —
`0` symlinks anywhere in the bundle (3688 entries walked), `150/150` artifact entries are real
directories, import map carries `147` `@plugins/*` specifiers over `114` web entries (vs the
full fleet's `762`), zero hits for `conversations` / `mail` / `tasks` / `workflows` / `deploy` /
`browser` / `story` / `prototypes`. The three `sonata` hits are CORRECT — `website/demos/
app-gallery` genuinely embeds the Sonata keyboard + sampled grand, which is also why the
release pre-warms `splendid-grand-piano`. `release-boot-verify.ts` exit 0 (211 `#root` nodes,
0 console errors, 0 page errors, 0 4xx/5xx).

**Confirmed still broken at S2, as designed:** the release clobbered this worktree's own
`web-core/dist` — after the release, the live `dist` symlink's `.web-artifacts.json` carried
the RELEASE's `buildId` and `linkCount: 150`. S3 is what closes it.

**Accepted loss:** the `VITE_ANALYZE` treemap (`rollup-plugin-visualizer`) has no
artifacts-mode equivalent. Replacement is the real-load accounting already shipped —
Debug → Boot Profile and the `client-boot` trace lane's per-asset rollup
(`debug/trace/client-boot/core/section.ts:70-78`) — plus the eager-tier `modulepreload`
closure (`compose.ts:94-130`), which is what governs eager bytes in artifacts mode.

### S3 — relocate the release dist (fixes cause #1; the bug is closed here)

- `BuildWebDistOptions` keeps `webDir` **only** for `.build.lock` (`app-artifacts.ts:305-309`)
  and gains an identity discriminant:
  `target: { kind: "served"; name } | { kind: "release"; worktree; composition }`.
  `livePath` (`:611`) derives from it. No caller passes a path.
- `build-composition.ts:152,231,240` and `release.ts:757-765` both derive
  `worktreeArtifacts.releaseWebDist(worktree, composition)`.
- **Unify the worktree name.** `build-composition.ts:119` uses `basename(root)`;
  `releaseOutDir` uses `currentWorktreeName()` (`out-dir.ts:47`), which returns `"singularity"`
  in a hand-run CLI because the CLI never sets `SINGULARITY_WORKTREE` for itself. Harmless
  today; after this stage the release would fail to find the dist it just built. Unify on
  `basename(root)`.

**Corrected during implementation (S3, landed):**

- The identity→path mapping is a small **exported** function,
  `webDistPath(target, webDir)`, not an inline expression inside
  `buildAndPublishWebDist`. A caller must sweep its own dist dir
  (`sweepDistLeftovers`) *before* stage 3 creates a staging dir, so the sweep and
  the publish would otherwise be two independent path expressions — the exact
  drift the discriminant exists to remove. Each caller now builds one
  `WebDistTarget` value and resolves it through that function.
- The served arm still returns `resolve(webDir, "dist")`, carrying a `// S4:`
  marker. S3 relocates only the release dist; `build` is byte-identical.
- **`releaseOutDir` is deliberately LEFT on `currentWorktreeName()`** — the plan's
  "unify on `basename(root)`" is wrong for it, and only `build-composition` ⇄
  `release` had to be unified. `releaseOutDir` places the `<out>` **bundle**, and
  its namespace is load-bearingly paired with `bundleRoot`
  (`bundles/server/internal/pointer.ts:8-27`), which `resolveBundle` → `deploy
  ship` reads through the *same* `currentWorktreeName()` call. That pairing is
  documented and was verified against a real cross-build: a hand-run release and a
  hand-run ship both see `releases/singularity/` from any checkout. Switching only
  the writer would make a hand-run release from a worktree invisible to a hand-run
  ship. Switching both would have to switch the whole `deploy` CLI, which is
  intentionally main-scoped in a hand-run process (its DB pool and backend URL are
  `currentWorktreeName()` too, `deploy.ts:179,189`) — a deploy-namespace redesign,
  not this stage. So `<out>` does not move, and no release lands anywhere new.
- The CLI-side identity is now a named function rather than a bare `basename`:
  `checkoutWorktreeName(root)` in `paths/core/internal/paths.ts`, beside
  `currentWorktreeName()` and documenting why the two are not interchangeable
  (env-derived is correct in a backend, always wrong in a CLI process).
  `build-composition` and `release` both call it on the same root — `release`
  spawns `build-composition` with `cwd` at that root — so the dist's producer and
  consumer agree **by construction**. Existing inline `basename(await
  getWorktreeRoot())` sites (`build.ts`, `check.ts`, `db.ts`, `regen-migrations.ts`)
  were left alone; converting them is a mechanical follow-up, not S3.
- Bonus, unplanned: `map-in-sync` (`web-artifacts/check/index.ts:69`) compares the
  *checkout's* dist. Before S3 a release overwrote that dist with a filtered
  composition, so the next standalone `check` failed against a fleet mismatch.
  Now it never sees a release's output at all.

### S4 — relocate the served dist + replace `WEB_DIST_DIR` (must land together)

- `buildAndPublishWebDist`'s served target → `worktreeArtifacts.webDist(name)`;
  `build.ts:878` sweeps the new dir. **No spec change needed** — `build.ts:1305-1312` already
  writes `web: livePath`. (True as far as the *file* goes; the gateway never re-reads it —
  see "S4 IS NOT SAFE TO SHIP".)
- Replace the `WEB_DIST_DIR` const (`paths.ts:20`) with a **function** (the value must not
  freeze at import):

```ts
export function webDistDir(): string {
  return process.env.SINGULARITY_WEB_DIST ?? worktreeArtifacts.webDist(currentWorktreeName());
}
```

  `launch.ts` adds `process.env.SINGULARITY_WEB_DIST ??= join(bundleRoot, "web")` beside the
  existing `SINGULARITY_REPO_CONFIG_DIR ??=` at `:74` — same shape, same
  launch → gateway → backend inheritance.
- Repoint `web-artifacts/check/index.ts:69` to
  `worktreeArtifacts.webDist(checkoutWorktreeName(root))` — **not**
  `currentWorktreeName()`, which in a CLI process answers `singularity` from any worktree,
  so an agent's `map-in-sync` would silently inspect main's dist.
- Legacy reap (below).

**Keep all three `WEB_DIST_DIR` readers; two get strictly better.**
`frontend-hash-resource.ts:15` and `git-status.ts:13` are currently *wrong* for every
auto-served composition (a composition backend runs from main's checkout and reads main's
dist). `get-server-build-id.ts:17` starts working in a release for the first time —
`REPO_ROOT` resolves into the compiled binary's virtual FS today, so crash reports carry a
null build id; `<out>/web/.build-id` is already copied by `release.ts:906`.

Do **not** feed these from `spec.json`: the backend never reads it (only the gateway does),
and that would create a second authority on the frontend-hash path. The env-or-derive form
rides the same `SINGULARITY_WORKTREE` identity the gateway used to spawn the backend.

**Corrected during implementation (S4, landed):**

- `webDistPath` lost its `webDir` parameter entirely — with both arms under
  `worktreeArtifacts`, the identity→path mapping takes no checkout path at all, which is
  the strongest available statement that a dist is not a checkout artifact. `webDir`
  survives only as `BuildWebDistOptions.webDir`, the `.build.lock` home.
- The legacy reap is its own module,
  `cli/bin/commands/internal/legacy-dist-reap.ts` (`reapLegacyCheckoutDist`), called from
  BOTH sweep steps rather than inlined twice. It is a self-contained unit S5 deletes
  outright, and the sibling-name set (`dist.live.*`, …) is derived from `distNames()` so
  it cannot drift from the publisher's own spelling. A missing spec.json (a bare release
  host that never deployed this namespace) closes the gate, like a spec naming the old path.
- `WEB_DIST_DIR` was **removed**, not kept alongside `webDistDir()`: leaving a
  same-meaning const next to the function re-opens the freeze-at-import bug for the next
  reader who reaches for the shorter name. `WEB_CORE_RELATIVE` stays — it is now the
  `.build.lock` / legacy-reap anchor, not a dist ingredient.
- `web-artifacts/check/index.ts` also owed its module docblock a correction: its subject is
  `~/.singularity/worktrees/<name>/web` now, so the "gitignored `web-core/dist`" framing of
  why `scope: "deploy"` is right had become wrong in its premise while right in its verdict
  (the dist is now outside any repo, rather than ignored inside one).
- `reapLegacyCheckoutDist` returns a discriminated `LegacyReapResult`
  (`{kind:"reaped",entries}` / `{kind:"skipped",reason}`), not a bare `string[]`. The two
  ways of removing nothing are different facts and a caller must not conflate them:
  `reaped: []` is "gate open, checkout already clean" (the steady state), `skipped` is "the
  gate refused — the trees are still there". Collapsing the latter into `[]` is the
  absorbable-failure bug class, and `no-absorbed-failure` catches it. The gate also fails
  CLOSED and never throws: an unreadable spec returns `skipped`, because this runs in the
  *sweep* step and aborting the very build that would rewrite the spec is strictly worse
  than leaving the tree one more build.

### S4 IS NOT SAFE TO SHIP — the reap gate rests on a false premise

**Found during S4 verification, 2026-08-07. Read before doing anything else in S4/S5.**

The gate's stated safety argument (Migration, below) is:

> the on-disk `worktrees/<name>/spec.json` already names the new path ⇒ the previous build
> already migrated the namespace ⇒ **no live spec can point at what is being deleted**.

The second implication is **false**. The gateway does not read `spec.json` per request — it
reads its own **in-memory** `*Spec`, and there is **no code path that ever refreshes an
already-registered worktree's spec from disk**:

- `Registry.Watch` (`registry.go:114-174`) watches only the registry *dir*, deliberately not
  each `<name>/` subdir (kqueue budget), so rewriting `worktrees/<name>/spec.json` produces
  **no event the gateway sees**. Its own docblock says as much.
- `Registry.reconcileOnce` (`registry.go:213-219`) — `if r.Get(name) != nil { continue }`,
  "Already registered → skip the stat/load."
- `Registry.Resolve` (`registry.go:62-65`) — returns the registered worktree before touching
  disk. The `/gateway/worktrees/<name>/restart` handler (`proxy.go:348`) goes through
  `Resolve`, so **a build's restart POST does not refresh the spec either**.

So `upsert`'s `wt.UpdateSpec(spec)` branch (`registry.go:338`) is unreachable in practice —
it fires only for a worktree that was fully unregistered (its dir vanished) and re-added.
Once registered, `wt.Spec().Web` is frozen for the gateway process's lifetime.

Two consequences, both observed:

1. **The cutover is not self-healing.** After a namespace's first post-S4 build the gateway
   keeps serving the OLD in-checkout dist. Benign only because that tree still exists.
2. **The reap deletes the tree the gateway is actively serving.** The second build's gate
   reads the (correct) on-disk spec, opens, and removes the legacy tree — which is exactly
   what the stale in-memory spec still points at. Every static path then 404s for that
   namespace until the gateway process restarts. This is precisely the failure the Migration
   section calls "the most likely implementation mistake here", reached by a route the plan
   did not anticipate: not by reaping too early, but because "the on-disk spec" and "the live
   spec" are two different things.

**Evidence (this worktree, 2026-08-07).** Build 1 rewrote `spec.json` to
`~/.singularity/worktrees/att-1785964183-wqzj/web` and reported the gate correctly closed.
Build 2's gate opened and logged `Reclaimed 2 legacy in-checkout dist tree(s)`. Immediately
after, every path 404s (`/`, `/index.html`, `/icon.svg` — all 19-byte `http.NotFound`, i.e.
`handleStatic` reached with a `webDir` that has no `index.html`), while
`GET /gateway/worktrees` reports for this namespace:

```
"web": ".../.claude/worktrees/att-1785964183-wqzj/plugins/framework/plugins/web-core/dist"
```

against an on-disk `spec.json` naming the new path. Recreating a file at the legacy path made
the gateway serve it — the stale path is what it reads. The gateway log shows one
`worktree registered … web=<legacy>` line (2026-08-06) and **no** `worktree spec updated`
line, ever; the gateway process has been up since 2026-07-29.

**`build` cannot see this.** Its readiness probe is `GET /api/health`, a backend path proxied
to the socket — it never exercises `handleStatic`. Build 2 printed `BUILD OK — deployed`
with checks ✓ while every asset 404'd.

**Blast radius.** Every namespace registered before its own first post-S4 build has a stale
spec, i.e. all of them. As landed, S4 404s each namespace on its *second* build.

**Fix direction (not implemented — this is a design decision for the next pass).** The reap
gate cannot be repaired in the reaper: no fact available to a CLI process can describe the
gateway's memory. Options, roughly in order of preference:

1. **Make the gateway re-read a changed spec** — the missing primitive, and the one that also
   fixes consequence 1. Cheapest correct form: in `reconcileOnce`, stat `spec.json` and
   `loadFile` when its mtime/size moved (registered or not), so `UpdateSpec` stops being dead
   code. Then the plan's premise becomes true — with the reap gated on a *reconcile tick
   having passed*, not merely on the file's content.
2. **Ask the gateway, not the disk.** Gate on `GET /gateway/worktrees` reporting `web ===
   worktreeArtifacts.webDist(name)` — the live reader's own answer. Correct without gateway
   changes, but leaves consequence 1 (a namespace serves the stale dist indefinitely) and
   makes a hermetic `build-composition` depend on a running gateway, which it must not.
3. **Do not reap from a build at all.** Move it to an explicit one-shot `./equin`
   maintenance command run after a gateway restart. Sidesteps the race; leaves the disk
   usage until someone runs it.

Until one of these lands, `reapLegacyCheckoutDist` should not run: it is the only part of S4
that destroys anything.

**RESOLVED 2026-08-07 — option 2 landed (and option 1 landed separately in this worktree).**
`reapLegacyCheckoutDist` now gates on `GET http://localhost:9000/gateway/worktrees`, matching
the entry's `web` field against `worktreeArtifacts.webDist(namespace)`. Every other answer —
old path, namespace absent, unreachable, timeout (2s), non-OK, unparseable, missing `web` —
returns `{kind:"skipped", reason}`; the reaper still never throws. The disk `spec.json` read is
gone entirely: there is no second authority left.

Option 1 (the gateway re-reading a changed `spec.json`, via `specRev` + `RefreshSpec` on the
restart POST) is also implemented in this worktree, and the two are complementary rather than
redundant. Option 1 alone would leave a window: a build whose restart POST never lands (backend
crash, gateway 503) leaves disk and gateway memory disagreeing until the next reconcile tick,
and the *next* build's disk-gate would open against a gateway that has not yet adopted the path.
Asking the live reader removes the time-based argument entirely, so the gate is correct
independent of when — or whether — option 1 is deployed. That matters concretely: `./equin
start` builds the gateway from MAIN's Go source, so a gateway fix in a worktree is not live
until it is merged, while the reaper's gate is live the moment the CLI changes.

The `build-composition` hermeticity objection raised against option 2 above does not survive
contact: gateway-unreachable is a *skip*, not a failure, so a bare release host builds exactly
as before, minus a 2s-bounded connection refusal that returns instantly. And a host with no
gateway has no served legacy dist to reclaim, so the skip costs nothing real. Consequence 1
(a namespace serving a stale dist until the gateway adopts the new spec) is left to option 1,
which is where it belongs — it is a gateway-freshness bug, not a reaper bug.

### S5 — cleanup

Delete `clearCompositionRegistries`, `collectedDirCompositionRegistryPath` (its only
remaining caller, plus `pre-barrel-manifests-complete`'s allow-set entry) and
`plugins-active.ts:37-38`'s singleton branch once every active checkout has run one
post-S1 plain `build`. Then `.gitignore:19-24`,
`build-lint-config.ts:286`, and `tooling/core/types.ts:57-61`'s docblock example. Make
`serve-app.ts`'s `--web` **required** — it requires an isolated `SINGULARITY_DIR`
(`serve-app.ts:41-51`), so no derivation crosses data roots correctly; do not invent a default.

**LANDED 2026-08-08.** Preconditions measured across all 87 checkouts (main + 86
worktrees) before touching anything:

- **Stale singleton registries: 0.** No `{web,server,prewarm}.composition.generated.ts`
  exists anywhere, so the reaper had nothing left to drain. Removing the
  `plugins-active.ts` fallback *reduces* risk rather than racing it: with no fallback,
  a future stray file of that name is inert, not poisonous.
- **Checkouts still carrying a legacy `web-core/dist`: 26 of 87** — so the *dist* half of
  the cleanup is not safe yet. See Deferred.

Removed: `clearCompositionRegistries` + `collectedDirCompositionRegistryPath` (definitions,
barrel exports, `app-artifacts.ts`'s `else` branch, `pre-barrel-manifests-complete`'s
allow-set entry — vestigial anyway, since a filtered registry is reached only through the
`@composition-*-registry` bundler alias or a variable specifier, neither of which that
check's static DFS follows), `plugins-active.ts`'s singleton tier (chain is now per-name →
full, docblock rewritten to 2 tiers), and `serve-app.ts`'s hardcoded `--web` default
(now `.requiredOption`).

Two corrections to the plan text made while landing it:

- **`prepareCompositionSources` keeps `composition: string | null`.** The `else` branch is
  gone, but the shape is not now redundant: stage 1 does the same deps + registry codegen
  for both callers, and the explicit `null` makes `build` *state* that it produces no
  filtered registry instead of defaulting into it. What WAS stale is
  `build.ts:1117`'s and `cli/CLAUDE.md`'s "`composition: null` is load-bearing — it makes
  stage 1 run `clearCompositionRegistries`" claim, which named a function that no longer
  exists; both rewritten rather than left asserting a dead mechanism.
- **The selection chain is now a pure, tested function.** `selectRegistry(coreDir, name)`
  moved to `server-core/bin/select-registry.ts`, with `plugins-active.ts` reduced to the
  boot-time application of it. The chain was previously unprovable: importing
  `plugins-active.ts` loads every server plugin as a side effect, so "does a composition
  namespace still get its per-name registry, and an ordinary worktree the full one?" could
  only be argued, never asserted. `select-registry.test.ts` pins both, plus the
  legacy-singleton-present case (must resolve to the FULL registry — the branch S5 deleted)
  and the namespace-unsafe-name throw.

### Deferred — the legacy in-checkout dist (revisit when 0/87 carry one)

**26 of 87 checkouts still hold a `plugins/framework/plugins/web-core/{dist,dist.live.*}`
tree** (measured 2026-08-08). Until that count reaches zero, these three stay:

- `cli/bin/commands/internal/legacy-dist-reap.ts` and its two call sites (`build.ts`,
  `build-composition.ts`) — it is gateway-gated and fails closed, so it is safe where it
  stands and still has 26 checkouts' worth of disk to reclaim.
- `.gitignore:19-24` (`web-core/dist` and the `dist.{live,staging,old,swap}.*` siblings).
- `build-lint-config.ts:286`'s eslint ignore for `web-core/dist/**`.

Removing the ignores now would make those 26 checkouts' `git status` dirty with leftover
build trees. **Condition for revisiting:** every checkout has rebuilt (or been swept) ⇒ the
reaper and both ignores can go together, in one commit.

Kept for the same reason, one level down: `.gitignore`'s `*.composition.generated.ts`
pattern. Nothing writes that spelling any more, but an old checkout building at an old
commit still could, and an ignored stray costs nothing while a `git status` entry does.

## Migration

**~~Self-healing, no action~~ — FALSIFIED, see "S4 IS NOT SAFE TO SHIP" above.** The claim
below was that every live `spec.json` still says `web: <checkout>/…/dist`, is rewritten by
that namespace's next `build`, and that the cutover is gapless because "`handleStatic`
re-reads `wt.Spec().Web` per request (`proxy.go:106-121`) and `spec.json` is replaced by one
atomic rename". `handleStatic` does re-read `wt.Spec()` per request — but that is the
gateway's **in-memory** spec, which nothing ever refreshes from the rewritten file. The
atomic rename is irrelevant because no reader re-reads it. Verified against a live gateway.
The original text follows for context only:

> every live `spec.json` still says `web: <checkout>/…/dist` and is
rewritten by that namespace's next `build`; the old tree stays valid until then.
`handleStatic` re-reads `wt.Spec().Web` per request (`proxy.go:106-121`) and `spec.json` is
replaced by one atomic rename, so the cutover is gapless. Agent worktrees rebuilding at
different times is a non-event — independent namespaces, specs and dists. Crashed publishes
self-heal via `sweepDistLeftovers`.

**Needs an explicit reap** (but see "S4 IS NOT SAFE TO SHIP" — the gate below is unsound as
stated): `<checkout>/plugins/framework/plugins/web-core/{dist,dist.live.*,
dist.staging.*,dist.swap.*,dist.old.*}` — tens of MB to GB per checkout. Put it in the
existing sweep step (`build.ts:878-889`, `build-composition.ts:174-186`), gated on:

> reap the legacy tree **only if** the on-disk `worktrees/<name>/spec.json` already has
> `web === worktreeArtifacts.webDist(name)`.

That means the previous build already migrated the namespace and no live spec can point at
what is being deleted — zero window, no ordering care. Reaping unconditionally at sweep time
would delete the tree the gateway is serving *right now*, for the whole duration of the
build: 404s on every asset for minutes. That is the most likely implementation mistake here.
Keep the `.gitignore` entries until S5 so stale `dist.live.*` trees in developer checkouts
don't dirty `git status`.

## Known gap, named not fixed

`.build.lock` does not span a release. `build-composition` is a child process: it locks,
publishes, exits. Release phases 2 (`bun --compile` reading the filtered registry), 3
(`cpSync`) and 3.5 (`runAssetMirrorPrewarm`) run **unlocked**, so a concurrent
`release --composition Y` in the same checkout rewrites the registries under the first
release's feet. Pre-existing, but S3 makes the dist immune while leaving the registries
exposed, so the asymmetry becomes visible. Fix if cheap: `release.ts` acquires
`acquireArtifactLock(webDir)` around phases 1–3.5 with a re-entrant or `--no-lock`
`build-composition`.

## Critical files

- `plugins/framework/plugins/cli/bin/commands/internal/app-artifacts.ts` — stage 3, `livePath`, mode selection, pipeline call
- `plugins/infra/plugins/paths/core/internal/paths.ts` — `worktreeArtifacts`, `WEB_DIST_DIR` → `webDistDir()`
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` — the two runtime-dir sets, `generateCompositionRegistry`
- `plugins/framework/plugins/cli/bin/commands/{build,build-composition,release}.ts`
- `plugins/framework/plugins/cli/bin/commands/internal/compose-serve.ts`
- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/{compose,pipeline}.ts` — `materialize`
- `plugins/infra/plugins/asset-mirror/server/internal/run-prewarm.ts`
- `plugins/infra/plugins/launcher/bin/launch.ts` — `SINGULARITY_WEB_DIST`
- Reused as-is: `dist-publish.ts` (already generic over a target dir), `worktree/server/internal/spec.ts`

## Verification

Per stage, `./equin build` green from this worktree, then:

**S1** — `./equin release --composition website --dev`, then confirm no
`server.composition.generated.ts` exists and `web.composition.website.generated.ts` does:
`ls plugins/framework/plugins/server-core/core/*.composition*`. Restart main's backend and
confirm the agent-manager app still loads (this is the exact regression: today it boots
website's filtered server set).

**S2** — cut a release and prove the bundle is *filtered* and *self-contained*:
`ls <out>/web/artifacts | wc -l` (real dirs, not symlinks: `find <out>/web -type l | wc -l`
must be 0), and grep the staged `index.html` import map for a plugin outside the website
closure (e.g. `sonata`) — must be absent. Then boot it:
`<out>/launch &` and
`bun plugins/release/e2e/release-boot-verify.ts --url http://localhost:9100/ --settle 15000`
(exit 0 = SPA mounted, zero console errors, no /api 502 storm).

**S3 — the reported bug.** From this worktree, with main deployed: note
`curl -s equin.localhost:9000 | head -c 200`, run
`./equin release --composition website --dev`, then re-fetch. Identical output, and
`equin.localhost:9000` still renders the agent manager. Repeat concurrently for two
compositions and confirm two distinct `worktrees/<wt>/release-web/<id>` trees.

**S4 verification evidence (2026-08-07, worktree `att-1785964183-wqzj`).** Two consecutive
builds, both receipts `status: ok`, checks ✓ (incl. `web-artifacts:map-in-sync`, which
confirms the relocated locator resolves).

- *Relocation.* `spec.json` `web` → `/Users/epot/.singularity/worktrees/att-1785964183-wqzj/web`;
  the checkout carries no build output and `git status` is clean of dist artifacts.
- *Per-namespace reads — proven discriminating.* After build 1 the two trees carried
  DIFFERENT contents: legacy `82f2536df-1786030272496` / index.html md5 `71f7a3a8…`, relocated
  `94a438a8d-1786115681180` / md5 `90b53b7c…`. The backend reported
  `build.frontendHash = {hash:"90b53b7c", buildId:"94a438a8d-1786115681180"}` — the relocated
  tree, i.e. `webDistDir()` resolved by namespace, not by checkout. A checkout-derived reader
  would have answered `82f2536df…`.
- *Auto-served composition, argued from the code path + live artifacts.* The gateway spawns
  every backend with `SINGULARITY_WORKTREE=<spec dir name>` (`worktree.go:674,906`), so a
  `website` backend — whose spec's `server` is MAIN's checkout — has
  `currentWorktreeName() === "website"` and `webDistDir()` →
  `~/.singularity/worktrees/website/web`, exactly the tree compose-serve publishes and the
  gateway serves. Before S4 the const derived from `REPO_ROOT` → main's checkout dist. On this
  host those are demonstrably different bundles: main's `index.html` is 240 270 B / md5
  `4b51100b…`, website's 59 658 B / md5 `fb1da708…`, so the pre-S4 `website` backend reported
  main's frontend hash for a bundle no `website` tab was running. (Their `.build-id` and
  `.build-commit` coincide because compose-serve runs as the last stage of main's build and
  shares its `buildId` — the hash is the discriminating field, not the id.)
- *Reap gate, both edges.* Build 1: gate CLOSED, logged
  `Legacy in-checkout dist left in place: spec still serves <legacy>, not <new>`; legacy trees
  intact. Build 2: gate OPEN, logged `Reclaimed 2 legacy in-checkout dist tree(s)`. Mechanically
  the gate behaves exactly as designed — **and that is what exposed the design flaw above**:
  the namespace 404'd on every static path from that moment.
- *Not verified:* the S2/S3 release regression pass was deliberately not run — a release's
  `build-composition` sweep invokes the same reaper, whose gate is now open for this
  namespace, so it would re-delete the manually restored serving path while the underlying
  defect is unfixed.
- `./equin test plugins/framework/plugins/tooling plugins/build plugins/infra plugins/release`
  → bun:test 872 pass / 0 fail across 85 files; vitest: no jsdom tests under these paths.

**S4 (original plan text)** — after a main build, `cat ~/.singularity/worktrees/singularity/spec.json` shows
`web: ~/.singularity/worktrees/singularity/web`; the app still serves; the checkout has no
`web-core/dist` (`git status` clean). Then verify the per-namespace fix that motivated the
`WEB_DIST_DIR` change: on `website.localhost:9000`, the build-id reported by the backend must
match `worktrees/website/web/.build-id`, not main's.

Full-suite: `./equin check` and
`./equin test plugins/framework/plugins/tooling plugins/framework/plugins/cli`.
