# Image viewer — thumbnail strip, grid view, slideshow

## Context

The user asked for three additions to the full-window image viewer
(`plugins/primitives/plugins/overlay/plugins/image-viewer`). They iterated on the
design in prototype `proto-1789076199-mqjb` ("Image viewer") and approved it
("looks good. Implement"). It came up while browsing a folder of photos in the
Files app (`primitives/file-viewer/image` → `ImageViewer` over `useFolderImages`),
where stepping one by one through dozens of photos is slow.

1. **Thumbnail strip** (toolbar toggle): keep the single-image view and dock every
   image as a thumbnail band along the bottom edge. The current image is ringed,
   and a click jumps to that image.
2. **Grid** (toolbar toggle): every image as tiles. While the grid shows, the
   zoom controls become a **tile-size slider**. A click (or Enter) opens a tile
   in the single view.
3. **Slideshow** (top-bar button): browser full screen with **no controls at
   all**. The image sits edge to edge on black. ← / → or a click advance, and Esc
   (handled by the browser) leaves.

The original design doc is `research/2026-09-11-primitives-image-viewer.md`.
Nothing in it changes except the layout and inset model below.

## Design

### Viewer state (one store, no new contexts)

Extend `ViewState` (`web/internal/view-store.ts`):

```ts
layout: "single" | "grid";
strip: boolean;      // the user's strip preference (applies in "single" only)
slideshow: boolean;  // mirrors document.fullscreenElement === viewer root
tile: number;        // grid tile min-width, px
```

The strip preference and the tile size are device-local preferences. They are
seeded at mount, and written on change, through `persistent-draft`'s
`readDraft` / `writeDraft`, so the strip stays on across opens. `layout` and
`slideshow` reset on every open.

### Geometry: insets follow the layout (core, pure, tested)

`viewerArea(stage, opts)` in `core/internal/view-model.ts` currently takes
`{ navigable }`. It becomes
`{ navigable, strip: boolean, chrome: boolean }`:

- `chrome: false` (slideshow) → every inset is 0. The image fits the whole
  screen.
- `strip: true` → `bottom = INSETS.bottom + STRIP_HEIGHT` (export
  `STRIP_HEIGHT = 84` from core, so the CSS band and the inset share one
  constant).

The controller keeps the last measured stage `Size`. A new `relayout(animate)`
recomputes the area from the stage and the current flags, then calls
`settle()`. `setStrip`, `setLayout` and `setSlideshow` patch their flag and call
`relayout`. Toggling the strip animates: the image refits into the room above
the band. `settle()` already re-fits a fitted image and re-clamps a zoomed one.

A new pure module, `core/internal/grid.ts`, holds `TILE_MIN = 96`,
`TILE_MAX = 420`, `TILE_DEFAULT = 200`, `clampTile`, `stepTile(px, dir)` (×1.25 /
×0.8) and `gridMove(index, key, columns, count)` (←/→ ±1, ↑/↓ ±columns,
clamped). It ships with unit tests next to `view-model.test.ts`.

### Keys (one table, as today)

The new rows go in `core/internal/keys.ts` `VIEWER_KEYS`: `toggle-strip` (S),
`toggle-grid` (G), `slideshow` (F). A grid-only `open-selected` (Enter) and
`row-up` / `row-down` (↑ / ↓) are matched only while the grid shows. The table
gains an optional `in?: "single" | "grid"` field. `matchViewerKey(e, layout)`
filters on it, and the sheet lists grid rows under their own heading. In the
grid, `zoom-in` / `zoom-out` (+ / −) step the tile size, `previous` / `next`
move the selection, and fit / actual-size do nothing. In slideshow, only
previous / next / slideshow / copy / Esc act. Tests extend `keys.test.ts`.

### Components (`web/components/`)

- **`viewer-strip.tsx` — `ThumbnailStrip`**: a band `Pin`ned to the bottom edge,
  full width, `STRIP_HEIGHT` tall, on the same translucent `PANEL` surface with a
  top border. It scrolls horizontally and is centred when it has room (auto
  margins on the first and last child). Each image is a button holding an
  `<img loading="lazy" decoding="async">`, object-cover. Tiny images get
  object-contain and pixelated rendering, using `thumbnailShape` from core.
  The current one is ringed with the accent colour, and `useRevealOnActive`
  (`primitives/dom/scroll-reveal`) keeps it in view. It does not join the idle
  fade: a docked band that disappears would leave an empty strip of screen.
- **`viewer-grid.tsx` — `ImageGrid`**: a scroll layer under the top bar. It uses
  `grid-template-columns: repeat(auto-fill, minmax(min(var(--tile),100%),1fr))`
  and lays a solid `bg-background` layer behind the tiles, so the page does not
  bleed through. Each tile is a 4:3 box with object-contain (a tall image gets
  object-cover anchored at the top), and the checkerboard tile for images with
  transparency. The caption (name and size) hides below 140px. The selected tile
  is ringed and is the roving tab stop. ⌘-scroll or pinch on the grid resizes the
  tiles; a plain scroll scrolls it. `gridColumns()` reads the computed
  `grid-template-columns` for ↑ / ↓.
