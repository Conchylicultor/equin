# Home — the island gallery (from prototype to app)

## Context

Prototype `proto-1794374690-9xmb84` (`~/.equin/apps/prototypes/`) turns the Home gallery into an
illustrated JRPG-style archipelago:

- **Apps as buildings.** Each app is a building shaped like what it does. Click it, or walk to it and press E, to open the app.
- **Movement.** A hero walks there by click (A*) or by arrow keys.
- **Atmosphere.** Generative lo-fi/ambient music plays, and the map follows the time of day (day, dusk, night).
- **Growth.** New apps get a generated building and are placed append-only (an existing app never moves). Districts fill up, then new islands appear, joined by bridges or ferries.

The prototype is ~480 KB of plain JS in globals (`window.BUILDINGS`, `window.ISLAND_SHAPES`, …).
This plan says how it becomes plugins:

- what the abstractions are;
- who owns which part;
- how an app gets its building;
- where layout state lives;
- how it ships, demo included.

## Principles

1. **Home owns the world; each app owns its building.** This is the same split as `Apps.App`, where each
   app owns its icon. Home's engine never names an app (collection/consumer separation). An app
   without a contribution gets a generated building, so a new app needs **zero** island code.
2. **The world is pure data.** Islands, terrain, districts, plots, placement and pathfinding are
   deterministic functions of (seed, ordered app list, saved plots) in `core/`, so they can be
   tested with bun:test with no canvas. Canvas code only draws that data.
3. **Painters are pure canvas functions, not React.** `paint(g, s)` takes a 2D context
   (`CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D`). Living in `core/` means a
   worker can run them too, which removes the prototype's last main-thread hot spot: measuring
   and baking each building.
4. **Placement is append-only and stored, not recomputed.** Recomputing from the app list would
   move buildings whenever an app is added or removed.
5. **Deferred tier.** Everything lives in a non-shell sub-plugin of `apps/home`, so none of it is
   in the eager boot bytes (`web-sdk/core/load-tiers.ts`, `isDeferredPluginPath`).

## Plugin tree

```
plugins/apps/plugins/home/plugins/
  shell/                 (exists) Home app, Home.Section, theme
  app-cards/             (exists) the grid DataView — gains the "island" view (below)
  island/                umbrella; web: <IslandView> + its DataView view-type contribution
    plugins/
      world/             core only — pure, deterministic, tested
                           shapes (islands.js), terrain tags, districts, plot growth,
                           placement (append-only), walk grid + A*, label spots
      buildings/         core: the Building contract + painting kit (ink, wash, shade,
                           stone, thatch, props…) + generated buildings by category (kit)
                         web:  slot Island.Building (per-app contributions)
      characters/        core: hero + villagers sprite painters, walk cycle
      renderer/          web:  the canvas engine — camera (drag/inertia/pinch/wheel),
                           tiles (ground/object layers, water between), bake scheduler +
                           worker pool, hit masks, hover glow, labels band, time-of-day
                           tint/lights, input (click-walk, keys, E to enter)
      plots/             core: liveCollection `island.plots` + endpoints contract
                         server: table + serveCollection + claim/move endpoints
      dev/               exhibits/: the count slider, fake apps, "regrow" — never in Home
plugins/music/plugins/ambient/   web: generative WebAudio engine (lofi | ambient moods,
                                  duck(), blips/steps sfx) — reusable, not Home-specific
plugins/apps/plugins/<app>/plugins/island-building/   one per bespoke app (14 today)
```

## The abstractions

### 1. `Island.Building`: how an app declares its building

The slot is defined in `island/buildings/web`, and its contract types are in `island/buildings/core`:

```ts
// buildings/core
interface BuildingSpec {
  footprint: { w: number; depth: number };   // declared, not measured → placement is pure
  setting?: Setting;                          // "coast" | "cape" | "hill" | "harbour" | "square" | "forest" | "lane"
  signX?: number;
  lights: Light[];                            // window/lantern glows for night
  paint(g: Ctx2D, s: PaintState): void;       // static art, cached per time of day
  animate?(g: Ctx2D, s: PaintState): void;    // moving parts (smoke, slate, automaton)
}
interface PaintState { t; night; dusk; open; hue; shade(c, k); rnd(): number }
```

