# Per-app scoped config (config_v2) — per-app themes as first consumer

## Context

Config in `config_v2` is **global**: each `defineConfig` descriptor maps to exactly one
JSONC document on disk, keyed by a static `storePath = <hierarchy>/<name>.jsonc`. There is
no per-app/per-entity dimension anywhere. The theme system (theme-engine + token groups +
the `.dark` toggle) is consequently global too — one theme for the whole window.

We want **some config to differ per app** (the app-switcher apps: agent-manager, forge,
sonata, debug, deploy, workflows, file-explorer), starting with **per-app themes** (token
groups, global preset, and light/dark mode). Rather than special-casing themes, we add a
generic **scope axis** to config_v2; per-app is its first scope kind. Future scope kinds
(per-user, per-workspace) reuse the same primitive.

### Decided design (settled with the user)

- **Orthogonal axes.** Existing *layer* axis is `default → git → user`. New *scope* axis:
  global = the scope named **base**; per-app = scope `app:<appId>`. Each scope resolves
  **independently** as `user(scope) ?? git(scope) ?? codeDefault` — there is **no
  cross-scope precedence chain**.
- **Lazy snapshot-on-customize fork.** An app with no scope files **reads base live**
  (edit the global theme → all un-customized apps follow). An explicit **"Customize for
  this app"** action **forks**: snapshots base's resolved values into the app's scope
  files, after which the app **diverges** (later base edits do not propagate). Un-forking
  (delete the scope files) reverts the app to tracking base live.
- **Un-forked edits target base.** Changing a theme setting (dark-mode toggle, preset) on
  an app that has not been explicitly customized edits **base/global**. Per-app divergence
  happens *only* through the explicit Customize action. (Forking is also a hard
  prerequisite for any app-scoped write, because the snapshot creates the origin file that
  `setConfig` requires.)
- **Folder layout** — insert an `@app/<appId>/` segment; base files stay exactly where
  they are today (**zero migration**):
  - base git (repo):   `config/<hierarchy>/<name>.jsonc`
  - base user:         `~/.singularity/config/<worktree>/<hierarchy>/<name>.jsonc`
  - app fork git:      `config/<hierarchy>/@app/<appId>/<name>.jsonc`
  - app fork user:     `~/.singularity/config/<worktree>/<hierarchy>/@app/<appId>/<name>.jsonc`
- **Fork granularity.** One "Customize this app" action forks the **whole set** of
  descriptors tagged `scope: "app"` together (all theme token-group descriptors +
  `themeEngineConfig`).

---

## Key validation findings (drive the design)

1. **Resource params are the cache key.** `ResourceParams = Record<string, string>` and the
   live-state subscription/notify key is the sorted-JSON of the params
   (`primitives/plugins/live-state/.../notifications-client.ts`). So passing `scopeId` as a
   **separate resource param** gives per-`(path, scopeId)` caching, subscription, and
   `notify()` targeting for free on both client and server. **Therefore `scopeId` is a
   separate param, not encoded into `path`.** `path` stays = descriptor identity (keeps
   `descriptorByPath` and `storePath`-based endpoints unchanged). Critical: for base scope
   the param must be **omitted entirely** (`scopeId ? {path, scopeId} : {path}`) — setting
   it to `undefined` produces a different JSON key and splits the cache.
2. **The build never generates origins for `@app/<id>` paths.** Origin/propagation
   (`config_v2/plugins/build`) iterate registered contributions at their static
   `_hierarchyPath`. A forked app scope is a runtime-created dir the build never sees.
   Since `setConfig` throws without an origin (`registry.ts:209-218`) and `jsoncConfigProxy`
   throws on a hashless file (`jsonc-proxy.ts:28-33`), **the fork operation itself must
   write both `@app/<id>/<name>.origin.jsonc` and `@app/<id>/<name>.jsonc`** with valid
   `// @hash` headers.
