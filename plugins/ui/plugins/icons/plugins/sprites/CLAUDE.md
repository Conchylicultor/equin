# sprites

Serves and mounts the icon sprites the icons primitive draws from. The design
is in the parent's [`CLAUDE.md`](../../CLAUDE.md) (section "Sprites").

## The first paint's sprites never ride the boot snapshot

They were most of it (~280 KB resident sprites + up to ~200 KB saved-icon
symbols, re-sent on every load because the snapshot is not cacheable). Now:

- **Two assets** (`server/`, portable — every host draws through its drawer):
  `GET /api/icons/sprite-assets/:hash/:key` (`getSpriteAsset`: one sprite,
  `image/svg+xml`, under the drawer's `icons.sprite-hash`, served
  `public, max-age=31536000, immutable` — the hash IS the content's address)
  and `GET /api/icons/saved-sprite-assets/:hash` (`getSavedSpriteAsset`:
  `SavedSpriteAsset` JSON — every name a saved-icon source reports and, per
  default style key, their `<symbol id="msr-…">`s — under `icons.symbols-hash`,
  served `no-cache` with an ETag over the names, since they move whenever a
  user picks an icon: a warm load is a 304). A hash that is not the host's is
  a 409.
- **Started at t0 by the shell's head** (`server/internal/head.ts`, a
  `DocumentHead.Fragment`): an inline async module script fetches the
  resident keys (`RESIDENT_SPRITE_KEYS`: the default style's two + brands) and
  the saved asset while the HTML parses, and parks the responses on
  `globalThis.__equinIconSprites` (`shared/head-request.ts`) — the boot
  snapshot's head-request shape. Both hashes are fixed for the backend's life,
  so the fragment is a constant.
- **Provided before the first render** by a `Core.Boot` task
  (`web/internal/boot.ts`, `ifUnavailable: "continue"`): it takes the parked
  responses, `provideSprite`s each resident sprite and `provide`s the saved
  chunk to `pageRuntimeSymbols`, and records an `icon-sprites` boot span. A 409
  (a head written by an earlier backend) is left to the live reads below; any
  other failure throws (reported, boot goes on).
- **Everything else is live, on demand**: `IconSpriteHost` reads
  `icons.sprite-hash` (preloaded) and, as `useLive(iconSprite, [{ hash, key },
  …])`, every resident key the head did NOT provide under that hash, every
  other style key a scope wants and every sprite a mounted icon asked for
  (`useWantedSprites` — the never-resident `seti`, `lucide`, `lucide-active`).
  A refusal is thrown into its error boundary except a hash-behind one
  (`web/internal/refusals.ts`), a transient failure reported and left
  unprovided.

## Values and drawers

- **Portable sprites** (`icons.sprite`, `icons.sprite-hash`), drawn through
  the host's `SpriteDrawer` host service: the installed sets on the computer
  (`machine/`'s `installedSetsSpriteDrawer`, every key), the Seti and Lucide
  sets bundled with a browser host (`plugins/bundled-sprites`; any other key
  is refused `not-drawn-here`). An icon asks its scope's store for a
  never-resident sprite (`RuntimeSymbolStore.wantSprite`): the page's store
  hands it to `IconSpriteHost`, a scope's (`ScopeIconSymbols`) reads it from
  the scope's own server and provides it to the document's sheet — so a
  demo's file-type and Lucide icons never reach the page's server. The Seti
  and Lucide assembly (`buildSetiSprite`, `buildLucideSprites`,
  `buildSprite`, the Lucide tuning) is `server/`'s, one build for both
  drawers. `iconSprite` (`{ hash, key }`) is external `immutable` and refused
  `unknown-key`, `stale-manifest`, `not-drawn-here`; its `revalidate` ETag is
  the tuple while the hash is the host's.
- **Desktop-only** (`machine/`): the per-weight memoized build from the
  installed sets behind the desktop's `SpriteDrawer` (its `manifestHash` folds
  in the manifest, the sets' identities, `SETI_SET`, `LUCIDE_MAP`,
  `LUCIDE_TUNING_VERSION` and `ACTIVE_FORM_VERSION`), and `icons.manifest`
  (`needsMachine`, Debug → Icons' rows).
- **Saved (runtime) symbols** — see the parent's "Runtime symbols". Portable
  (`server/`), drawn through the host's `RuntimeSymbolDrawer`
  (`{ identity, draw(key, names) }`): the installed sets on the computer
  (`machine/`'s `installedSetsDrawer`), the bundled set on a browser host
  (`plugins/bundled-symbols`). `drawRuntimeSymbol(sets, key, name)` is the one
  build every drawer runs; `symbolsHash()` (sha256 of the drawer's identity,
  the savable-name list and `RUNTIME_SYMBOL_BUILD_VERSION`) is served as
  `icons.symbols-hash` (`savedSymbolsHash`, external `fixed`, preloaded);
  `savedIconNames()` reads every source's names, sorted. On demand,
  `icons.runtime-symbols` (`{ hash, key, names }`: `names` a comma-joined,
  sorted, duplicate-free list of at most `MAX_RUNTIME_SYMBOLS_PER_READ` saved
  names, external `immutable`; refused `unknown-key`, `stale-symbols`,
  `invalid-names`, `unknown-name`). Design:
  `research/2026-11-06-global-scoped-runtime-symbols.md`.
- `machine/`'s drawer keeps per-style symbol maps (`runtime-symbols.ts`: a
  name's symbol is drawn the first time it is asked for, then kept — a boot
  draws the handful of saved names, not all 4,240). The ~19 MB sets are parsed
  under one shared lease (`withSymbolSets`) and dropped after.
- `plugins/bundled-symbols` (a host provider, never booted by the desktop): a
  browser host's drawer — `@iconify-json/material-symbols` (weight 400, every
  shape and fill: 8.2 MB raw, 1.3 MB compressed) imported lazily, ONLY when a
  drawing is missing; the light set is not bundled, so a light style draws
  its 400 drawing (the nearest-style rule). Its warm-up draws every saved
  name in every style and keeps those drawings in the host's storage
  (`icon-symbols`, keyed by the set's identity) — so a visitor loads the set
  only to pick a new one. Anything else (a picker's grid) is held in memory
  only.
- `web/`: the runtime-symbol loader (`createRuntimeSymbolLoader`: every want
  of a frame becomes one immutable batch per style key, at most 200 sorted
  names; a name is never batched twice), read as
  `useLive(runtimeSymbolsValue, [{ hash, key, names }, …])` while in flight
  and dropped once its chunk is in the sheet. `IconSpriteHost` installs it on
  the page's store (`pageRuntimeSymbols`); `ScopeIconSymbols` (children) gives
  a plugin scope a store of its own (`createScopedRuntimeSymbols` +
  `RuntimeSymbolScope`), filled from the scope's server by the same loader and
  drawn in a `RuntimeSymbolSheet` inside the scope (ids prefixed `rs<n>-`). A
  scope has no head: its saved icons load through the loader as they mount.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Mounts the page's icon sprites inline. The resident default-style sprites and the saved-icon symbols the first paint needs are fetched by the SPA shell's head at t0 (content-addressed assets the browser caches) and provided by a Core.Boot task before the first render — never carried by the boot snapshot; every other sprite (another style a theme scope picks, the Seti and Lucide sprites, a resident one the head did not provide) and every other saved name are read live, on demand. ScopeIconSymbols gives a plugin scope (a demo) saved icons of its own, read from the scope's server and drawn in a sheet inside it. The build's sprites, on every host, drawn through the host's SpriteDrawer — the computer's installed sets (this plugin's machine half) or the Seti and Lucide sets bundled with a browser host (plugins/bundled-sprites): icons.sprite (one sprite by key on demand, immutable, content-addressed by icons.sprite-hash, preloaded) and GET /api/icons/sprite-assets/:hash/:key, the same sprite as an asset the browser caches for good. Saved (user-picked) icons as runtime symbols, drawn through the host's RuntimeSymbolDrawer (the installed sets, or a set bundled with the page — plugins/bundled-symbols): icons.runtime-symbols serves any saved names in any style on demand (immutable, content-addressed by icons.symbols-hash, preloaded), and GET /api/icons/saved-sprite-assets/:hash the default styles' drawing of every name a saved-icon source (ui/icons/saved-sources) reports, revalidated by an ETag over the names. A DocumentHead.Fragment starts both asset requests in the SPA shell's head, so the sprites a first paint needs never ride the boot snapshot.
- Web:
  - Contributes:
    - `Core.Boot`
    - `Icons.Root` → `IconSpriteHost`
  - Uses:
    - `network/live.useLive`
    - `primitives/perfs/boot-trace.recordBootSpan`
    - `ui/icons.createScopedRuntimeSymbols`
    - `ui/icons.Icons`
    - `ui/icons.IconSpriteSheet`
    - `ui/icons.pageRuntimeSymbols`
    - `ui/icons.provideSprite`
    - `ui/icons.RuntimeSymbolScope`
    - `ui/icons.RuntimeSymbolSheet`
    - `ui/icons.RuntimeSymbolStore`
    - `ui/icons.useWantedScopeSprites`
    - `ui/icons.useWantedSprites`
    - `ui/icons.useWantedStyleKeys`
  - Exports (values): `ScopeIconSymbols`
- Server:
  - Contributes:
    - `DocumentHead.Fragment` "icon-sprites"
    - `resource.declare` "icons.manifest"
    - `resource.declare` "icons.runtime-symbols"
    - `resource.declare` "icons.sprite"
    - `resource.declare` "icons.sprite-hash"
    - `resource.declare` "icons.symbols-hash"
    - `host-service:icons.sprite-drawer` "icons.sprite-drawer"
    - `host-service:icons.runtime-symbol-drawer` "icons.runtime-symbol-drawer"
  - Uses:
    - `infra/endpoints.endpointPath`
    - `infra/endpoints.rawEndpointHandler`
    - `network/live.serveValue`
    - `shell/document-head.DocumentHead`
    - `ui/icons/saved-sources.SavedIconSource`
    - `ui/icons/saved-sources.savedIconSources`
  - Exports (types):
    - `DrawnSprite`
    - `RuntimeSymbolDrawerImpl`
    - `SpriteDrawerImpl`
  - Exports (values):
    - `buildLucideSprites`
    - `buildSetiSprite`
    - `buildSprite`
    - `drawRuntimeSymbol`
    - `LUCIDE_TUNING_VERSION`
    - `RUNTIME_SYMBOL_BUILD_VERSION`
    - `RuntimeSymbolDrawer`
    - `savedIconNames`
    - `SpriteDrawer`
  - Resources:
    - `icons.manifest` (push, fixed, whole: the symbol names the build scanned from the code — fixed for the process, and the Icons pane lists them all)
    - `icons.runtime-symbols` (invalidate, immutable)
    - `icons.sprite` (invalidate, immutable)
    - `icons.sprite-hash` (push, fixed)
    - `icons.symbols-hash` (push, fixed)
  - Routes:
    - `GET /api/icons/sprite-assets/:hash/:key`
    - `GET /api/icons/saved-sprite-assets/:hash`
- Machine:
  - Uses: `network/live.serveValue`
  - Exports (values): `manifestSymbolBody`
- Core:
  - Uses:
    - `infra/endpoints.blob`
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
    - `packages/list-bound.wholeList`
    - `packages/list-bound.wholeRecord`
    - `ui/icons.BRANDS_SPRITE`
    - `ui/icons.DEFAULT_STYLE_KEYS`
    - `ui/icons.SpriteKey`
  - Exports (types): `SavedSpriteAsset`
  - Exports (values):
    - `getSavedSpriteAsset`
    - `getSpriteAsset`
    - `iconManifest`
    - `iconSprite`
    - `MAX_RUNTIME_SYMBOLS_PER_READ`
    - `RESIDENT_SPRITE_KEYS`
    - `runtimeSymbolsValue`
    - `SavedSpriteAssetSchema`
    - `savedSymbolsHash`
    - `spriteHash`
- Cross-plugin:
  - Imported by:
    - `apps-core/app-manifest`
    - `debug/icons`
    - `framework/browser-server/demo/scope`
    - `ui/icons/sprites/bundled-sprites`
    - `ui/icons/sprites/bundled-symbols`
- Sub-plugins:
  - **`bundled-sprites`** (excluded) — The on-demand sprites of a host without the computer's icon sets (the browser composition): provides the SpriteDrawer from the sets bundled with the worker — the vendored Seti file-type set (every…
  - **`bundled-symbols`** (excluded) — The saved-icon drawings of a host without the computer's icon sets (the browser composition): provides the RuntimeSymbolDrawer from the Material Symbols set bundled with the worker (weight 400…

<!-- AUTOGENERATED:END -->