- **`viewer-chrome.tsx`**:
  - `TopBar` gets a **Slideshow** `IconButton` (`symbol("slideshow")`, tooltip
    from the key table) beside Close.
  - `BottomBar` leads with two `aria-pressed` toggles when `count > 1`:
    **Thumbnail strip** (`symbol("view-carousel")`) and **Grid**
    (`symbol("grid-view")`), then a separator. In the grid it swaps the zoom
    group for a `Slider` (`primitives/css/slider`, `min=TILE_MIN max=TILE_MAX
    step=4`, `aria-label="Thumbnail size"`) between small / large IconButtons.
  - `BottomBar`, `Minimap` and the `NavArrows` lift above the band by
    `STRIP_HEIGHT` when the strip shows. `NavArrows` and `Minimap` hide in the
    grid.
- **`image-viewer.tsx`**:
  - Renders `ThumbnailStrip` / `ImageGrid` from the store flags, and hides the
    stage while the grid shows.
  - `data-chrome="hidden"` also when `slideshow` is on. The backdrop turns solid
    black and the image drops its shadow.
  - **Full screen**: the button and F call `requestFullscreen()` on the viewer
    root. A `fullscreenchange` listener drives `ctl.setSlideshow(...)`, so Esc
    leaving full screen through the browser stays in sync. When full screen
    isn't allowed (`document.fullscreenEnabled` false, or the request rejects),
    the existing status pill says so — the only expected rejection, handled
    specifically. Entering it from the grid switches to the single view first.
    Closing the viewer exits full screen.
  - Selection in the grid is the caller's `index` (`onIndexChange`), so there is
    no second "current" anywhere. Grid selection skips the swap fade, because
    the stage is hidden.
  - Closing from the grid fades (no shrink-back): `beginClose` treats
    `layout === "grid"` as having nowhere to shrink back to.
- **`stage-gestures.ts`**: the dismiss callback becomes `onClick()`, which the
  frame resolves: in slideshow a click on an unzoomed image advances, wrapping
  to the first; otherwise it dismisses as today.

The strip and the grid are a fixed, prop-supplied image list inside an overlay —
transient chrome like a tab strip, not domain records — so they map with
`// eslint-disable-next-line data-view/no-adhoc-row-list -- viewer chrome over the
caller's image list` rather than becoming a DataView.

### Docs

- Update the image-viewer `CLAUDE.md` intro and the description in
  `web/index.ts` to cover the strip, grid and slideshow.
- Update `VIEWER_GESTURES` with "Click (slideshow): next image".

## Known limits (stated, not solved here)

> Update: the thumbnail limit below is solved by
> `research/2026-10-07-primitives-image-viewer-fast-large-folders.md`
> (resized copies from `infra/host-fs/image`).

- Thumbnails are the full images, loaded lazily. No thumbnail service exists. A
  folder of hundreds of large JPEGs in the grid decodes what scrolls into view.
  `loading="lazy"` and `content-visibility: auto` on tiles bound the cost to the
  visible window. A server-side thumbnail endpoint would be its own task.
- The slideshow does not advance on a timer; the user asked only that the
  controls be hidden. A timer can be added later.

## Files

- `core/internal/view-model.ts` (+ test): `viewerArea` opts, `STRIP_HEIGHT`
- `core/internal/grid.ts` (+ test): new
- `core/internal/keys.ts` (+ test): new actions, `in` field, layout-aware match
- `core/index.ts`: exports
- `web/internal/view-store.ts`, `web/internal/view-controller.ts`: flags,
  `relayout`, setters
- `web/internal/stage-gestures.ts`: click resolver
- `web/components/image-viewer.tsx`, `viewer-chrome.tsx`: wiring, buttons,
  slider, slideshow
- `web/components/viewer-strip.tsx`, `viewer-grid.tsx`: new
- `e2e/viewer-verify.ts`: extend
- `CLAUDE.md`, `web/index.ts` description

## Verification

1. `./equin test plugins/primitives/plugins/overlay/plugins/image-viewer`:
   unit tests for `viewerArea` (strip inset, slideshow zero insets), `grid.ts`,
   and key matching per layout; the existing `image-gallery.test.tsx` stays
   green.
2. `./equin build` (backgrounded).
3. Extend `e2e/viewer-verify.ts`: open a folder image in Files and
   - toggle the strip and assert the band, the ringed current image, and that
     the image refit smaller;
   - toggle the grid and assert the tiles and the slider; drag the slider and
     assert the column count drops; press ← / ↓ / Enter and assert the selected
     image opens in the single view;
   - press F: in headless, assert either a fullscreen element or the "not
     allowed" status, and that `data-chrome="hidden"` once in full screen.
   Take screenshots of each state with `screenshot.ts`.
4. Manual: the user checks the slideshow in a real browser window, since
   headless full screen is not representative.