3. **`cacheByDescriptor` 1D→2D is the load-bearing change** (descriptor × scopeId), and it
   intersects with field-storage providers (secret fields) — handled by skipping
   provider-backed fields in the snapshot.

---

## Implementation plan (ordered)

### 1. Core: scope on the descriptor
- `plugins/config_v2/core/internal/types.ts` — add `readonly scope?: "app";` to `ConfigDescriptor`.
- `plugins/config_v2/core/internal/define-config.ts` — accept `scope?: "app"` in opts, thread it through.

### 2. Server: scope path helpers
New `plugins/config_v2/server/internal/scope-paths.ts` (single source of truth for the segment):
```ts
const BASE = "";                                  // canonical base-scope key
export function scopeSegment(scopeId?: string): string {
  if (!scopeId) return "";
  const [kind, ...rest] = scopeId.split(":");
  if (kind !== "app") throw new Error(`Unknown scope kind: ${kind}`);
  return `@app/${rest.join(":")}`;
}
export function userScopedDir(hierarchyPath: string, scopeId?: string): string {
  return join(CONFIG_DIR, hierarchyPath, scopeSegment(scopeId)); // "" is a no-op in join
}
```
Wire format for `scopeId` is `"app:<appId>"` (kind-prefixed, extensible). config_v2 treats it
as an opaque kind tag + path segment — it **never imports apps**.

### 3. Server: 2D cache/registry (`plugins/config_v2/server/internal/registry.ts`)
Restructure the per-descriptor maps to be keyed by scope:
```ts
const cacheByDescriptor      = new WeakMap<ConfigDescriptor, Map<string, CacheEntry>>();
const subscribersByDescriptor = new WeakMap<ConfigDescriptor, Map<string, Set<Cb>>>();
// CacheEntry gains: scopeId; userOriginPath/userOverwritesPath now point under @app/<id> for scoped entries.
```
- `getEntry(descriptor, scopeId="")`, `ensureScopeEntry(descriptor, scopeId)` (builds the
  scoped entry lazily: scoped paths, reload, file watchers, field-provider load loop).
