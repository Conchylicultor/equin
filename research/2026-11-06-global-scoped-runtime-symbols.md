# A scope draws its saved icons from its own server

Task: task-1793979789-wtzxz9 (supervisor conv-1793665695-3p52r4). Track: "apps running in the
browser, on fake or local data" (wiki block-d04c6c0d-…). Follow-up of
research/2026-11-06-global-places-in-browser-demo.md ("Temporary page-server read").

## Context

A saved (user-picked) icon is a runtime symbol: `<Icon icon={runtimeSymbol(name)}/>` asks the
**page-global** runtime-symbol store (`ui/icons/web/internal/runtime-symbol-store.ts`) for
`(styleKey, name)`; a name no chunk holds is a want, handed to the ONE loader the page's sprite host
(`ui/icons/sprites/web`, `IconSpriteHost`, page chrome at `Core.Root`) installed, which reads it as
`icons.runtime-symbols` — through the PAGE's transport. So in `/demo`, Places' place and tag icons
(which no saved-icon source reports, so they are never resident) are fetched from the page's server:
`GET /api/resources/icons.runtime-symbols`, sanctioned in no-leak / places-in-demo.

Decision (supervisor): no exception. A scope gets its own symbol source; code inside a scope has no
way to reach the page's.

## Design

### 1. The saved-icon values become portable (server)

- New `ui/icons/sprites/server` (portable): serves `icons.saved-sprites`,
  `icons.saved-icons-changed` and `icons.runtime-symbols` (moved from `machine/`, same
  semantics), over a new host service **`RuntimeSymbolDrawer`** (`icons.runtime-symbol-drawer`):
  `{ identity: string; draw(key, names): Promise<string[]> }` — one `<symbol id="msr-…">` per
  name, nearest-style fallback. `symbolsHash` = sha(drawer identity, saved-name list, build
  version), computed on first use. `needsMachine` is dropped from those three declarations;
  `icons.sprites`, `icons.sprite`, `icons.manifest` stay desktop-only.
- The pure glyph code moves to `ui/icons/core` (`resolveIcon`, `resolveSymbol`, `SymbolSets`,
  `IconBody`, `buildSymbol`, `wrapSprite`), so a portable barrel can draw. `ui/icons/server` keeps
  only the fs readers (`symbolBody`, Seti).
- `sprites/machine` provides the drawer from the installed sets (today's per-style memo).
- **Browser host provider** `ui/icons/sprites/plugins/bundled-symbols` (a lone `server/`, no
  composition bundles it): the drawer over `@iconify-json/material-symbols` (weight 400, all
  shapes and fills) **imported lazily** (`import()` of `icons.json`, a plain-JS module + `.d.ts`
  so tsc never types 8 MB of JSON); the light (300) set is not bundled, so a light style draws its
  400 drawing — the existing nearest-style rule, not a stand-in. Every drawn symbol is written
  through to the host's storage (`hostStorage().store("icon-symbols")`), keyed by identity,
  style and name, so it outlives a reload and rides in a snapshot.
- A warm-up in that provider (`defineWarmup`, sole host runs it) draws every name the saved-icon
  sources report in every style key. At build time the snapshot is taken after the settled phase,
  so **the snapshot's glyphs ship pre-drawn in the snapshot**; in a visitor's browser the warm-up
  finds them stored and loads nothing. The 8 MB set is fetched only when a name/style outside the
  store is wanted (the icon picker).
- New saved-icon sources so the demo's icons are resident: every tag tree's `icon` column
  (registered by `serveTagTree`, `tag-tree/engine`), and `places.icon` (places-core). The real app
  gains these at first paint too.

Size (measured): the full 400 set is 8.19 MB raw / 1.26 MB gzip, one lazy chunk; default shape only
would be 0.62 MB gzip but needs a build-time trim — not worth it for a lazily loaded file.

### 2. Each plugin scope has its own runtime-symbol store (web)

- `ui/icons/web`: the store becomes an object (`createRuntimeSymbolStore({ idPrefix })`); the
  page's is the module singleton. `RuntimeSymbolScope` provides a store bound to the
  `PluginScope` it mounts in. `useRuntimeSymbolStore()`: outside every scope → the page's; in a
  scope → that scope's own; **in a scope with no own store → throws**, naming the scope (the same
  check as `RenderOrigin`). `<Icon>` and `useIconMarkup` resolve runtime drawings and wants
  against it (`resolveIconDrawing` takes the store).
