# Isle: the island launcher as its own app (v2)

v2 of `2026-11-13-home-island-gallery.md`. **Change:** the island becomes a separate app next to Home, not a
Home replacement and not a Home DataView view. Home is untouched.

## Context

Prototype `proto-1794374690-9xmb84` (`~/.equin/apps/prototypes/`) is an illustrated JRPG-style
archipelago where every installed app is a building shaped like what it does.

- **Opening an app:** click the building, or walk there (click-walk with A*, or arrow keys) and press E.
- **Atmosphere:** generative lo-fi/ambient music, and the time of day (day, dusk, night).
- **Growth:** new apps get a generated building and are placed append-only; districts fill, then new islands appear, linked by bridges or ferries.

The prototype is ~480 KB of plain JS in globals. This plan makes it an app: `apps/isle` (working
name; id `isle`, basePath `/isle`).

## Principles

1. **Isle owns the world; each app owns its building.** This is the same split as `Apps.App`, where
   each app owns its icon. Isle's code never names an app (collection/consumer separation). An app
   with no contribution gets a generated building, so a new app needs **zero** island code.
2. **The world is pure data.** Island shapes, terrain, districts, plots, placement and pathfinding
   are deterministic functions of (seed, ordered app list, stored plots), in `core/`. They are
   tested with bun:test and need no canvas.
3. **Painters are pure canvas functions, not React.** `paint(g, s)` takes a 2D context, which can be
   on-screen or an OffscreenCanvas. Because they live in `core/`, a worker can run them, which
   removes the prototype's last main-thread hot spot (measuring and baking buildings).
4. **Placement is append-only and stored, never recomputed.** Recomputing would move buildings
   whenever an app is added or removed.
5. **A standalone app, deferred.** Only `isle/plugins/shell` is eager, and it holds just the
   `AppRef` and an entry stub. Everything else is a non-shell sub-plugin, so it is deferred
   (`web-sdk/core/load-tiers.ts`, `isDeferredPluginPath`) and costs nothing at boot.

## Plugin tree

```
plugins/apps/plugins/isle/
  plugins/
    shell/        core: isleApp = defineApp({ id: "isle", name: "Isle", basePath: "/isle",
                          icon: symbol("sailing"), colorMode: "light" })
                  web:  Apps.App entry (full-pane, chromeless like keyboard-party), theme
                        (Isle theme with the sign/map fonts so google-fonts-loader loads them)
    world/        core only — pure, deterministic, tested: island shapes, terrain tags,
                    districts, plot growth, placement, walk grid + A*, label spots
    buildings/    core: Building contract + painting kit (ink, wash, shade, stone, thatch,
                    props) + generated buildings by category
                  web:  slot Isle.Building (per-app contributions)
    characters/   core: hero + villagers painters, walk cycle
    plots/        core: liveCollection `isle.plots` + endpoint contracts
                  server: table + serveCollection + claim / move endpoints
    renderer/     web: the canvas engine: camera, tiles (ground / object layers, water between),
                    bake scheduler (+ worker pool later), hit masks, hover glow, labels,
                    time of day, input (click-walk, keys, E)
    world-view/   web: the pane: <IsleView> (title card, HUD, where-chip, radio, prompt card,
                    accessible link list mirroring the map)
    dev/          exhibits/: count slider, fake apps, regrow — never in the app
plugins/music/plugins/ambient/                        generic generative WebAudio engine
plugins/apps/plugins/<app>/plugins/isle-building/     one per bespoke app (14 today)
```

## The abstractions

### 1. `Isle.Building`: how an app declares its building

The slot is in `isle/buildings/web`; the contract types are in `isle/buildings/core`:

```ts
interface BuildingSpec {
  footprint: { w: number; depth: number };   // declared, not measured → placement is pure
  setting?: Setting;    // "coast" | "cape" | "hill" | "harbour" | "square" | "forest" | "lane"
  signX?: number;
  lights: Light[];                            // night window / lantern glows
  paint(g: Ctx2D, s: PaintState): void;       // static art, cached per time of day
  animate?(g: Ctx2D, s: PaintState): void;    // moving parts
}
interface PaintState { t; night; dusk; open; hue; shade(c, k); rnd(): number }
```

- **Contributing a building.** An app contributes one from its own deferred sub-plugin, keyed by its
  `AppRef`: `Isle.Building({ app: sonataApp, ...musicHall })` in
  `apps/sonata/plugins/isle-building/`. The engine looks it up by `app.id`.
- **Footprint check.** A test in `buildings/core` paints every registered spec on an OffscreenCanvas
  and asserts its alpha bounds fit the declared footprint. This replaces the prototype's ~20 ms
  runtime measurement with data, and the check keeps the data honest.

### 2. Apps without a building get a generated one

- `buildings/core` exports `kitBuilding(app, category, seed)`. It is seeded by the app id, and its
  accents use the app's tile colour (`appTileFill`, from `apps-core/plugins/app-icon/core`).
