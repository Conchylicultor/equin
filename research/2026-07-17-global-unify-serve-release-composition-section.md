# Unify "Auto build & serve" + "Release" into one target-driven section, and make Serve trigger an initial build

Date: 2026-07-17
Category: global (apps/studio + release + build + plugin-meta)

## Context

The Studio composition detail pane (`/studio/compositions/comp/:id`) currently has
**two separate sections** for "how do I get this composition running/shipped":

- **Auto build & serve** (`.../compositions/plugins/auto-serve`) — a `ToggleChip`
  flipping the per-composition `autoBuild` config flag. When on, *every main build*
  composes the composition into its own gateway namespace served live at
  `http://<id>.localhost:9000`. Available for **all** categories.
- **Release** (`.../compositions/plugins/release`) — a target picker (`Web` /
  `Desktop`) + **Run release** producing a one-shot, versioned artifact. **App-only.**

Two problems the user raised (via the element-picker on the Serve toggle):

1. **The two sections should be united.** They answer the same question — "ship /
   run this composition" — as peer *targets*. Decision (confirmed with user):
   fold live-serve into the target model so one picker reads **Serve live · Web ·
   Desktop** ("one composition ships N ways").
2. **Toggling "Serve" on does nothing visible until the next main build.** The flag
   is pure intent; nothing is served until someone runs `./equin build` on
   main. Decision (confirmed): enabling Serve should **also trigger an immediate
   forced build** (`--serve-composition <id>`), with a toast.

Outcome: one "Build & serve" section with a 3-way target picker; selecting **Serve
live** shows the live-serve toggle + URL and *enabling it kicks a build*; selecting
**Web/Desktop** shows the existing Run-release flow. The list-view Serve toggle
gets the same build-on-enable behavior.

## Key constraints discovered (these shape the design)

- **`RELEASE_TARGETS` (`plugins/release/core/targets.ts`) is NOT the place for
  "serve".** That closed list drives the real release `buildArgs` *and* the server
  validator (`handle-release.ts` rejects unknown targets). "Serve live" is a
  **UI-level peer chip**, routed to a different action — it must not enter this list.
- **`--serve-composition <id>` runs a FULL main build that restarts the main
  backend** (`build.ts`: preflight :772 → `runComposeServeStage` :1493 → backend
  restart :1536). It forces just that one composition through compose-serve
  regardless of its `autoBuild` flag and **skips the deactivation sweep**. Hard
  preflights: **artifact mode** (default) and **main checkout only**.
- Because the serve build restarts its own spawner, it needs build's
  **durable detached-spawn + pid-swap + orphan-reconcile** machinery. The clean
  seam is to **extend `triggerBuild`** (not a new fire-and-forget runner): the
  serve build then reuses `_buildRuns` durability, the `build` log channel, the
  in-flight lock (correctly serializing with normal builds — both restart main),
  and Build-app history + completion notification, for free.
- **The list-view Serve cell is independent of the detail section** — it calls
  `setAutoBuild` directly (`compositions-list.tsx`). Unifying the detail section
  does not break it; we update it separately to share the new build-on-enable path.

## Design

### Plugin structure (respects layering; DAG verified)

`auto-serve` is **repurposed from "a detail section" into "the serve capability"**:
a library plugin that owns the serve toggle UI + the enable→build hook, consumed by
both the unified release section and the list. It legitimately depends on both
`plugin-meta/composition` (the `autoBuild` flag) and `build/core` (the new
endpoint) — the correct home for a hook that couples the two.

- `auto-serve` → imports `plugin-meta/composition`, `build/core`, `shell/toast`,
  css primitives. Exports `ServeTargetPanel`, `useServeComposition`. **No** import
  of `compositions`/`release`. **Drops** its `CompositionDetail.Section` contribution.
- `release` → `compositions` (CompositionDetail), `release/core`, **+ `auto-serve`**.
- `compositions` (list) → **+ `auto-serve`**.
- Edges: `compositions→auto-serve`, `release→auto-serve`, `release→compositions`,
  `auto-serve→{composition,build}`. No back-edges (build imports none of these). **DAG holds.**

### Server — build plugin

