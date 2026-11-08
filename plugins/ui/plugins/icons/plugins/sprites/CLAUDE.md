# sprites

Serves and mounts the icon sprites the icons primitive draws from. The design
is in the parent's [`CLAUDE.md`](../../CLAUDE.md) (section "Sprites").

- **The resident sprites are desktop-only** (`needsMachine: { feature:
  "Icon sprites" }` on `icons.sprites` and `icons.manifest`): they are built
  from the icon sets installed on the computer, so the serving half is
  `machine/` and a host without the computer answers them unavailable. The
  page's come from the page's own server (`IconSpriteHost` is page chrome,
  mounted outside any demo scope).
- **The on-demand sprite is portable** (`icons.sprite`, and
  `icons.sprite-hash` — the hash its tuples carry), drawn through the host's
  `SpriteDrawer` host service: the installed sets on the computer
  (`machine/`'s `installedSetsSpriteDrawer`, every key), the Seti and Lucide
  sets bundled with a browser host (`plugins/bundled-sprites`; any other key
  is refused `not-drawn-here`). An icon asks its scope's store for a
  never-resident sprite (`RuntimeSymbolStore.wantSprite`): the page's store
  hands it to `IconSpriteHost`, a scope's (`ScopeIconSymbols`) reads it from
  the scope's own server and provides it to the document's sheet — so a
  demo's file-type and Lucide icons never reach the page's server. The Seti
  and Lucide assembly (`buildSetiSprite`, `buildLucideSprites`,
  `buildSprite`, the Lucide tuning) is `server/`'s, one build for both
  drawers.
- **The saved-icon values are portable** (`server/`): `icons.saved-sprites`,
  `icons.saved-icons-changed`, `icons.runtime-symbols`, drawn through the
  host's `RuntimeSymbolDrawer` host service — the installed sets on the
  computer (`machine/`'s `installedSetsDrawer`), the bundled set on a browser
  host (`plugins/bundled-symbols`). So a plugin scope (the demo) reads its
  saved icons from ITS server: `web/`'s `ScopeIconSymbols`, mounted by
  `DemoScope` inside the scope. Design:
  `research/2026-11-06-global-scoped-runtime-symbols.md`.
- `core/`: `residentSprites` (`icons.sprites`, preloaded: the default style's
  two sprites + brands, and the `manifestHash`), `iconSprite` (`icons.sprite`,
  `{ hash, key }`, on demand: one sprite's `<svg>`, content-addressed by the
  drawer's hash; refused `unknown-key`, `stale-manifest` and
  `not-drawn-here`), `spriteHash` (`icons.sprite-hash`).
- `machine/`: the per-weight memoized build from the installed sets, the
  resident value and the desktop's `SpriteDrawer` — external `fixed`, and the
  on-demand value `immutable` (a pure
  function of the compiled manifest and the installed sets; the on-demand one
  answers only this process's `manifestHash`). Each declares a `revalidate`
  ETag — the resident value's is `manifestHash`, an on-demand tuple's the
  tuple itself while its hash is this process's — so a tab replaying them after
  a restart that kept the manifest and sets is answered `up-to-date` instead
  of re-sent ~2 MB of sprites (`icons.runtime-symbols` likewise, by
  `symbolsHash`). The `seti` sprite is built
  from the icons plugin's vendored set (`SETI_SET`, its identity folded into
  `manifestHash`) and served only by `icons.sprite`, never in the resident
  value. So is the `lucide` sprite: every mapped
  manifest symbol's Lucide drawing (`@iconify-json/lucide`, embedded in
  `icon-sets.js`), tuned by `lucide.ts` (7/8 box, 1.2px non-scaling stroke);
  the set's identity, `LUCIDE_MAP` and `LUCIDE_TUNING_VERSION` are folded into
  `manifestHash`.
- `web/`: `IconSpriteHost` (`Core.Root`) provides the resident sprites in a
  layout effect (so they are on screen at first paint), reads every other
  style key a scope wants and every sprite a mounted icon asked for
  (`useWantedSprites` — the never-resident `seti` and `lucide` sprites) as
  `useLive(iconSprite, [{ hash, key }, …])` (a refusal thrown into its error
  boundary, a transient failure reported and left unprovided), and renders
  the icons plugin's `IconSpriteSheet`.
  It also provides the resident saved-icon symbols and installs the runtime
  symbol loader (`createRuntimeSymbolLoader`: every want of a frame becomes one
  immutable batch per style key, at most `MAX_RUNTIME_SYMBOLS_PER_READ` (200)
  sorted names; a name is never batched twice). The host reads the batches in
  flight as `useLive(runtimeSymbolsValue, [{ hash, key, names }, …])` and drops
  a batch from the read once its chunk is in the sheet, so the tuples read at
  once are only the ones in flight — never one per name, never one per name
  ever seen. A refusal is thrown into its error boundary; a transient failure
  is reported and leaves that batch's icons on their fallback.

Saved (runtime) symbols — see the parent's "Runtime symbols":

- `core/`: `savedIconSprites` (`icons.saved-sprites`, preloaded: the default
  style's `<symbol id="msr-…">` for every name a source reports, plus
  `symbolsHash`), `savedIconsChanged` (the tick config sources bump),
  `runtimeSymbolsValue` (`icons.runtime-symbols`, `{ hash, key, names }`, on
  demand: `names` a comma-joined, sorted, duplicate-free list of at most
  `MAX_RUNTIME_SYMBOLS_PER_READ` saved names, content-addressed by
  `symbolsHash`; refused `unknown-key`, `stale-symbols`, `invalid-names` and
  `unknown-name`).
- `server/` (portable): the `RuntimeSymbolDrawer` host service
  (`{ identity, draw(key, names) }`), `drawRuntimeSymbol(sets, key, name)` (the
  one build every drawer runs), `symbolsHash()` (sha256 of the drawer's
  identity, the saved-name list and `RUNTIME_SYMBOL_BUILD_VERSION`, on first
  use), `savedIconNames()` (every source's names, sorted), the resident value
  (DB-arm: sources' reads are captured; a first subscriber and every config
  change bump the tick) and the on-demand runtime-symbols value (external
  `immutable`; answers only this host's `symbolsHash`).
- `machine/`: the desktop's drawer — the per-style symbol maps
  (`runtime-symbols.ts`: every saved name's symbol for one style, built in one
  pass over both installed sets the first time the style is asked for, then
  kept). The ~19 MB sets are parsed under one shared lease (`withSymbolSets`)
  and dropped after.
- `plugins/bundled-symbols` (a host provider, never booted by the desktop): a
  browser host's drawer — `@iconify-json/material-symbols` (weight 400, every
  shape and fill: 8.2 MB raw, 1.3 MB compressed) imported lazily, ONLY when a
  drawing is missing; the light set is not bundled, so a light style draws
  its 400 drawing (the nearest-style rule). Its warm-up draws every saved
  name in every style and keeps those drawings in the host's storage
  (`icon-symbols`, keyed by the set's identity; a stale set's are dropped when
  the storage opens) — so the demo's build-time snapshot carries its icons
  drawn and a visitor loads the set only to pick a new one. Anything else (a
  picker's grid) is held in memory only, so the storage never grows to the
  whole set.
- `web/`: `IconSpriteHost` fills the PAGE's runtime-symbol store
  (`pageRuntimeSymbols`) from the page's server. `ScopeIconSymbols`
  (children) gives a plugin scope a store of its own
  (`createScopedRuntimeSymbols` + `RuntimeSymbolScope`), filled from the
  scope's server with the same loader, drawn in a `RuntimeSymbolSheet` inside
  the scope (ids prefixed `rs<n>-`, never repeating the page's).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Mounts the page's icon sprites inline: the resident default-style sprites from the boot snapshot (present at first paint) plus, on demand, the sprite of every other style a theme scope picks, and the page's saved-icon symbols. ScopeIconSymbols gives a plugin scope (a demo) saved icons of its own, read from the scope's server and drawn in a sheet inside it. The build's sprites on demand, on every host: icons.sprite (one sprite by key, immutable, content-addressed by icons.sprite-hash) drawn through the host's SpriteDrawer — the computer's installed sets (this plugin's machine half) or the Seti and Lucide sets bundled with a browser host (plugins/bundled-sprites) — so a scope reads its sprites from its own server. Saved (user-picked) icons as runtime symbols, on every host: the resident icons.saved-sprites value draws every name a saved-icon source (ui/icons/saved-sources) reports in the default style, and the on-demand icons.runtime-symbols value serves any saved names in any style, immutable (content-addressed by symbolsHash). Both draw through the host's RuntimeSymbolDrawer — the icon sets installed on the computer (this plugin's machine half), or a set bundled with the page (plugins/bundled-symbols, a browser host) — so a demo's icons come from its own server.
- Web:
  - Contributes: `Icons.Root` → `IconSpriteHost`
  - Uses:
    - `network/live.useLive`
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
    - `resource.declare` "icons.manifest"
    - `resource.declare` "icons.runtime-symbols"
    - `resource.declare` "icons.saved-icons-changed"
    - `resource.declare` "icons.saved-sprites"
    - `resource.declare` "icons.sprite"
    - `resource.declare` "icons.sprite-hash"
    - `resource.declare` "icons.sprites"
    - `host-service:icons.sprite-drawer` "icons.sprite-drawer"
    - `host-service:icons.runtime-symbol-drawer` "icons.runtime-symbol-drawer"
  - Uses:
    - `network/live.serveValue`
    - `ui/icons/saved-sources.savedIconSources`
    - `ui/icons/saved-sources.savedIconSourcesCode`
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
    - `icons.saved-icons-changed` (push, notified)
    - `icons.saved-sprites` (push, whole: every saved icon name — each picked by hand, and every one must be drawable at first paint, whole: one sprite per default style key — a handful)
    - `icons.sprite` (invalidate, immutable)
    - `icons.sprite-hash` (push, fixed)
    - `icons.sprites` (push, fixed, whole: the resident sprites — the default style's two and the brands)
- Machine:
  - Uses: `network/live.serveValue`
  - Exports (values): `manifestSymbolBody`
- Core:
  - Uses:
    - `network/live.liveValue`
    - `packages/list-bound.wholeList`
    - `packages/list-bound.wholeRecord`
  - Exports (types):
    - `IconSprites`
    - `SavedIconSprites`
  - Exports (values):
    - `iconManifest`
    - `iconSprite`
    - `IconSpritesSchema`
    - `MAX_RUNTIME_SYMBOLS_PER_READ`
    - `residentSprites`
    - `runtimeSymbolsValue`
    - `savedIconsChanged`
    - `savedIconSprites`
    - `SavedIconSpritesSchema`
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