- **`initRegistry` registers only the base entry** per descriptor (as today). Scoped entries
  are created on demand (they don't exist until a fork writes files).
- **`getConfig(descriptor, scopeId="")` — base-live fall-through:**
  ```ts
  if (!scopeId) return getEntry(descriptor, "")!.values;
  const scoped = getEntry(descriptor, scopeId);
  if (scoped?.isForked /* @app/<id> files exist on disk */) return scoped.values;
  return getEntry(descriptor, "")!.values;            // un-forked → base LIVE
  ```
  This makes "un-forked tracks base", "un-fork = delete files = back to base", and "edit
  base after fork doesn't propagate" all automatic.
- `setConfig(descriptor, key, value, scopeId?)` — resolve via `ensureScopeEntry`; existing
  body works unchanged (origin must exist → only callable after fork; base writes unaffected).
- Thread `scopeId` through `setConfigByPath` / `resetConfigByPath` / `acknowledgeConflictByPath`
  / `deleteOverrideByPath` / `getRawFileContent` / `watchConfig`.
- **Notify for base-live reactivity:** keep a module-level `Set<string>` of known app scopeIds
  (added on fork and when a scoped loader runs). On a **base** file change, `notify({path})`
  **and** `notify({path, scopeId})` for each *un-forked* scope in the set, so apps tracking
  base re-render. On a **scoped** file change, `notify({path, scopeId})` only.

### 4. Server/core: resources (`core/internal/resource.ts`, `server/internal/resource.ts`)
- `configV2Resource`, `configV2ServerResource`, `configV2TiersServerResource`: params
  `{ path: string }` → `{ path: string; scopeId?: string }`; loaders take `({path, scopeId})`
  and call `configGetter(descriptor, scopeId)`. `descriptorByPath` is unchanged (path
  identifies the descriptor; scopeId selects the entry).
- Add `getScopedDescriptors(scope: "app"): { descriptor; hierarchyPath; storePath }[]`
  (iterate `descriptorByPath`, filter `descriptor.scope === scope`); export from server index.
- **Known limitation:** `computeAllConflicts` scans only base paths under `CONFIG_DIR` — app
  `@app/<id>` files won't appear in the conflicts resource. Acceptable for v1.

### 5. Server: fork / unfork (new `plugins/config_v2/server/internal/scope-fork.ts`)
```ts
export async function forkScope(scopeId: string): Promise<void> {
  for (const { descriptor, hierarchyPath } of getScopedDescriptors("app")) {
    const resolved = getConfig(descriptor, "");                 // BASE resolved values
    const snapshot = stripProviderFields(resolved, descriptor); // drop secret/provider-backed fields
    const dir = userScopedDir(hierarchyPath, scopeId);
    const hash = computeHash(snapshot);
    jsoncConfigProxy(join(dir, `${descriptor.name}.origin.jsonc`)).write(snapshot, hash);
    jsoncConfigProxy(join(dir, `${descriptor.name}.jsonc`)).write(snapshot, hash);
    ensureScopeEntry(descriptor, scopeId);                      // build entry + watchers; triggers notify
  }
}
export function deleteScope(scopeId: string): void {
  // for each scoped descriptor: unlink <name>.jsonc + <name>.origin.jsonc, dispose watchers,
  // remove inner-map entry; rmdir empty @app/<id>. App reverts to base-live.
}
```
Writing origin+override with the same content/hash satisfies the origin requirement and the
hash invariant, and yields zero conflict at fork time = "snapshot then diverge". Reuses
`jsoncConfigProxy.write` (atomic tmp+rename, mkdir -p) — no new write primitive.

### 6. Endpoints + handlers
- `plugins/config_v2/core/internal/endpoints.ts`: add `scopeId: z.string().optional()` to
  `setConfigField` body; add `forkScope` (`POST /api/config-v2/fork-scope`, body `{scopeId}`)
  and `deleteScope` (`POST /api/config-v2/delete-scope`, body `{scopeId}`).
- `plugins/config_v2/plugins/settings/core/internal/endpoints.ts`: add optional `scopeId` to
  `resetConfigField`, `acknowledgeConflict`, `deleteOverride` bodies and `getConfigRawFile` query.
- `plugins/config_v2/plugins/settings/server/internal/handlers.ts` (+ config_v2 server for
  fork/delete): pass `scopeId` through; `implement(forkScope…)`, `implement(deleteScope…)`.

### 7. Web hooks (`web/internal/use-config.ts`, `use-set-config.ts`)
```ts
export function useConfig<F>(descriptor: ConfigDescriptor<F>, opts?: { scopeId?: string }): ConfigValues<F>
export function useSetConfig<F>(descriptor: ConfigDescriptor<F>, opts?: { scopeId?: string })
```
Build params as `opts?.scopeId ? { path, scopeId: opts.scopeId } : { path }` (omit when
absent). `useSetConfig` includes `scopeId` in the `setConfigField` body when present.

### 8. apps: `useCurrentAppId` (`plugins/apps/web`)
Extract the matching logic currently inline in `apps-layout.tsx` into a shared, exported hook:
```ts
export function useCurrentAppId(): string | undefined {
  const allApps = Apps.App.useContributions();
  const pathname = usePathname();                    // reuse @plugins/primitives/plugins/pane/web
  return [...allApps].sort((a,b)=>b.path.length-a.path.length)
    .find(a => appMatchesPath(a.path, pathname))?.id;
}
```
Refactor `apps-layout.tsx` to consume the shared `usePathname`/`appMatchesPath` (remove the
duplicate copies). Works at `Core.Root` (only needs `Apps.App.useContributions()` +
`window.location.pathname`; does **not** need `PaneBasePathContext`). Consumers map
`appId → "app:" + appId`.

### 9. theme-engine config (`core/config.ts`) + token groups
```ts
export const themeEngineConfig = defineConfig({
  scope: "app",
  fields: {
    globalPreset: dynamicEnumField({ default: "default", label: "Theme" }),
    colorMode: enumField({ default: "system", options: ["light","dark","system"], label: "Color mode" }),
  },
});
```
Add `scope: "app"` to every token-group descriptor: `color-palette`, plus categorical, chart,
shadow, shape, sidebar-palette, typography (`plugins/ui/plugins/tokens/plugins/*/shared/config.ts`).
> Verify the static-enum field factory path under
> `plugins/config_v2/plugins/fields/plugins/enum/core` (else reuse `dynamicEnumField` with
> fixed options). A new `colorMode` base origin is generated by `./equin build`.

### 10. ThemeInjector (`theme-engine/web/components/theme-injector.tsx`)
- `ThemeInjector` calls `useCurrentAppId()` → `scopeId`; `GroupStyle` calls
  `useConfig(group.configDescriptor, { scopeId })`. Switching apps re-resolves all token
  groups to the new app's scope automatically (the pathname store re-renders).
- Add `<ColorModeApplier scopeId={scopeId} />`: reads app-scoped `themeEngineConfig.colorMode`
  and toggles `document.documentElement.classList.toggle("dark", resolved)`, resolving
  `"system"` via `matchMedia("(prefers-color-scheme: dark)")` (+ listener).
- **Single global `.dark` is correct** — only one app is mounted at a time (`AppsLayout`
  renders exactly one `activeApp`), so the active app's colorMode drives the one global class.
  No per-app DOM scoping. The existing global `:root{}`/`.dark{}` style blocks and
  `web-core/.../app.css` `.dark{}` fallback stay valid.

### 11. ThemeToggle (`plugins/theme/web/components/theme-toggle.tsx`)
Rewrite from ephemeral `useState` to config read/write of `themeEngineConfig.colorMode`.
Per the decision, **toggling targets base** unless the current app is already forked:
```ts
const appId = useCurrentAppId();
const forked = useIsScopeForked(appId);                       // see §12
const scopeId = forked && appId ? `app:${appId}` : undefined; // base when un-forked
const { colorMode } = useConfig(themeEngineConfig, { scopeId });
const set = useSetConfig(themeEngineConfig, { scopeId });
// onClick: set("colorMode", next)
```
`use-dark-mode.ts` (syntax-highlight MutationObserver) is unchanged — it still observes the
global `.dark` class.

### 12. theme-customizer (`theme-customizer/web/components/theme-customizer.tsx`)
- `const appId = useCurrentAppId(); const scopeId = appId && \`app:${appId}\`;`
- **Forked-state detection:** add a small `isScopeForked` resource/endpoint keyed by `scopeId`
  (server checks whether any `@app/<id>` file exists). Tiers (`default|git|user`) don't
  cleanly encode "forked vs tracking base", so use a dedicated check.
- **"Customize for this app" toggle:** off→on calls `fetchEndpoint(forkScope, …, {scopeId})`;
  on→off calls `deleteScope`. Disabled when `appId` is undefined.
- **Route edits to the app scope once forked:** thread `scopeId` (only when forked) into every
  `useConfig` preview read and every write. `GlobalPresetPicker.handleChange` adds `scopeId` to
  each fanned-out `setConfigField` body; contributed sections (e.g. color-palette
  `ColorPaletteSection`) do the same via `useSetConfig(desc, { scopeId })`. Before forking,
  `scopeId` is undefined → reads show base values and edits target base.
- The customizer's existing light/dark **preview** override (`originalDark` snapshot/restore,
  `TokenModeSelector`) still works against the global class; keep it local + restore-on-unmount.