- **Category.** Add an optional closed-list field `category?: AppCategory` to `AppRef`
  (`primitives/pane/core/route.ts`): `work | create | music | life | data | play | system`.
  - It is plain data in core, and useful elsewhere too: grouping the Home grid, the launcher.
  - The `create-app` skill asks for it.
  - When it is absent, the category is chosen from the id hash.

### 3. Plots: where buildings stand, persisted append-only

The `isle.plots` `liveCollection` (in `plots/core`) holds one row per app:
`{ appId (PK), island, district, plot, x, y, movedByUser, createdAt }`.

- **Read:** with `useLive`. Until it loads, the view renders a loading state, never an empty sea.
- **What goes in `config_v2` instead:** the seed and options (time override, music mood, music on/off), via
  `defineConfig("isle", …)`. Placements stay out of config: they would be a whole-document,
  last-writer-wins blob.
- **When a listed app has no plot:**
  1. The view runs the pure `world.place(…)`.
  2. It calls `POST isle/plots/claim`.
  3. The server runs `INSERT … ON CONFLICT (appId) DO NOTHING`. Two tabs compute the same
     answer, and the first one wins.
- **Drag-and-drop:** `POST isle/plots/move`, then the world re-validates the spot.
- **A removed app:** it leaves an empty lot that the next app that fits reuses.
- **Island shapes** are derived from (seed, island index, its plots); only plots are stored.

### 4. Renderer and view (web)

- **Engine.** It is a class like `map/pin-layer`'s `PinLayer`: it takes a `World`, a building
  lookup and the characters, and draws frames. Kept from the prototype as-is:
  - tiles, with a scaled tile from another zoom standing in until the new one is ready;
  - centre-first baking, at most 3 tiles a frame;
  - per-building alpha hit masks, and the hover glow layer;
  - labels: island names at every zoom out, district names only around the island-fit zoom,
    each fading in or out as a whole, over time rather than with zoom;
  - the time-of-day tint and lights.
- **Workers.** There are none in web plugins today: no vite `?worker` usage, and the request guard
  mentions blob workers.
  - Phase 1 runs on the main thread with stepped bakes (the prototype's fallback path).
  - Workers come later, and may need a small `web-artifacts` addition for worker entries.
- **Data the view reads:**
  - `useListedApps()` (apps-core) gives the residents, and `useActivateApp()(entry)` opens one after
    the iris transition. It is a link, so ⌘-click opens a new browser tab.
  - `useAppUsageSummary()` brings the world to life: recently used apps have lit chimneys and
    villagers about, and apps never opened stay quiet.
- **Time of day** comes from `Date`, with one one-shot timeout to the next phase boundary (no
  polling); config can override it.
- **Signs and fonts:**
  - Sign glyphs are rasterised from the Material Symbols sprite (`ui/icons`).
  - The canvas waits for `document.fonts.load` before drawing text.
- **Accessibility:**
  - A visually hidden list of links mirrors the buildings, for keyboard and screen readers.
  - `prefers-reduced-motion` disables the inertia and the iris.

### 5. Music: `music/plugins/ambient`

- **Why there:** it is generic, so it lives in the music umbrella and not in Isle. It is a port of the
  prototype's `music.js`.
- **API:**
  - `createAmbient(ctx, { mood })` with `start`, `stop`, `duck(on)` and `sfx.{step, blip, enter, whoosh}`;
  - a `useAmbient(mood)` hook, which owns its own `AudioContext` (there is no shared audio
    primitive to reuse).
- **Starting:** music starts only after a user gesture (the Start card).

## Size and demo

- **Download:** about 140 KB gzipped (measured on the prototype), all deferred, and loaded only when
  `/isle` opens. There are no image or audio assets.
- **Demo:** whether Isle is in it is a composition choice. If it is, it adds about 1–1.5% to the
  ~11 MB demo.
- **Device memory is the real cost:** about 60 MPx of tile cache at 142 apps. The cache cap is a
  renderer option, set lower for the demo and on mobile.

## Phases

1. **`world`, `buildings` (kit only), `characters` in core.** Port and type them. bun tests:
   - the same seed and apps give an identical world;
   - adding an app never moves another;
   - no overlaps at 14, 40 and 142 apps;
   - A* stays on land;
   - every footprint is honoured.
2. **`shell`, `plots`, `renderer`, `world-view`.** `/isle` works with kit buildings, persisted.
3. **Bespoke buildings.** One `isle-building` sub-plugin per app, with the 14 painters from
   `buildings-a.js` and `buildings-b.js`.
4. **Music and sfx, time of day, labels, usage-driven life.**
5. **Workers for bakes and painters**, plus the `dev` exhibits for reviewing growth.

## Verification

- `./equin test plugins/apps/plugins/isle`: the world invariants and the footprint test.
- After `./equin build`:
  - `screenshot.ts --path /isle` at 1280×800 and 1700×1600;
  - by day and at night, via the config override;
  - click a building and confirm the app opens.
- An e2e flow in `isle/e2e/`:
  - Start, walk with the arrow keys, E opens the app;
  - hover glow;
  - drag a building, reload, and it stays;
  - add a fake app (dev exhibit) and confirm nothing else moved.
- `leak-test.ts`: open and leave `/isle` 10 times; the tile canvases must be freed.
- `compare-diff.ts --name proto-1794374690-9xmb84` against the prototype. This needs
  `<meta name="mocks" content="/isle">` on the prototype.

## Decisions (were open questions)

- **App name and icon:** "Isle", id `isle`, basePath `/isle`, `symbol("sailing")`; a separate app, Home untouched.
- **Bespoke buildings:** in each app's own plugin (`apps/<app>/plugins/isle-building/`), contributed to
  `Isle.Building` (phase 3). Isle never names an app.
- **Category:** an optional closed-list `category` on `AppRef` (`APP_CATEGORIES` in `primitives/pane/core`),
  set in each app's `shell/core/app.ts`: agent-manager, pages, mail, file-explorer → `work`; studio,
  prototypes → `create`; sonata, chord → `music`; places, events → `life`; browser → `data`;
  keyboard-party → `play`; settings, deploy, debug, desktop → `system`; home, website, demo, menu-bar unset.

## Phase 1 notes (done)

- `world/core`, `buildings/core`, `characters/core` under `apps/isle/plugins/`, pure and tested; plus
  `packages/seeded-random` (`mulberry32`) and `fnv1a32` in `packages/string-hash`.
- **Footprint** is `{ w, depth, ground: Box, upper: Box | null }`: the painted extent below and above the
  ground band (y = −112), as the prototype measured it at runtime. The kit computes it from its plan;
  `buildings/core/testing`'s `paintedExtent` (a measuring 2D context — bun has no canvas) checks it.
- **Signposts:** placement needs the sign's width without measuring text, so it uses `signHalfWidth(name)`
  (≈ 8.4 px a character); the renderer must fit the name to that board.
- **Sign glyph:** `PaintState.glyph(g, cx, cy, size)` draws the app's icon (the renderer rasterises it from
  the sprite), instead of a Material Symbols ligature in `fillText`.