- **Contributing a building.** An app contributes from its own deferred sub-plugin, keyed by its `AppRef`:
  `Island.Building({ app: sonataApp, ...musicHall })`. Example: `apps/sonata/plugins/island-building/`,
  which holds the music hall with the piano visible.
- **Lookup.** The engine finds a building by `app.id` and imports no app.
- **Footprint check.** The declared footprint is enforced by a test in `buildings/core`: paint each
  registered spec onto an OffscreenCanvas and assert that its alpha bounds fit the footprint.
  - The prototype measured footprints at runtime, which cost ~20 ms per building and blocked
    server-side placement.
  - Declaring it turns that runtime work into data, with a check to keep it honest.

### 2. Apps without a building get a generated one

- `buildings/core` exports `kitBuilding(app, category, seed): BuildingSpec` (the prototype's
  `buildings-kit.js`).
- The building is generated from a seed taken from the app id, and its accents use the app's tile
  colour (`appTileFill` in `apps-core/plugins/app-icon/core`).
- **Category.** `AppRef` has no category today. Add an optional closed-list field
  `category?: AppCategory` (`work | create | music | life | data | play | system`) to `AppRef`
  (`primitives/pane/core/route.ts`).
  - It is plain data in core, because the list is closed.
  - It is useful beyond the island: grouping the grid, the launcher.
  - The `create-app` skill asks for it.
  - With no category, the kit chooses one from the id hash.

### 3. Plots: where buildings stand, persisted append-only

`island.plots` is a `liveCollection` declared in `plots/core`.

- **Row:** `{ appId (PK), island, district, plot, x, y, movedByUser, createdAt }`.
- **Read:** `useLive` gives a `ResourceResult`, and the island renders a loading state, never an empty sea.
- **Seed:** the world seed and options (time override, music mood, on/off) live in `config_v2`
  (`defineConfig("home.island", …)`).
  - The seed is small and user-editable, and it shows in Settings for free.
  - Placements do not go in config: a whole-document, last-writer-wins blob is wrong for them, and it would render badly in Settings.

**Flow when an app appears:**

1. The view reads `useListedApps()` and `island.plots`.
2. For each listed app without a plot, it runs `world.place(app, footprint, setting, existingPlots, seed)`. This is pure and deterministic.
3. It calls `POST island/plots/claim` with the result.
4. The server inserts with `ON CONFLICT (appId) DO NOTHING`. Two tabs compute the same answer, and the first one wins.

**Moves and removals:**

- **Drag-and-drop:** `POST island/plots/move` sets `movedByUser`. The world re-validates the spot: no overlap, on land.
- **Removed apps:** a removed app's plot is kept, shown as an empty lot, and reused by the next app that fits. Placement stays append-only.
- **Islands are derived:** island shapes are a pure function of (seed, island index, plots on it), so only plots are stored.

**Demo:** the browser demo's portable server must serve `island.plots`; the `browser-host-coverage` guard enforces this.

### 4. Renderer: the engine, web only

`<IslandView>` mounts one canvas. The engine class, like `map/pin-layer`'s `PinLayer`, takes a
`World` (from `world/core`) plus a building lookup and draws frames.

- **What it keeps from the prototype, as-is:**
  - 512px tiles split into ground and object layers, with water clipped between them;
  - a scaled tile from another zoom standing in while the real one bakes;
  - bakes built centre-first, at most 3 per frame;
  - per-building alpha hit masks and the hover glow layer;
  - the label band (the `LABEL_BAND` multiples of the island-fit zoom);
  - the time-of-day tint and night lights.
- **Workers.** The worker pool becomes a real module worker per web plugin. There is no precedent:
  - no vite `?worker` usage exists in web plugins today;
  - the request guard mentions blob workers.
  - **Phase 1 runs on the main thread with stepped bakes** (the prototype's fallback path, already
    correct). Workers are a follow-up that may need a small `web-artifacts` addition for worker
    entries.
