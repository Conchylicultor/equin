# F1 — Composition build-gating (filtered self-contained registry)

> Sub-plan of [`2026-06-19-global-self-contained-app-release.md`](./2026-06-19-global-self-contained-app-release.md) (F1, the keystone).
> Category: `global` (cli, codegen, web-core, server-core, apps).

## Context

Today every build emits **all ~540 plugins** into the committed `web.generated.ts` / `server.generated.ts` registries, so a single app (e.g. Sonata) can't be served self-contained — there is no way to build an app with only its own closure. We want `./equin build --composition sonata` to serve a **Sonata-only** app at `http://<wt>.localhost:9000` with no agent-manager chrome, **testable in the normal dev loop**.

Hard constraint: the committed full registries and a plain `./equin build` must stay **byte-identical** (`plugins-registry-in-sync` green, `git status` clean). So the filtered registry lives **outside the committed tree** (gitignored siblings) and is selected at the **import seam at build/boot time** — never a runtime filter that still bundles everything.

This plan was validated against the actual seams (paths/lines below are confirmed).

## Approach

A single `bundle: Set<PluginId>` (the composition's hard closure) drives two **gitignored filtered registries** emitted beside the committed full ones; each runtime root selects full-vs-filtered at its import seam by its **natural mechanism**:

- **Web** — build-time **vite alias branch** on `VITE_COMPOSITION` (set by `build.ts` when spawning vite). Must be a `resolve.alias` branch, not a runtime `import.meta.env` ternary, or Rollup bundles both registries and ships all plugins (silent failure).
- **Server** — boot-time **file-existence** branch. The server is spawned by the **gateway** (`bun bin/index.ts`), not by `build.ts`, so `build.ts` cannot set its env; and the server is run directly by Bun (no bundler), so a guarded dynamic `import()` only loads the branch taken. The presence of the gitignored `server.composition.generated.ts` (per-worktree, never committed) is the signal. This is the one intentional deviation from the parent doc's "`SINGULARITY_COMPOSITION` env" sketch — env can't reach the gateway-spawned server without a gateway change, which is out of F1 scope. (F3's release launcher spawns the server itself and packages the filtered file, so file-existence works there too.)

Plus a **generic default-app** fix so `/` resolves to the only bundled app.

### 1. Compute the bundle in `build.ts`

`plugins/framework/plugins/cli/bin/commands/build.ts`:
- Add `.option("--composition <name>", ...)` to the option chain (after line 570), thread `composition?: string` into the action opts type (line 571).
- After `regenerateRegistryCodegen` (line 719), if `opts.composition` is set, compute the bundle (reusing existing pure functions, all confirmed exported from their barrels; `build.ts` already imports from `@plugins/plugin-meta/...`):
  ```ts
  import { buildPluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
  import { classifyEdges, resolveComposition, flattenManifest } from "@plugins/plugin-meta/plugins/closure/core";
  import { compositionsConfig, manifestItemToManifest } from "@plugins/plugin-meta/plugins/composition/core";

  const items = compositionsConfig.fields.manifests.defaultValue;
  const item = items.find((m) => m.id === opts.composition); // error if missing
  const all = items.map(manifestItemToManifest);
  const flat = flattenManifest(manifestItemToManifest(item), all);
  const tree = await buildPluginTree(join(root, "plugins"), { skipBarrelImport: true });
  const bundle = resolveComposition(tree, flat).bundle; // Set<PluginId> (dot ids)
  ```
  `buildPluginTree({ skipBarrelImport: true })` is Node/Bun-native (fs-based; static facets only — the closure engine needs only those). `resolveComposition`/`flattenManifest`/`classifyEdges` are pure.
- The `sonata` manifest is **already seeded** (`composition/core/config.ts:85` → `app("sonata","a6","apps.sonata")`, `entryPoints:["apps.sonata"]`). `apps.sonata` is a `collapsed` umbrella; `expandEntrySeeds` pulls in its whole subtree then the hard closure. No new manifest needed.
- Emit filtered registries (see step 2). When `--composition` is **absent**, delete any stale `*.composition.generated.ts` so a plain build reverts the server to full.

### 2. Emit filtered registries (codegen)

`plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts`:
- Add an optional `bundle?: Set<string>` param to `renderCollectedDirRegistry({ root, def, bundle? })`. When set: filter `entries` to `bundle.has(e.id)`, and filter each entry's `dependsOn` to the surviving `pluginPath`s (defensive — deps of a hard closure should already survive). Same export name (`webEntries` / `serverEntries`) so the import is identical. **No behavior change when `bundle` is undefined** → the in-sync check (which calls this without `bundle`) is unaffected.
- Add `collectedDirCompositionRegistryPath(def)` → `<ownerDir>/core/<dir>.composition.generated.ts`, and `generateCompositionRegistry({ root, bundle })` that writes the filtered file for the **web** and **server** defs only (the two runtime registries the app loads; central is dropped per requirements; check/lint are build-time-only). Export both from the codegen barrel.

The committed `<dir>.generated.ts` paths are never touched → `plugins-registry-in-sync` (`checks/plugins/plugins-registry-in-sync/check/index.ts`, byte-compares only the canonical names) stays green and `git status` clean.

### 3. Web import seam

- `plugins/framework/plugins/web-core/web/App.tsx:11` — change the import source only:
  `import { webEntries } from "@composition-web-registry";`
- `plugins/framework/plugins/web-core/vite.config.ts` — add to `resolve.alias` (config fn is already async, reads `process.env`):
  ```ts
  const webSdkCore = path.resolve(__dirname, "../web-sdk/core");
  // in alias object:
  "@composition-web-registry": process.env.VITE_COMPOSITION
    ? path.join(webSdkCore, "web.composition.generated.ts")
    : path.join(webSdkCore, "web.generated.ts"),
  ```
  Default (no `VITE_COMPOSITION`) → full registry → normal build byte-identical.
- `build.ts` vite invocation (line 913) — add `VITE_COMPOSITION` to the env map when set:
  `execBuffered(["bun","run","build"], webDir, { VITE_OUT_DIR: stagingName, VITE_BUILD_ID: buildId, ...(opts.composition ? { VITE_COMPOSITION: opts.composition } : {}) })`.
- `vitest.config.ts` (repo root) — add the same `@composition-web-registry` → `web.generated.ts` alias so any test that pulls in `App.tsx` still resolves (full registry). The existing `plugin-render.test.tsx` imports `webEntries` from the generated file directly and is unaffected.

### 4. Server import seam

- New `plugins/framework/plugins/server-core/bin/plugins-active.ts` (bin-private, boundary-legal — same plugin):
  ```ts
  import { existsSync } from "fs";
  import { join } from "path";
  const filtered = join(import.meta.dir, "../core/server.composition.generated.ts");
  // variable specifier so tsc doesn't resolve a maybe-absent module
  const spec = existsSync(filtered) ? filtered : "../core/server.generated.ts";
  export const { serverEntries } = await import(spec);
  ```
- `plugins/framework/plugins/server-core/bin/index.ts:12` — import from `./plugins-active` instead of `../core/server.generated`. (Bun runs this directly with top-level await already in use; the guarded dynamic import loads only the branch taken — no double-bundling.)

### 5. Generic default-app (the "release root default")

Today `apps-layout.tsx:119` hardcodes `redirectTo("/home")` and `use-tabs.tsx` hardcodes `"home"` (lines 258, 449). In a Sonata-only bundle `home` isn't present → infinite redirect / `No registered app for id "home"` throw. Fix structurally (not a Sonata special-case):

- `plugins/apps/web/slots.ts` (Apps.App props ~22–34) — add optional `default?: boolean`.
- `plugins/apps/plugins/home/plugins/shell/web/index.ts` — set `default: true` on its `Apps.App({...})` (home declares its own defaultness; the apps core never names a contributor).
- `plugins/apps/web/internal/resolve-app.ts` — add `defaultApp(apps): ActiveApp | undefined` → `apps.find(a => a.default) ?? apps[0]`. (`ActiveApp` in `use-active-app.ts` gains `default` automatically from the contribution.)
- `apps-layout.tsx:119` → redirect to `defaultApp(apps)?.path` (apps list available at that root).
- `use-tabs.tsx:258 / :449` → replace `"home"` with `defaultApp(apps)?.id`.

Full build: `home` has `default:true` → unchanged behavior. Sonata-only build: `home` absent → falls to the single bundled app → Sonata at `/`.

### 6. gitignore

Add `*.composition.generated.ts` to `.gitignore`.

## Critical files

- `plugins/framework/plugins/cli/bin/commands/build.ts` — `--composition` option (≈570), bundle compute + filtered emit / stale-cleanup after `regenerateRegistryCodegen` (719), `VITE_COMPOSITION` env on vite (913)
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` — `bundle?` filter in `renderCollectedDirRegistry` (238), `collectedDirCompositionRegistryPath` + `generateCompositionRegistry` (+ barrel export in `codegen/core/index.ts`)
- `plugins/framework/plugins/web-core/web/App.tsx:11`, `plugins/framework/plugins/web-core/vite.config.ts` (alias 82–86), repo-root `vitest.config.ts`
- `plugins/framework/plugins/server-core/bin/index.ts:12` + new `bin/plugins-active.ts`
- `plugins/apps/web/slots.ts`, `plugins/apps/web/internal/resolve-app.ts`, `plugins/apps/web/components/apps-layout.tsx:119`, `plugins/apps/web/internal/use-tabs.tsx:258,449`, `plugins/apps/plugins/home/plugins/shell/web/index.ts`
- `.gitignore`

## Verification (dev loop)

1. `./equin build --composition sonata` — succeeds.
2. Open `http://<wt>.localhost:9000` (scripted Playwright, `e2e/screenshot.mjs`): only Sonata renders, no agent-manager rail/chrome; `/` (bare) lands on Sonata; check browser console (`~/.singularity/worktrees/<wt>/logs/*.jsonl`) for no plugin-load errors.
3. Confirm filtering: served `webEntries`/`serverEntries` equal `bundle` — inspect the emitted `web.composition.generated.ts` / `server.composition.generated.ts` entry count vs `resolveComposition(...).bundle.size` (web/server-bearing subset).
4. Regression: `./equin build` (no flag) then `./equin check plugins-registry-in-sync` → green; `git status` → clean (the `*.composition.generated.ts` are gitignored and cleaned); full agent-manager app loads normally with `/` → `/home`.
5. `bun run test:dom plugins/framework/plugins/web-core/web/__tests__/plugin-render.test.tsx` → still passes.