1. **`plugins/build/core/endpoints.ts`** — add:
   ```ts
   export const serveCompositionEndpoint = defineEndpoint({
     route: "POST /api/build/serve",
     body: z.object({ composition: z.string() }),
   });
   ```
2. **`plugins/build/server/internal/run-build.ts`** — extend the runner (reuse all
   durability; only the argv changes):
   ```ts
   export function triggerBuild(
     trigger: "manual" | "auto",
     opts?: { serveComposition?: string },
   ): void { /* pass opts through to doRunBuild */ }

   // inside doRunBuild, replacing the fixed argv:
   const args = ["./equin", "build", "--allow-main"];
   if (opts?.serveComposition) args.push("--serve-composition", opts.serveComposition);
   const proc = Bun.spawn(args, { cwd: REPO_ROOT, /* …unchanged… */ });
   ```
   Keep `_buildRuns.trigger = trigger` (no schema change; `"manual"` for serve
   builds). Everything else (pid swap, reconcile, streaming, notifications) is unchanged.
3. **`plugins/build/server/internal/handle-serve-composition.ts`** (new), mirroring
   `handle-release.ts`:
   ```ts
   export const handleServeComposition = implement(serveCompositionEndpoint, ({ body }) => {
     if (!isMain()) {
       throw new HttpError(400,
         "Serve builds run on the main instance only — open equin.localhost:9000.");
     }
     triggerBuild("manual", { serveComposition: body.composition });
   });
   ```
   (`isMain` and `HttpError` are both already used by this plugin family.)
4. **`plugins/build/server/index.ts`** — register
   `[serveCompositionEndpoint.route]: handleServeComposition`.

### Web — serve capability (`auto-serve` repurposed)

5. **`auto-serve/web/internal/use-serve-composition.ts`** (new):
   ```ts
   export function useServeComposition() {
     const { setAutoBuild } = useManifestActions();
     const build = useEndpointMutation(serveCompositionEndpoint);
     const serve = (id: string) => {
       setAutoBuild(id, true);                         // persist intent
       build.mutate({ body: { composition: id } });    // kick the immediate build
       showToast({
         title: `Building & serving “${id}”…`,
         description: "Running a main build; the live URL will be ready shortly.",
         variant: "info",
       });
     };
     const stop = (id: string) => setAutoBuild(id, false); // off = flag only (swept next build)
     return { serve, stop };
   }
   ```
6. **`auto-serve/web/components/serve-target-panel.tsx`** (new; the old
   `auto-serve-section.tsx` body + enable→build): the `Serve/Serving` `ToggleChip`,
   the live-URL `LinkChip` (shown when `autoBuild`), and the caption. Enable →
   `serve(id)`; disable → `stop(id)`.
7. **`auto-serve/web/index.ts`** — remove the `CompositionDetail.Section`
   contribution; export `ServeTargetPanel` + `useServeComposition`. Delete
   `auto-serve-section.tsx`. Update `CLAUDE.md` to the new "serve capability" role.

### Web — unified section (`release`)

8. **`release/web/components/release-section.tsx`** — becomes the unified body:
   - Picker options `[{ id: "serve", label: "Serve live", icon: MdBolt }, ...RELEASE_TARGETS]`
     (the serve chip is prepended; the rest map as today). Default selected target: `"serve"`.
   - Body branches on selection:
     - `serve` → `<ServeTargetPanel item={item} />` (from `auto-serve`), for **all** categories.
     - `web`/`tauri` → the existing **Run release** button + app-only gate/caption.
