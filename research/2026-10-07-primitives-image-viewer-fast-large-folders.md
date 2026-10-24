# Image viewer — fast on folders of large photos

## Context

The image viewer (`plugins/primitives/plugins/overlay/plugins/image-viewer`) feels
slow on a folder of camera photos in the Files app. The test folder is 176 JPEGs
at 4480×6720 (30 MP each), in `~/Downloads/…/Fête de famille 23-24 juillet
2022/1 - Portraits sous le Wellingtonia`. The strip, grid and slideshow were just
added (`research/2026-10-07-primitives-image-viewer-strip-grid-slideshow.md`),
which listed "no thumbnail service" as a known limit.

What is slow:

1. **Grid and strip.** Every tile loads and decodes the ORIGINAL file, because no
   smaller copy of a host image exists. Grid tiles stay blank for seconds, and a
   Playwright screenshot of the grid times out after 10 s.
2. **Slideshow, and ← / → in general.** A step fades through black: `SWAP_MS`
   fade-out, then the next 30 MP image loads and decodes, then it fades in.
3. **Grid zoom** (the slider, ⌘-scroll, + / −) is janky. Every tick re-renders
   the whole viewer and all 176 tiles, writes localStorage, and re-lays out
   30 MP images.

**User decisions:** resize with **sharp** (libvips). The swap is **instant
everywhere**, single view included. The **grid zoom must be smooth**.

Outcome: the grid shows its tiles at once, and the strip does too. ← / → and the
slideshow swap with no dark frame. Resizing the grid is fluid.

## Design

### 1. Server: resized copies and image sizes (new `infra/host-fs/plugins/image`)

This is a new sub-plugin of host-fs. Host-fs stays the one host-path API, and
the native sharp dependency stays out of host-fs's own barrel. Its
`package.json` adds `sharp`.

**`GET /api/host-fs/image/resized?path&edge&v`** is a raw handler, like `raw`:

- It returns the image scaled so its long edge is `edge`, never enlarged, and
  rotated by its EXIF orientation (`sharp(...).rotate().resize({ width: edge,
  height: edge, fit: "inside", withoutEnlargement: true })`). An opaque image is
  encoded as JPEG q82. One with alpha is encoded as WebP, so it keeps its
  transparency.
- `edge` must be one of `RESIZED_EDGES = [160, 320, 640, 1280, 2560]`, declared
  in core. Anything else is a 400. This keeps the cache small and bounded.
- `v` is `${mtimeMs}-${size}`, taken from the listing. Because the URL changes
  whenever the file changes, the response is served with
  `Cache-Control: private, max-age=31536000, immutable`. A revisit then comes
  from the browser cache with no request at all. It also carries the same inert
  headers as `raw` (factor `inertHeaders` out of `raw.ts` and export it from the
  host-fs server barrel).
- **Disk cache:** `<data-dir>/<sha256(path|mtimeMs|size|edge)>.{jpg,webp}`. The
  data dir is host-scoped and shared by every worktree, declared in the plugin's
  `data-dirs/`. It is written to a tmp file and renamed into place. Concurrent
  requests for one key share a single build (`packages/inflight`
  `createInflight`). Builds are bounded by a host-admission pool
  (`infra/host/host-admission`), so a grid of 40 tiles cannot take over the
  box. A cache hit updates the file's atime.
- **Archive members** (`…/x.zip/a.jpg`) are read with `openArchiveMember` into a
  buffer, then resized the same way.
- **Failures are statuses**, mirroring `raw`: 404, 403, 400 (not a file), and
  **415** when sharp cannot decode the file (HEIC without libheif, a corrupt
  file). The client then falls back to the original (see §2).
- **Sweep:** a daily job removes entries not used for 30 days, and keeps the
  directory under 1 GB, oldest-atime first. This mirrors youtube
  `audio-fetch`'s sweep.

**`GET /api/host-fs/image/sizes?path=<dir>`** (`hostFsImageSizes`,
`implement()`) answers `ok { images: { name, size: {kind:"known", width,
height} | {kind:"unreadable"} }[] }`, or `missing` / `denied` / `not-a-dir`. It
reads only the file headers (`sharp(file).metadata()`), with width and height
swapped for EXIF orientations 5–8. The answer is cached in memory per
`(path, mtimeMs, size)`. The viewer needs these true sizes: the stage now shows
a smaller copy, but fit, 1:1 and the zoom % are computed from the original's
size. The grid captions and the minimap need them too.

