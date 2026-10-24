# Composition auto-serve: `http://<composition>.localhost:9000/`

## Context

Compositions (named plugin subsets defined in the `compositions` config_v2 config — `sonata`, `website`, `pages`, …) are today only a Studio inspection concept plus a heavyweight `./equin release` input. We want each **activated** composition served live through the existing dev gateway at `http://<composition>.localhost:9000/`, rebuilt automatically as part of the normal main build, so every app-composition is continuously testable as the standalone product it will ship as.

User-fixed requirements:

1. **Frontend via the per-plugin web-artifacts + import-map pipeline** (shared content-addressed store), NOT the monolithic vite build. The monolith is a long-term removal target; this design must make that possible (release migration itself is a follow-up).
2. **Own empty DB per composition** — created empty, full migrations applied on first boot, config defaults seeded. Never a fork of main's data. Cross-app data sharing is out of scope.
3. **Opt-in auto-build**: a new `autoBuild` bool per composition manifest, toggled from the Studio UI. Only activated compositions are composed + served.
4. **Studio → Compositions becomes a DataView** (autoBuild status displays as a column); row activate opens a new **composition detail pane** carrying the toggle.

User-confirmed decisions: reuse main's full vendor set per composition dist (per-composition sets = follow-up); the build stage reads **main's** (`singularity`) config — toggling from a non-main worktree UI is a documented caveat; detail pane is **minimal** in v1 (toggle + serve URL + open-in-Explorer; inline draft editor + Compare stay put); deactivation **keeps the DB** (spec + dist + registries removed, DB drop manual).

## Architecture summary

- **Namespace name = composition id.** Zero gateway (Go) changes: the spec dir name already becomes `SINGULARITY_WORKTREE` for the spawned backend (`gateway/worktree.go:885-888`), and this preserves the recorded "spec is pure identity" decision (`plugins/infra/plugins/worktree/server/internal/spec.ts:48-53`).
- **Backend**: compositions spawn from **main's** `server-core` checkout. Registry selection becomes name-keyed (`server.composition.<name>.generated.ts`) with the existing singleton as fallback, so `build --composition` / release stay untouched.
- **Frontend**: parameterize the web-artifacts planner over an injected *fleet source* (entry list + registry file). A composition dist = filtered import map + symlinks into the same store — near-free after main's fleet build.
- **DB**: `ensureDatabase(<id>)` (empty, race-safe — `plugins/database/plugins/admin/server/internal/databases.ts:37-48`) before the spec write; the backend's normal `onReadyBlocking` migration runner populates the schema on first boot (the release launcher's proven create-empty-then-migrate path, `plugins/infra/plugins/launcher/server/internal/boot.ts:502-549`).
- **Lifecycle home**: everything per-composition lives under `~/.singularity/worktrees/<id>/` — `spec.json`, the composed `web/` dist, and a `composition.json` provenance marker distinguishing composition namespaces from git-worktree namespaces.
- **Hook point**: the stage runs at the end of `./equin build` **only when building from the main checkout**. Main already auto-rebuilds on every push (`plugins/build/server/index.ts:20`: `git.refAdvanced(refs/heads/main)` → debounced `build.run` job), so the push flow is covered with no new trigger.

---

## Phase 1 — Parameterize web-artifacts over a fleet source (L)

All in `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/`:

1. **`plan.ts`**: extract the hardcoded reads (`web.generated.ts` at plan.ts:79, `web-tiers.generated.ts` DEFERRED_PLUGIN_PATHS at plan.ts:81-83) into an injected `FleetSource = { webEntries, deferredPaths, registryFile, registrySlug }` with `defaultFleetSource(root)`; `planFleet({…, source?})` defaults to it. Existing callers (`pipeline.ts`, `expected.ts`) unchanged. Everything downstream of the entry list is already pure.
2. **Filtered web registry file**: reuse `renderCollectedDirRegistry({ctx, def, bundle})` (`plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts:337`) to emit gitignored `web.composition.<name>.generated.ts` beside the committed registry in `plugins/framework/plugins/web-sdk/core/`. `buildRegistryArtifact` (`vite-builder.ts:251`) already accepts an arbitrary registryFile. The `@composition-web-registry` import-map alias stays fixed (it is the seam — same entry artifact, different registry artifact = different composition); the store slug becomes `web-registry-<name>` for readability.
3. **Composition compose**: `runWebArtifactsPipeline({…, source})` (`pipeline.ts:64`) with stages identical. Vendor set: **reuse main's full vendor set** — a composition's targets are a strict subset of the fleet, so its vendor requests are a subset by construction; extra map entries are inert (preload BFS only fetches what's imported). Global CSS artifact reused as-is. Eager seeds = filtered targets minus deferred paths (pure function, `web-sdk/core/load-tiers.ts:28-30`, no codegen change). Compose keeps its hard gates — every-URL-resolves + `scanStagedModules` ground-truth re-lex (`pipeline.ts:283-299`) — which **is** the map-in-sync substitute for composition dists in v1; the standing `web-artifacts:map-in-sync` check stays scoped to main's dist (extending `computeExpectedComposition` over activated compositions is a cheap follow-up since `expected.ts` shares `planFleet`).
4. **Atomic publish helper**: extract build.ts:1444-1468's staging→rename→symlink-swap into `publishDistAtomic({dir, stagingPath})` (cli internal). Composition dists publish gaplessly to `~/.singularity/worktrees/<id>/web`; main's flow is refactored onto the same helper (behavior-identical); per-dir staging-leftover sweep mirrors `sweepStagingLeftovers` (build.ts:151).

## Phase 2 — Per-name server registries + name-keyed selection (S–M)

1. `generateCompositionRegistry` (`plugin-registry-gen.ts:417-438`) gains a `name` option → emits `server.composition.<name>.generated.ts` (server dir only; web is Phase 1's, `prewarm` stays release-singleton). Share one registry-gen context / plugin tree across all compositions per build.
2. `plugins/framework/plugins/server-core/bin/plugins-active.ts` selection chain: per-name file keyed on `SINGULARITY_WORKTREE` → existing singleton `server.composition.generated.ts` (preserves release + `build --composition`) → full `server.generated.ts`. Keep the variable-specifier trick so tsc never resolves gitignored modules.
3. Survival: `clearCompositionRegistries` (build.ts:1017) keeps clearing only the singletons; per-name files are owned exclusively by the Phase 3 stage (rewrites the activated set, deletes deactivated leftovers). `.gitignore` gains the per-name pattern.
4. `build --composition` semantics unchanged; unifying release onto per-name files is a follow-up the fallback chain makes trivial.

## Phase 3 — Auto-build stage in `./equin build` (L)

New `plugins/framework/plugins/cli/bin/commands/internal/compose-serve.ts`, invoked after main's atomic publish + spec write, **gated on running from the main checkout** (same precedent as the central restart at build.ts:1499).

1. **Resolved config read** — fixes the `defaultValue`-only bug-shape (build.ts:1007, release.ts:246 read code defaults, ignoring git + user layers). Export `fileConfigProxy` from `codegen/core` (`config-origin-gen.ts:464`; the CLI already imports that module) and add `readEffectiveConfigFromDisk(descriptor, {worktreeName, singularityDir})` layering git origin + user origin/overwrites via config_v2's existing pure `readTypedConfig` + `effective()` (`plugins/config_v2/core/internal/tier-logic.ts:49,155`) — never reimplement precedence. **Authoritative worktree = `singularity`** (main's UI is where the toggle lives; document the off-main caveat).
2. **Validation + collision guard per activated id**: gateway name regex `^[a-z0-9][a-z0-9-]{0,62}$` (`gateway/registry.go:20`), reserved `{central, singularity, main}`, and: if `~/.singularity/worktrees/<id>/` exists **without** our `composition.json` marker, or a git worktree/branch of that name exists → fail loudly for that composition, never overwrite a foreign namespace.
3. **Per activated composition** (one shared `buildPluginTree`): resolve closure (`flattenManifest` → `resolveComposition`, `plugins/plugin-meta/plugins/closure/core/resolve-composition.ts:62`) → write per-name server + web registries → compose dist (Phase 1) → `ensureDatabase(id)` → `propagateConfigToUser({root, worktreeName: id, singularityDir})` (`config-origin-gen.ts:500`) → write `composition.json` marker → **`writeWorktreeSpec` LAST** (mirrors `bootSelfContainedApp`'s load-bearing ordering — a backend spawned against a missing DB hard-crashes; 3D000 is not retried, `database/server/internal/client.ts:425-430`) → `POST /gateway/worktrees/<id>/restart` (tolerate 404/conn-refused like build.ts:1502-1516) so a running composition backend picks up new code.
4. **Deactivation sweep**: every marker-carrying spec dir whose id is no longer activated → `removeWorktreeSpec` (spec + dist dir together) + delete its per-name registries. **DB is kept** (drop stays manual — e.g. via debug/worktree-cleanup later).
5. **Dev flag** `./equin build --serve-composition <name>` forces one composition through the stage regardless of config — the verification vehicle for Phases 1–3 before Phase 4 lands.
6. **Failure policy**: per-composition failures are collected, printed loudly, and produce a non-zero exit at the end — never silently absorbed, never aborting sibling compositions.

## Phase 4 — Config + Studio UI (M; parallel-safe with 1–3)

1. `autoBuild: boolField({ label: "Auto build & serve", default: false })` in `compositionsConfig` itemFields (`plugins/plugin-meta/plugins/composition/core/config.ts:30`; `boolField` from `@plugins/fields/plugins/bool/plugins/config/core`). `InferFieldsObject` makes it required in the seeds → every seed and the `app()`/`subsystem()`/`pack()` helpers (config.ts:330-375) gain `autoBuild: false`. **Callout**: this bumps the rendered origin `@hash`, so any existing user-layer `compositions.jsonc` goes stale (origin-wins). The machine currently has no user override — a safe one-time cost; land as its own commit. `manifestItemToManifest` (`core/manifest-map.ts`) drops `autoBuild` like `category`/`excludes` (engine never sees it). Note: the name collides conceptually with the build plugin's own `autoBuild` config (main rebuild-on-push toggle) — different configs, distinct labels; keep the field name.
2. **Toggle write**: `setAutoBuild(id, on)` sibling on `useManifestActions` (`plugins/plugin-meta/plugins/composition/web/internal/manifests.ts:33-93`) — a one-line map over items → `setConfig("manifests", …)`. Live-pushes to all readers.
3. **DataView conversion** of `plugins/apps/plugins/studio/plugins/compositions/web/components/compositions-view.tsx`: `defineDataView("studio-compositions")` + hand-authored committed views config at `config/apps/studio/compositions/studio-compositions.jsonc` (explicit stable view row ids — `data-view:configs-authored` + `config-stable-list-ids` checks). Fields: name (primary), category (enum), entry/contributor counts, **autoBuild bool with `onEdit`** (precedent: pages starred field, `plugins/apps/plugins/pages/plugins/starred/web/components/starred-field.tsx:32-49` — `type:"bool"` gets check cell + immediate-commit toggle + yes/no filter for free), serve-URL LinkChip when active. Default view: list grouped by category. Host precedent: `plugins/apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx:124-228`. Row click keeps calling `setActiveComposition` so the Explorer tint flow is intact.
4. **Detail pane** (new, minimal): `Pane.define({ id: "composition-detail", segment: "c/:id" })` in the studio compositions plugin, opened on row activate (push right). Contents: name/category/id header, autoBuild toggle, serve URL chip (`http://<id>.localhost:9000`), "Open in Explorer" action (`setActiveComposition` + `useOpenPane(explorerPane)`). Inline draft editor + Compare mode stay in the list pane; migrating them is a follow-up.

## Phase 5 — Checks / guardrails / docs (S)

- Extend the `composition-closure` check: composition id validated against the gateway regex + reserved names + DB `assertSafeName` charset + ~62-char socket cap; a **warning** when an `autoBuild` composition does not exclude `agent-runtime` (reuses the existing excludes-containment computation) — such closures would run worktree-assuming plugins against main's checkout under a non-worktree name (unvalidated territory).
- `--composition` flag meaning unchanged; help text disambiguates `--composition` (release singleton) vs `--serve-composition` (auto-serve stage).
- Docs: web-artifacts `CLAUDE.md` (fleet source, composition dists), composition `CLAUDE.md` (autoBuild + authoritative-worktree caveat), studio/compositions `CLAUDE.md` (DataView + detail pane), root `CLAUDE.md` Ports section (composition subdomains), gateway `CLAUDE.md` note (composition namespaces are spec-dir-only; no Go changes).

## Phase 6 — Verification (S)

- **bun:test** (pure logic, co-located): `planFleet` with an injected source (filtered map entries, no out-of-closure specifiers); per-name registry rendering; `readEffectiveConfigFromDisk` against fixture jsonc trees (git-only, user-override, stale-override); name validation + collision guard; deactivation set arithmetic.
- **E2E on main**: toggle `sonata` on (or `--serve-composition sonata`) → `./equin build` → verify `http://sonata.localhost:9000` renders via the `e2e/release-boot-verify.mjs` harness pattern (SPA mounted, zero console errors, no /api 502 storm); assert the served import map contains no out-of-closure plugin entries.
- **Empty DB**: `query_db` with `database: "sonata"` — migrations table populated, `tasks` / `mail_threads` at 0 rows.
- **Deactivation**: toggle off → build → spec dir gone, gateway returns unknown-namespace, per-name registries deleted, DB still present.
- **Restart-on-rebuild**: with sonata's backend running, rebuild main → backend restarts, new `.build-id` served.
- **Regression**: plain worktree build clean (`plugins-registry-in-sync`, `map-in-sync`, clean git status); `./equin release --composition sonata --dev` still works end-to-end.

## Sizes

P1: L · P2: S–M · P3: L · P4: M (parallel-ok) · P5: S · P6: S

## Risks

- Compositions whose closure includes worktree-coupled plugins (conversations/tasks/build) run them against main's checkout under a non-worktree namespace — unvalidated; v1 expectation is excludes-clean compositions (sonata is the worked proof), enforced softly by the Phase 5 warning.
- One resident backend + DB per activated composition (idle-reaped after 10 min; darwinbg-demoted; opt-in bounds it). First boot runs the full migration set → slow first request; the gateway's escalating readiness timeout already handles this (same as release boots).
- The CLI config-layering read is the subtlest new code — it must reuse `readTypedConfig`/`effective` verbatim, never reimplement precedence.

## Critical files

- `plugins/framework/plugins/tooling/plugins/web-artifacts/core/internal/{plan.ts,pipeline.ts,compose.ts,expected.ts,vite-builder.ts}`
- `plugins/framework/plugins/tooling/plugins/codegen/core/{plugin-registry-gen.ts,config-origin-gen.ts}`
- `plugins/framework/plugins/cli/bin/commands/build.ts` + new `internal/compose-serve.ts`
- `plugins/framework/plugins/server-core/bin/plugins-active.ts`
- `plugins/infra/plugins/worktree/server/internal/spec.ts` (`writeWorktreeSpec`/`removeWorktreeSpec`)
- `plugins/database/plugins/admin/server/internal/databases.ts` (`ensureDatabase`)
- `plugins/plugin-meta/plugins/composition/core/{config.ts,manifest-map.ts}`, `web/internal/manifests.ts`
- `plugins/apps/plugins/studio/plugins/compositions/web/**` + new `config/apps/studio/compositions/studio-compositions.jsonc`
- `plugins/framework/plugins/tooling/plugins/checks/**` (composition-closure extension)