9. **`release/web/index.ts`** — keep section **id `"release"`** (config key stays
   `apps.studio.compositions.release:release` — no config churn), change **label to
   `"Build & serve"`**. `release-history` section unchanged (serve builds appear in
   the Build app, not here — they don't create `release_runs` rows).

### Web — list mirror + config

10. **`compositions-list.tsx`** — the Serve cell uses `useServeComposition()` so
    clicking Serve in the list also triggers the build + toast (consistent with the
    detail). Replaces the direct `onToggleAutoBuild`/`setAutoBuild` call.
11. **`config/apps/studio/compositions/composition-detail.section.jsonc`** — remove
    the `"apps.studio.compositions.auto-serve:auto-serve"` line (the `.origin.jsonc`
    regenerates on build; `config-origins-in-sync` would otherwise flag the orphan).

## Critical files

- `plugins/build/core/endpoints.ts` — new endpoint
- `plugins/build/server/internal/run-build.ts` — extend `triggerBuild`/`doRunBuild`
- `plugins/build/server/internal/handle-serve-composition.ts` — new handler
- `plugins/build/server/index.ts` — route wiring
- `plugins/apps/plugins/studio/plugins/compositions/plugins/auto-serve/web/{index.ts,internal/use-serve-composition.ts,components/serve-target-panel.tsx}` — repurpose
- `plugins/apps/plugins/studio/plugins/compositions/plugins/release/web/{index.ts,components/release-section.tsx}` — unified section
- `plugins/apps/plugins/studio/plugins/compositions/web/components/compositions-list.tsx` — list toggle
- `config/apps/studio/compositions/composition-detail.section.jsonc` — drop auto-serve line

## Reused (do not re-implement)

- `triggerBuild` durability (pid swap, `reconcileOrphanBuilds`, `build_runs_inflight_uniq`) — `run-build.ts`
- `setAutoBuild` / `useManifestItems` / `useManifestActions` — `plugin-meta/composition/web`
- `useEndpointMutation` (auto-toasts errors) + `implement` + `HttpError` — `infra/endpoints`
- `showToast` — `shell/toast/web`
- `RELEASE_TARGETS` / `triggerReleaseEndpoint` (web/tauri path, untouched) — `release/core`
- `isMain` — `infra/paths/server`

## Non-goals / deliberate simplifications

- **Off doesn't tear down immediately** — turning Serve off flips `autoBuild=false`;
  the namespace is swept on the next *full* main build (matches today's semantics;
  DB kept). No new teardown endpoint.
- **Enabling always builds** (not conditional on "already served"). We interpret
  item #2 as "enabling Serve kicks a fresh forced build." The UI's `autoBuild`
  state still reflects *intent*, not confirmed live-state; a served-state resource
  (reading compose-serve markers under `~/.singularity/worktrees/<id>`) that would
  make "Serving" mean "actually live" is a **follow-up**, noted below.
- **Serve builds show as `trigger:"manual"`** in Build history (no `_buildRuns`
  schema change). A dedicated `"serve"` trigger label is a trivial future nicety.
- **No 409 on concurrent build** — if a build is already in flight the serve click
  no-ops server-side but still toasts. Acceptable for v1.

## Follow-ups (out of scope; file as tasks if wanted)

- Served-state resource (marker-dir file-watcher) so "Serving" reflects reality and
  the build fires only when not already live — also fixes today's "says Serving but
  the URL is dead" gap.
- Distinct `"serve"` build trigger + label in Build history.

## Verification

1. `./equin build` to deploy.
2. Boundary + config checks:
   ```bash
   ./equin check plugin-boundaries
   ./equin check            # config-origins-in-sync, plugins-doc-in-sync, type-check
   ```
3. UI, at `http://<worktree>.localhost:9000/studio/compositions/comp/<id>`:
   - The detail pane shows **one** "Build & serve" section (auto-serve section gone),
     picker = **Serve live · Web · Desktop**, default **Serve live**.
   - Selecting **Web/Desktop** shows Run release (app-only gate intact).
   Scripted (captures + reports the button state):
   ```bash
   bun e2e/screenshot.mjs \
     --url http://<worktree>.localhost:9000/studio/compositions/comp/<id> \
     --click "Serve live" --out /tmp/serve
   ```
4. Build-on-enable (run on **main**, `equin.localhost:9000`, since
   `--serve-composition` is main-only): toggle **Serve** on for a small composition
   → expect the info toast, a new row in the Build app history, and (after the build)
   the app live at `http://<id>.localhost:9000`. Confirm a **non-main** worktree
   returns the 400 "main instance only" toast.
5. `bun test plugins/framework/plugins/cli/bin/commands/internal/compose-serve.test.ts`
   (unaffected, but confirms the forced-serve path still parses/serves).
</content>
</invoke>