### 13. Docs
Update `./equin build`-regenerated docs and the hand-written CLAUDE.md for: config_v2
(scope axis, `@app/` layout, fork/delete), theme-engine, theme, apps (new cross-plugin edges
`theme → apps`, `theme-engine → apps`, `theme → ui/theme-engine/core`). Run
`./equin check --plugin-boundaries` and `--migrations-in-sync`.

---

## Plugin-boundary / cycle check
- `theme → apps` and `theme-engine → apps`: apps imports neither → **no cycle**.
- `theme → ui/theme-engine/core` (for `themeEngineConfig`): theme-engine doesn't import theme
  → **no cycle** (one new edge to record in docs).
- **config_v2 stays apps-agnostic**: it only knows a generic `scopeId: string` + `scope:"app"`
  tag + `@app/` segment. The `appId → "app:<appId>"` mapping lives in consumers
  (theme-engine/theme). **No `useAppConfig` helper inside config_v2** (would force
  config_v2 → apps). Inline `useConfig(d, { scopeId })` at the 3 call sites
  (GroupStyle, ColorModeApplier, ThemeToggle).

## Risks / notes
- **Base-live reactivity** relies on the server notifying `{path, scopeId}` for known un-forked
  scopes on base change (module-level scope `Set`). Confirm push-resource `notify` reaches a
  client subscribed under that exact param key (param-keying evidence strongly suggests yes).