**Core** (`infra/host-fs/plugins/image/core`) holds the contracts,
`RESIZED_EDGES`, `snapEdge(px)` (the smallest bucket ≥ px, else the largest),
and `hostResizedUrl(path, edge, version)`. Unit tests cover `snapEdge`.

### 2. Viewer contract: an optional resized source

`ViewerImage` (`web/internal/types.ts`) gains:

```ts
/** A same-image URL whose long edge is at least `edge` px (snapped up by the
 *  provider), for thumbnails and the fitted stage. Omitted: always `src`. */
resized?: (edge: number) => string;
```

The viewer stays domain-neutral and never names host-fs. `src` stays the
original, so copy, download and open are unchanged.
`file-viewer/image/web/internal/use-folder-images.ts` provides `resized` for
`source: "host"` raster files (not SVG), using the listing's `mtimeMs`/`size` as
`v`. It also adds `width`/`height` from `hostFsImageSizes`, read with one
`useEndpoint` per folder. Git files have no `resized`, so their behaviour is
unchanged.

One web helper in the viewer, `pickSrc(image, edgePx)`, returns `src` when
there is no `resized`, or when the image's known long edge ≤ `edgePx`.
Otherwise it returns `resized(edgePx)`. A `<img>` that errors on a resized URL
retries once with `src`. This is a specific fallback for the 415 case, and the
original then reports its own error as today.

### 3. Grid and strip use the small copies

- **Strip** (`viewer-strip.tsx`): `pickSrc(image, 80 × dpr)`, which snaps to the
  160 bucket.
- **Grid** (`viewer-grid.tsx`): `pickSrc(image, tile × dpr)`. The edge only ever
  grows during one grid session (the largest edge used so far), so dragging the
  slider down never re-fetches. Growing past a bucket swaps `src`, and the
  browser keeps the old bitmap on screen until the new one is decoded.
- Tiles keep `loading="lazy"` and gain `content-visibility: auto` with a
  `contain-intrinsic-size` derived from `--tile`. Only on-screen tiles are
  requested, laid out and decoded.
- With known sizes, tiles get their real aspect for the tall/tiny decisions,
  and captions show the true size.

### 4. Instant swap (single view and slideshow)

This replaces the `shown`-trails-`current` fade in `image-viewer.tsx`
(`SWAP_MS`, `imageVisible: false` on swap):

- **Stage source.** The stage `<img>` shows `pickSrc(image, fittedLongEdge ×
  dpr)`, normally the 1280 or 2560 copy. Its box is still sized to the
  original's natural size (from `width`/`height`), so the zoom math does not
  change. When a zoom needs more pixels than the copy has (`scale × naturalLong
  × dpr > edge`), the stage preloads the original. It swaps `src` once
  `decode()` resolves, in the same element box, so nothing flashes.
- **Decode, then swap.** A new `web/internal/decoded-cache.ts` is a small LRU
  (about 6 entries) of `HTMLImageElement`s keyed by URL. Its `load(url)` returns
  the `img.decode()` promise and keeps the element referenced so its bitmap stays
  warm. On an index change, the viewer calls `load(stageUrl(next))`. The
  current image stays on screen at full opacity until it resolves. The viewer
  then commits `shown` in one frame, with no opacity change and no fade. If the
  decode takes longer than 150 ms, the existing spinner shows over the old image.
  Rapid presses land on whichever image is current when a decode resolves.
  Stale results are dropped.
- **Preload neighbours.** Once an image is shown, the viewer `load`s index ± 1,
  plus + 2 in the direction of travel, so the slideshow wraps from last to first
  warm. With 2560-edge copies, a decode takes a few ms and the next press paints
  in the same frame.
- Remove `SWAP_MS` and the swap's `imageVisible` toggling. `imageVisible` stays
  for the open and close animations only.
- A missing size (`width`/`height` unknown, such as for git files) keeps
  today's path: measure the image on load, with the stage showing `src`.

