# config_v2 in the browser server: the committed git layer in a demo scope

Track: "Demos and client server" (wiki `block-3e397e42-8412-4895-b854-e620a1b4f789`).
Parents: `research/2026-10-15-global-app-embed-and-agent-manager-demo.md` (As landed → Config gap),
`research/2026-10-13-global-in-app-demo-scope-v2.md` ("config comes from the demo backend, never read
through from the host").

## Context

Inside a `<DemoScope>`, `config_v2/web`'s `useConfigDemoServe` (`web/internal/demo-resource.ts`)
answers `config-v2.values` with each web-registered descriptor's code `defaults` and
`config-v2.scopes` with `path → []`. So anything the committed config layer arranges renders as if
unconfigured. Example: the Agent Manager demo sidebar shows "No views configured", because its views
live in `config/conversations/conversations-view/data-view/conversations-sidebar.jsonc`.

Nothing ships `config/` to the browser today. Config reaches the page only at runtime, over the
socket from the host server. The end-state website composition must not read it through the host.

**Goal:** inside a demo scope, serve the committed git layer, resolved exactly as the server would
for a fresh user with no user overrides:

- the base document: `override ⊕ origin`, where a stale override loses to its origin;
- each `@app/<id>` scope: base ⊕ scoped delta.

The data ships *in the bundle*, so a demo never asks the host for config.

## Design

### 1. One pure git-layer resolver (config_v2/core)

The git-layer rule is spelled out today only inside codegen's `propagateConfigToUser`
(`plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts:673+`):

- `effective(gitOrigin, gitOverwrites)`;
- then `{ ...baseEff, ...scopedDelta }` for each `@app/<id>`.

Extract it into `config_v2/core/internal/git-layer.ts`:

```ts
/** One descriptor's committed config, resolved: what a fresh user's origin layer holds. */
export interface GitLayerDocument { base: JsonValue; scopes: Record<string /*appId*/, JsonValue> }
export function resolveGitLayer(
  origin: ConfigProxy, override: ConfigProxy, scopedDeltas: ReadonlyMap<string, ConfigProxy>,
): GitLayerDocument | undefined   // undefined ⇔ no origin and no override (today's `continue`)
```

`propagateConfigToUser` then calls it and keeps only the sink writes, conflict warnings and the
stale-scope reconcile. The build-time bundle (§2) calls the same function, so the two cannot
diverge.

### 2. Build emits the resolved layer into config_v2's web artifact

There is a new generator, `config-git-layer-gen.ts`, in `tooling/plugins/codegen/core`:

- **What it reads.** It is a pure file walk: it reuses `walkJsoncFiles` and imports no descriptors
  and no barrels. For every `config/<hier>/<name>.origin.jsonc` it reads that file, its sibling
  `<name>.jsonc`, and the `@app/*/<name>.jsonc` files, then calls `resolveGitLayer`.
- **What it emits.** Only documents the committed layer actually arranges: those with an honored
  authored override or at least one `@app` scope. A path with only an origin equals its code
  defaults, because the origin is generated from the defaults in the same build. The browser
  backfills defaults through the descriptor's schema, so it would recompute the same value. The
  output is keyed by storePath (`<hier>/<name>.jsonc`), the same key the server registry and
  `storePathOf` use.
> **Superseded (per composition):** the layer is now one file per composition, served from the
> composition's registry artifact, not config_v2's. See
> `research/2026-10-16-global-config-git-layer-per-composition.md`.

- **Where it writes.** `plugins/config_v2/web/internal/git-layer.generated.ts`, as
  `export const gitLayer: Record<string, GitLayerDocument> = …`. The file is **gitignored**, like the
  per-composition registries. Committing it would make every config edit a second, conflicting
  generated diff.
- **When it runs.** As the last step of `generateAppSources` (stage 2 in
  `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts`), after
  `seedAuthoredOverrides`. That is the same point `propagateConfigToUser` reads from, so `build` and
  `release` (`--hermetic`) both produce it before the web build in stage 3.
- **Cache key.** The web-artifacts own-file hash walks the disk, not `git ls-files`
  (`web-artifacts/core/internal/own-files.ts`). So the generated file is inside config_v2's hashed
  `web/` root, and a config edit rebuilds exactly the config_v2 web artifact.
- **Size.** About 270 KB of raw authored overrides, less once minified.
- **Lazy loading.** The file is reached only through a dynamic `import("./git-layer.generated")`
  inside the demo serve's loaders. Vite splits it into its own chunk, which the main app never
  fetches.
- **Fresh clone (as landed).** Before the first build, the file is missing, so a bare `check` (`tsc`) fails
  to resolve the import. Every build (and `release --hermetic`) writes it in stage 2, before its checks.
  The install-time `provision/` route was dropped: no plugin uses that registry yet.

### 3. The demo serve answers the git layer (`config_v2/web/internal/demo-resource.ts`)

`useConfigDemoServe` keeps its shape: the descriptors are read from `ConfigV2.WebRegister`, and
both values are `"notified"`. The loaders become async and import the git layer once:

- **`config-v2.scopes`:** every registered storePath → `(gitLayer[path]?.scopes keys).map(appScopeId)`.
- **`config-v2.values` `{ path }`:** `readTypedConfig(descriptor, readonlyProxy(gitLayer[path]?.base ?? defaults), absentProxy)`.
  This is the server's tier cascade: schema parse with default backfill, and an invalid document
  falls back to defaults with a warning.
- **`config-v2.values` `{ path, scopeId }`:** the same, over `scopes[appId]`. A scope not in the map
  still throws. `useConfig` never asks for one, because it is gated on the scopes map.
- An unregistered path still throws.

`readonlyProxy` / an absent proxy become small exported helpers in `config_v2/core`, moved from
codegen if they are pure. The pack can still shadow any tuple: the existing precedence (pack over
contribution) is unchanged.

Redaction: the git layer never stores secrets. Storage-provider fields keep their default in
committed files, and those files are already in the repository, so nothing is redacted in the
browser. This is stated in the CLAUDE.md.

### 4. Writes: a user layer of `ConfigProxy`s, in memory per demo scope

**Why something specific is needed.** The track's later step ("real server in a worker on PGlite;
writes work for free") gets its writes from the database. config_v2 does not store in the database:
its server reads and writes `.jsonc` files through `jsoncConfigProxy`. So config writes will not come
for free. Its seam is `ConfigProxy` (`read` / `write` / `exists`), which the whole tier cascade
(`effective`, `readTypedConfig`, `propagate`) is written against. This step builds the browser
layers on that seam:

- **Git layer:** a read-only proxy over the bundled document (§2–3).
- **User layer:** `createMemoryConfigStore()` in `config_v2/core`. Its `proxy(path, scopeId?)` returns
  a writable `ConfigProxy` per `{path, scopeId}`, held in a `Map`. A client-only build later swaps in a
  persistent store with the same interface (IndexedDB / OPFS). The demo uses memory, so a reload or a
  remount returns to the committed state and captures stay deterministic.

The demo values loader becomes `readTypedConfig(descriptor, gitProxy, store.proxy(path, scopeId))`,
the server's exact cascade.

**`POST /api/config-v2/set-field` in the demo** mirrors the server's `setConfig`:

1. Resolve the current document.
2. Check the value with `descriptor.schema`. A failure returns a 400, never a silent store.
3. Write `{ ...current, [key]: value }` with the git document's hash.
4. A scoped write to a scope with no document of its own takes the base document as that scope's git
   document (fork-on-write), then notifies the scopes map.
5. `values.notify({ path, scopeId })`.

**Per-scope routes (demo contract change).** `Demo.Route` contributions are static, one handler shared
by every scope, so they cannot reach a store owned by one scope. `Demo.Resource.useServe` already runs
once per scope mount, so it returns the plugin's whole demo backend for that scope: the serve function
plus optional `routes`. `<DemoScope>` merges these routes with the `Demo.Route` ones; a key claimed
twice throws. `demoResource(id, serve)` keeps its signature. `Demo.Route` stays for stateless
handlers.

The other config endpoints (`reset-field`, fork / delete / remove / merge scope,
acknowledge-conflict, delete-override) are settings-app only and are still refused.

### Not in scope

`conflicts`, `tiers`, `raw-file`, `conflict-locations` and `modified-counts` stay unserved. They are
settings-app surfaces, and a demo reading them still fails loudly. Demo config is not persisted across
reloads.

## Files

- **New:**
  - `config_v2/core/internal/git-layer.ts` (+`git-layer.test.ts`)
  - `tooling/plugins/codegen/core/config-git-layer-gen.ts` (+test, on a temp `config/` tree)
  - a `.gitignore` entry
- **Edited:**
  - `config-origin-gen.ts` (`propagateConfigToUser` uses `resolveGitLayer`)
  - `app-artifacts.ts` (stage 2 step)
  - `config_v2/core/index.ts`
  - `config_v2/web/internal/demo-resource.ts` (+jsdom test)
  - `config_v2/CLAUDE.md` (the demo section)
  - `browser-server/plugins/demo/CLAUDE.md` (config line)
  - the parent doc's "Config gap" note

## Verification

- `./singularity test plugins/config_v2 plugins/framework/plugins/tooling/plugins/codegen plugins/framework/plugins/browser-server`:
  - `resolveGitLayer`:
    - an honored override wins;
    - a stale-hash override loses to its origin;
    - `@app` = base ⊕ delta;
    - neither file → undefined.
  - Generator: emits only authored or scoped paths, keyed by storePath.
  - Demo serve (jsdom, real `createBrowserServer`):
    - a registered path with a git entry → the override values;
    - a path without one → defaults;
    - the scopes map lists `app:<id>`;
    - a scoped read → the merged document;
    - an unregistered path throws.
  - Existing `propagateConfigToUser` behaviour is unchanged (existing tests).
- `./singularity build`, then a screenshot of `/demo`: the Agent Manager sidebar shows its committed
  views (Queue, Models, …) instead of "No views configured", in the agent-manager app theme.
- Writes:
  - jsdom: `useSetConfig` inside a `DemoScope` flips the value live.
  - A scoped write forks: the scopes map gains `app:<id>`.
  - A remount returns to the git value.
  - An invalid value gets a 400 and nothing is stored.
  - Two `Demo.Resource`s claiming one route throw.
  - Manually in `/demo`: toggle a sidebar view option. It applies, no toast appears, and nothing
    reaches the host.
- Leak check: in the network panel, no `config-v2.*` frame reaches the host from inside the demo
  scope. Config is served by the browser server, and the chunk is a static asset.
- Afterwards: update the track card (check the Config task off, rewrite the Gaps paragraph) and file
  the next main task (click-triggered write migration).