- **Opening an app:** the iris transition, then `useActivateApp()(entry)` from `apps-core/plugins/tabs/web`. Because it is a link activation, ⌘-click opens a new browser tab.
- **App usage:** `useAppUsageSummary()` drives what the world shows: apps used recently have lit chimneys and villagers around them, and apps never opened stay quiet.
- **Time of day:** derived from `Date`, with a one-shot timeout to the next phase boundary (no polling), or overridden by config.
- **Signs:**
  - the icon tile is drawn from the Material Symbols sprite (`ui/icons`), rasterised once per glyph;
  - the label fonts (Nunito for signs, Fraunces for map names) are added to the Home theme, so `google-fonts-loader` fetches them;
  - the canvas waits on `document.fonts.load` before drawing text.
- **Accessibility and fallback:**
  - a visually hidden list of building links mirrors the map, for keyboard and screen readers;
  - `prefers-reduced-motion` turns off the camera inertia and the iris transition.

### 5. Music: `music/plugins/ambient`

- **Why under `music`:** it is a generic generative engine, unrelated to Home's world. The prototype's `music.js` becomes:
  - `createAmbient(ctx, { mood })` with `start`, `stop`, `duck(on)` and `sfx.{step, blip, enter, whoosh}`;
  - a `useAmbient(mood)` hook that owns its `AudioContext`, since there is no shared audio primitive to reuse.
- **On/off:** it starts only after a user gesture (the island's Start card), and the on/off state lives in the island config.

### 6. Where Home shows it

**Recommended:** an **`island` DataView view type** contributed by `island/web` (`DataView.View`;
`data-view/plugins/map` is the precedent). `app-cards` passes
`views={["island", "icons", "table"]}`. The view switcher, per-view state and search come free:
a search dims the buildings that don't match, and the camera flies to the best match.

- **Its rows** are `AppRow`, so the view is installedApp-specific. It registers with an
  `appliesTo: installedApp` guard, or equivalent, so other DataViews never offer it.
- **Full-bleed:** Home's `homeRootPane` hides its "Apps" title and chrome while the island view is
  active, so the map fills the tab.

The alternative, a Home-level mode switch instead of a DataView view, is an open question below.

## Size and demo

- **Download:** ~140 KB gzip (prototype measure), all deferred. It loads when Home opens, not at boot.
- **Demo:** about +1–1.5% on the ~11 MB browser demo if Home's island is in its composition. No image or audio assets: everything is drawn and synthesised.
- **Device cost is the real one.** The tile cache is ~60 MPx, about 120 MB of canvas memory at 142 apps. Cap it lower on the demo and on mobile (the cap is a renderer option).

## Phases

1. **`world` + `buildings` (kit) + `characters` in `core`.** Port from the prototype and type it.
   bun tests cover:
   - same seed and apps → identical world;
   - adding an app never moves another;
   - no overlaps at 14, 40 and 142 apps;
   - A* stays on land;
   - every footprint is honoured.
2. **`renderer` + `IslandView` as a DataView view, main thread only.**
   - It works with the kit buildings alone.
   - `plots` is in the same phase, since persistence is needed before shipping.
3. **Bespoke buildings.** One `island-building` sub-plugin per app (the 14 painters from
   `buildings-a.js` and `buildings-b.js`).
4. **Music, sfx, time of day, labels band, usage-driven life.**
5. **Workers for bakes and painters.** Add `dev` exhibits (count slider, fake apps) for reviewing growth.

## Verification

- `./equin test plugins/apps/plugins/home/plugins/island`: the world invariants above, plus the footprint test.
- `./equin build`, then:
  - `screenshot.ts --path /home` at 1280×800 and 1700×1600;
  - day and night, via the config override;
  - click a building and confirm the app opens.
- An e2e flow at `island/e2e/`:
  - Start → arrow walk → E opens the app;
  - hover glow on a building;
  - drag a building, reload, and it stays put;
  - add a fake app (dev exhibit) and confirm no other building moved.
- `leak-test.ts` on open/leave Home ×10, since tile canvases must be freed.
- Pixel compare against the prototype with `compare-diff.ts --name proto-1794374690-9xmb84`
  (needs `<meta name="mocks" content="/home">` on the prototype).

## Open questions

- **Replace or add:** is the island Home's default, or a view next to the grid? This plan assumes a DataView view and leaves the default open.
- **Where bespoke buildings live:** in each app's plugin (recommended, ownership like icons) or centralised in `island/buildings` (simpler, but Home would name apps).
- **Category:** add `category` to `AppRef` (recommended), or keep it island-local in the building contribution.