### 5. Smooth grid zoom

- **No React work per tick.** The tile size goes into the store at frame rate,
  but only `ImageGrid` subscribes to it. It writes `--tile` on the grid element
  imperatively, in a store subscription, the way the stage writer already writes
  its transform. `GridTile` is `memo`ized with stable callbacks (index-keyed
  `onSelect`/`onOpen` from one `useEventCallback`), so a resize re-renders zero
  tiles. Captions become a CSS container query on the tile (`@container
  (min-width: 140px)`) instead of a `captions` prop. The bucket edge (§3) is the
  only tile-derived prop, and it changes at most 5 times.
- **Coalesce input.** ⌘-scroll and pinch accumulate their factor and apply it
  once per animation frame. The slider is the same. `clampTile` stops rounding
  to whole pixels while a gesture is under way, so small deltas are not lost.
- **Keep the user's place.** Before applying a new size, record the anchor tile's
  viewport offset: the tile under the pointer for the wheel, the selected tile
  for the slider and + / −. After the reflow (in the same frame), adjust
  `scrollTop` so that tile stays put.
- **Persist on settle.** `writeViewPrefs` is debounced: it runs on gesture end
  or idle, and on close, not on every tick.

### Docs

- Add the new sub-plugin's `CLAUDE.md`, with the endpoint table, cache and sweep.
  Add one row to host-fs's `CLAUDE.md` pointing at it.
- In the image-viewer `CLAUDE.md`, document the `resized` contract and the
  decode-then-swap model. Drop the "no thumbnail service" limit from the earlier
  plan's "Known limits" (as a note in that doc).

## Files

- New: `plugins/infra/plugins/host-fs/plugins/image/{core,server,data-dirs}/…`,
  `package.json` (sharp), and `CLAUDE.md`.
- `plugins/infra/plugins/host-fs/server/internal/raw.ts`: export `inertHeaders`
  through the server barrel.
- `plugins/primitives/plugins/file-viewer/plugins/image/web/internal/use-folder-images.ts`:
  add `resized` and the sizes.
- `plugins/primitives/plugins/file-viewer/plugins/image/web/components/image-view.tsx`:
  the Files preview itself uses `pickSrc` at its box size, so opening a 30 MP
  photo's preview no longer decodes the original.
- Viewer: `web/internal/types.ts`, new `web/internal/pick-src.ts`, new
  `web/internal/decoded-cache.ts`, `web/components/image-viewer.tsx`,
  `viewer-grid.tsx`, `viewer-strip.tsx`, `web/internal/view-controller.ts`
  (fractional tile, coalescing), `core/internal/grid.ts`, `web/index.ts` (export
  `pickSrc` for the preview).

## Risks

- **sharp under Bun.** sharp is N-API, and Bun supports it with prebuilt
  `@img/sharp-*` binaries. The first build step checks that it loads in the
  server process. If it does not, I will stop and report rather than work around
  it.
- **HEIC and RAW** are not resized by the prebuilt sharp. They return 415 and
  fall back to the original, which is today's behaviour.

## Verification

- `./equin test plugins/infra/plugins/host-fs/plugins/image` covers
  `snapEdge`, and resizing a fixture JPEG: the long edge, EXIF rotation, a cache
  hit on the second call, a new key after an mtime change, a 415 on garbage, and
  an archive member.
- `./equin test plugins/primitives/plugins/overlay/plugins/image-viewer`
  covers the existing tests, `pickSrc`, and the decoded-cache LRU and stale
  drop.
- Extend `e2e/views-verify.ts`, and run it with `--file` on the 176-photo
  folder after `./equin build`. It checks that:
  - the grid's visible tiles all load within 2 s on a cold cache, and the grid
    screenshot succeeds;
  - every tile and strip request hits `/api/host-fs/image/resized`, never
    `/raw`;
  - with neighbours preloaded, the stage image never has opacity < 1 between
    ← / → steps, and the time from keypress to the new `src` being painted is
    under 100 ms, in the single view and in the slideshow;
  - ⌘-scroll resizing the grid keeps the anchor tile within a few px of its
    viewport position, and the frame times are logged.
- Check by eye in the Files app on that folder (screenshot via `screenshot.ts`).