- **Placement state:** `Placement = { plots: by district, occupant: appId → plotId }`; a plot records the
  category it was made for (a district's kind is its first plot's) and a world-wide `seq` (the opening order
  of districts, for their names). Phase 2 maps it onto the `isle.plots` collection.
- **Walk smoothing** checks the segment's supercover rather than sampling it, so a smoothed path never
  clips a blocked cell's corner (the prototype's could).

## Phase 5 notes (done)

- **Page workers in web-artifacts.** A page worker (`new Worker(new URL("./x.worker.ts", import.meta.url))`)
  was already bundled whole by vite's worker pass, but could only inline its own plugin's files. Now every own
  `*.worker.ts(x)` is a worker entry whose Merkle key in the plugin-records module graph joins the artifact's
  address, and whose closure the worker pass's inline audit allows (`own-files.ts`). So a worker may bundle
  other plugins' `core` barrels, and is re-addressed exactly when that code changes. No Blob, no import map.
- **What runs in the bake workers** (`renderer/web/internal/bake.worker.ts`, a pool of up to 4): ground
  tiles' per-pixel colour and water mask, island previews, island shapes and the home carve (built ahead for
  `islandsInPlay` by `useIslandShapes`, restored with `IslandPlan.restore` / `adoptHomeCarve`), each island's
  furniture, and buildings' hit masks (handed over in idle time: handing a canvas over is a readback). The
  workers run the page's own modules, so every bake is bit-identical: `dev/e2e/bake-identity.ts` compares
  217 bakes at 14 apps and 272 at 142 apps (ground, water, previews, finished map tiles' ground and object
  layers, hit masks): all identical. Without Worker / OffscreenCanvas everything bakes on the page.
- **Not in a worker: building paint and the object layer.** A page worker cannot load a module the page
  names at run time, and bespoke painters are `Isle.Building` contributions. The clean route is the browser
  hosts' worker link tree generalised to page workers (each contributor's `core` linked into the build's
  worker tree and loaded by specifier). Meanwhile the engine paints buildings ahead, nearest first, within
  the bake budget.
- **Measured** (`world-view/e2e/perf-sweep.ts`, headless software rendering at 1280×800; the host was shared
  with other agents, so the numbers are noisy):

  | | ready | long tasks before ready | longest | sweep: worst frame |
  | --- | --- | --- | --- | --- |
  | `/isle`, 14 apps, before | 5.7–6.2 s | 20–21, 2.8–2.9 s | 420–480 ms | 83 ms |
  | `/isle`, 14 apps, after | 2.9–3.0 s (5.5 s cold) | 5–6, 0.5–0.6 s (16, 1.6 s cold) | 160–180 ms (320 cold) | 83 ms |
  | exhibit, 142 apps, page | 2.6–7.2 s | 18–43, 1.7–5.1 s | 140–250 ms | 83 ms |
  | exhibit, 142 apps, workers | 2.2–3.4 s | 7–14, 0.7–1.5 s | 130–210 ms | 67–100 ms |

  No long task during a pan / zoom sweep in either mode once ready; the frame interval (p50 17–50 ms) is the
  software rasteriser's cost of a full-screen frame, not bakes. What is left before ready: React's mount, the
  title card's own 70 ms bake budget, and building paint.