- A scoped store's symbol ids carry its prefix (`msr-<scope>-<key>-<name>`; the chunk's ids are
  rewritten when provided), and it renders its own zero-size sheet inside the scope — never a
  duplicate id against the page's sheet.
- `ui/icons/sprites/web` exports `ScopeIconSymbols` (children): mounts a scoped store, reads
  `icons.saved-sprites` / `icons.runtime-symbols` through the enclosing transport, installs the
  batching loader on that store. `IconSpriteHost` keeps doing the same for the page's store.
- `DemoScope` mounts `<ScopeIconSymbols>` inside its `PluginScope`, beside `RenderOrigin`.

Rung: 1 for the wiring (no API reaches the page store from a scope), 4 (loud throw) for a scope
that forgot to mount a source.

### 3. e2e

- no-leak, places-in-demo: drop `TEMPORARY_ICON_SYMBOLS_READ` and the dead
  `/api/icons/(sprite|symbols)/` sanction (those routes were deleted in 2026-10). Check whether
  `icons.sprite` (non-resident manifest sprites) is ever read from inside the demo; it is not
  sanctioned, so no-leak fails if it is.
- places-in-demo: the place / tag icons draw (symbols in the scope's sheet), and opening a tag's
  icon picker draws its grid and a pick sticks — nothing reaching the page's server.

## Verification

- Unit: runtime-symbol store (page vs scoped, throw in an unsourced scope, id prefix); drawer
  identity → hash; bundled drawer draws from a stored entry without loading the set.
- `./equin build`; demo e2e: no-leak, places-in-demo, snapshot, persistence, app-switch,
  desktop-in-demo, prototypes-in-demo, sonata-in-demo, keyboard-party-in-demo.
- Real app: an agent avatar / callout icon and the icon picker grid still draw (screenshot).

## Outcome (2026-11-06)

- Implemented as designed. `pageRuntimeSymbols` / `createScopedRuntimeSymbols` /
  `RuntimeSymbolScope` (icons web); `ScopeIconSymbols` (sprites web), mounted by `DemoScope`
  around `RenderOrigin`; the three saved-icon values in `sprites/server` over the
  `icons.runtime-symbol-drawer` host service; `sprites/plugins/bundled-symbols` on the browser
  host; saved-icon sources for every tag tree (`serveTagTree`) and Places' places.
- **Sizes.** The bundled set is one lazy vendor chunk of the worker:
  `iconify-json__material-symbols__icons.json.js`, 8.07 MB raw, 1.25 MB gzip, 0.96 MB brotli
  (the provider's own artifact is 2.5 KB). It loads only on a drawing miss — in the demo, opening
  an icon picker. The demo snapshot carries 1 308 drawn symbols (109 saved names × 12 styles,
  `icon-symbols` store), so a first visit draws every seeded icon without it.
- **The snapshot address does not cover server code**, so adding the warm-up alone did not
  re-take it; the snapshot script now logs each store's size (`stores: config 444,
  attachment-blobs 3, icon-symbols 1308, data-files 41, transcripts 6`), which re-addressed it.
  A future change to what a warm-up writes has the same gap (an older snapshot still works: a
  miss loads the set in the visitor's browser).
- **Sanctions.** `TEMPORARY_ICON_SYMBOLS_READ` is gone from no-leak and places-in-demo, and so is
  `/^\/api\/icons\/(sprite|symbols)\//`: those routes were deleted in 2026-10 (the sprites moved
  onto live values), so it sanctioned nothing. The page's resident manifest sprites reach the page
  in its own boot snapshot, before and outside the demo; no demo step reads `icons.sprite`.
  Latent: a manifest sprite wanted from inside a scope (a non-default style, Seti, Lucide) would
  still be read by the page's sprite host — no demo app wants one today (no-leak would fail).
- e2e on this build: places-in-demo 31 (new: the demo's own sheet holds a place's icon, nothing
  in the embed `<use>`s the page's sheet, the tag icon picker draws 144 cells from the scope's
  sheet and a pick sticks), no-leak 46 (2 host skips, as before), snapshot 28, persistence 38,
  app-switch 28, desktop-in-demo 22, prototypes-in-demo 27, sonata-in-demo 39,
  keyboard-party-in-demo 35. Real app: /places draws its 86 saved icons from the page's sheet and
  the tag icon picker's 144 cells, unchanged.