- **Conflicts resource excludes `@app/` files** (v1 limitation; forked snapshots have no
  upstream to conflict with).
- **Field-storage (secret) providers are scope-blind** (`(descriptorName, fieldKey)` only).
  Theme descriptors have no secret fields, so `forkScope` simply **skips provider-backed
  fields** in the snapshot. If a future app-scoped descriptor uses secrets, the provider
  interface needs a `scopeId`.
- **`./equin build` is required** after the config changes to regenerate the new
  `colorMode` base origin (else base `setConfig` for it throws).

---

## Critical files
- `plugins/config_v2/core/internal/types.ts`, `define-config.ts`, `core/internal/resource.ts`, `core/internal/endpoints.ts`
- `plugins/config_v2/server/internal/registry.ts` (2D cache — load-bearing), `server/internal/resource.ts`, `server/internal/scope-paths.ts` (new), `server/internal/scope-fork.ts` (new)
- `plugins/config_v2/web/internal/use-config.ts`, `use-set-config.ts`
- `plugins/config_v2/plugins/settings/core/internal/endpoints.ts`, `server/internal/handlers.ts`
- `plugins/apps/web/components/apps-layout.tsx`, `plugins/apps/web/index.ts` (export `useCurrentAppId`)
- `plugins/ui/plugins/theme-engine/core/config.ts`, `web/components/theme-injector.tsx`
- `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer.tsx`
- `plugins/ui/plugins/tokens/plugins/*/shared/config.ts` (add `scope:"app"`)
- `plugins/theme/web/components/theme-toggle.tsx`

---

## Verification (end-to-end)
1. `./equin build`; open `http://<worktree>.localhost:9000`.
2. **Global still works:** change the global preset / dark mode at `/` (agent-manager) →
   theme changes. Navigate to `/forge`, `/sonata` → they inherit the same (base-live).
3. **Customize an app:** in the theme-customizer while on `/forge`, toggle "Customize for this
   app", pick a different preset + colorMode. Confirm `@app/forge/...jsonc` files appear under
   `~/.singularity/config/<worktree>/...` (inspect via the file tree or shell).
4. **Divergence:** go back to `/` and change the global preset → Forge keeps its own; other
   un-customized apps follow base. Toggle dark at `/` → Forge unaffected.
5. **Un-fork:** toggle "Customize for this app" off on `/forge` → scope files removed; Forge
   tracks base again.
6. **Reactivity:** with two tabs (`/` and `/forge` un-customized), change base in one → the
   other updates without reload (push notify).
7. `./equin check` (plugin-boundaries, migrations-in-sync, eslint) passes.
8. Scripted check with `bun e2e/screenshot.mjs` navigating `/` vs `/forge` after customizing,
   capturing before/after to confirm the visible theme differs per app.
