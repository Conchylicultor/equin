# image-viewer

One full-window viewer for every image in the app. Click an image: it grows out
of its thumbnail, fitted to the window. Click it again to close; scroll or pinch
to zoom, drag to pan (a click on a zoomed image goes back to fit), ← / → for the
other images, Esc to close. Design and decisions: `research/2026-09-11-primitives-image-viewer.md`.

With more than one image, the toolbar offers two more views
(`research/2026-10-07-primitives-image-viewer-strip-grid-slideshow.md`):

- **Thumbnail strip** (S) — every image docked as a band along the bottom edge,
  the current one ringed. The image refits into the room above it: the band's
  height is `STRIP_HEIGHT` (`core/`), which is also the bottom inset
  `viewerArea` takes for `chrome: "bars-and-strip"`, so the two cannot disagree.
- **Grid** (G) — every image as tiles; the zoom controls become a tile-size
  slider (+ / −, ⌘-scroll or pinch too). ← → ↑ ↓ move the selection, Enter or a
  click opens it. The selection *is* the caller's `index`: there is no second
  "current image".

**Slideshow** (F, top bar) is the browser's full screen on the viewer itself,
with no controls at all: the image edge to edge on black (`chrome: "none"`),
← / → or a click to step (looping), Esc — the browser's — to leave. The viewer
mirrors `fullscreenchange` rather than tracking it, so leaving by any route
brings the controls back. A refused request (a frame without `allowfullscreen`)
says so in the status pill.

The strip choice and the tile size are device-local preferences
(`web/internal/view-prefs.ts`, via `persistent-draft`); the grid and the
slideshow start fresh on every open.

## Which piece to use

| You have | Use |
|---|---|
| An image to show inline (a transcript image, an attachment chip) | `<ViewerThumbnail image={…}>` — `size="chip"` for the compact 64px form |
| Your own `<img>` that must stay yours (a resizable page image block) | `useImageViewerTrigger(image)`, spread onto that `<img>`, inside an `<ImageGallery>` you render (it throws outside one) |
| Images with no thumbnails of your own (mail HTML) | `<ImageViewer images index onIndexChange onClose originOf>`, controlled |
| A region whose images belong together (a conversation transcript) | wrap it in `<ImageGallery>` |
| Your own `<img>` that should fail the way a thumbnail does | `useImageLoad(src)` for its state, `<MissingImage>` while it is `failed` |
| An image cropped to fill a box (a page cover) | the same, with `<MissingImage size="fill">` |
| The outcome before you choose a layout (an image diff: added / deleted / side by side) | `useImageProbe(src)` — the same states, loaded off-DOM |

An image that does not load is never the browser's broken-image glyph. `ViewerThumbnail`
renders `<MissingImage>` instead: a fixed box (the thumbnail's size, not the alt text's)
with the name middle-truncated and the reason. An `<img>`'s error event cannot say why,
so `useImageLoad` asks the source once (`probeUrlStatus`, networking): 404 or 410 is
**gone** ("No longer available" — an agent's screenshot in a cleaned-up temp dir, an
attachment whose file left the disk), anything else is **unreadable** ("Couldn't load ·
Retry"). With no `<img>` mounted the image also leaves its gallery, so ← / → skip it.

`ViewerImage` is `{ src, name, sourceLabel?, alt?, width?, height?, resized? }`. `name` is the
top-bar title and the download's file name; `sourceLabel` is the small chip before
it (`"Read"`, `"Pasted"`, `"Markdown"`, `"Attached"`). Pass `width` / `height` when
you know them — otherwise they are measured on load.

## Large images: copies, and swaps that never go blank

`resized(edge)` is the caller's way to offer smaller copies of an image (the
Files app gives every host photo one, from `infra/host-fs/image`). The viewer
then never draws a 30-megapixel original where a copy will do
(`web/internal/pick-src.ts`):

- **Strip and grid** tiles ask for a copy at their own size (`ThumbImg`); a grid
  tile's request only grows, by powers of two, while the grid is open.
- **The stage** draws a copy fitted to the window, but only when `width` /
  `height` are known — fit, 1:1 and the zoom % are computed from the
  original's size. A zoom past the copy's pixels swaps in a larger copy (or the
  original), decoded first, in the same box.
- **A step (← / →, a strip or grid pick, the slideshow)** never fades. The next
  image is loaded and decoded (`web/internal/decoded-cache.ts`), and only then
  replaces the current one, in one frame; the old one stays up meanwhile, with a
  spinner after 150 ms. The neighbours (both sides, plus one further in the
  direction of travel) are decoded ahead, so a step is normally instant.
- A copy that fails to load (the server could not make one) falls back to
  `src`; `src` stays the original for copy / download / open.

**Grid resize** (slider, + / −, ⌘-scroll, pinch) renders no tile: the grid
writes `--tile` straight onto its element from a store subscription, tiles are
memoized, captions are a container query, wheel factors are applied once a
frame, the tile under the pointer (or the selected one) keeps its place on
screen, and the preference is saved once the change settles.

A `ViewerThumbnail`'s `children` are painted over it, outside its open button —
that is where an attachment chip's Remove button goes (`<Pin>` it to a corner; the
thumbnail is the hover-reveal group, so `hoverRevealTargetWithGroupFocus` reveals
it).

## Every viewer renders inside its opener's React tree

Inside an `<ImageGallery>`, every thumbnail joins it, in page order
(`compareDocumentPosition`), and the open image is tracked by key — so images
streaming in around it never change which one is open. The gallery renders the
viewer as its own child. A `ViewerThumbnail` outside any gallery wraps itself in
one — a gallery of one, no arrows, no counter. `useImageViewerTrigger` cannot
render, so it throws outside a gallery: its caller renders one.

There is deliberately no app-root host. The viewer is portaled to `<body>`, but
its React events still bubble through the opener's ancestors — which is how a
popover around a pasted-image chip (Base UI's dismiss logic) counts a click in
the viewer as inside itself instead of closing. A viewer rendered from
`Core.Root` would dismiss the popover underneath on every click.

Copy / download / "Open original" are never passed in. `imageCapabilities(src)`
(`core/`) derives them from the address: `data:`, `blob:` and same-origin images get
all three, another site's image only "Open original".

## Keyboard isolation

The viewer's root takes focus on open, keeps Tab on its own buttons, and returns
focus to the thumbnail on close. Its `onKeyDown` stops every keydown from
propagating: the global shortcut manager listens on `window`, and the viewer is
portaled into `<body>`, so without that Esc would also leave solo mode (and ⌘K
would open the palette underneath). The shortcut registry cannot express "only
this overlay gets keys while it is open", which is why the viewer does not
register there. Every key lives in one `VIEWER_KEYS` table (`core/`) that the key
handler, the `?` sheet and the button tooltips all read.

## Internals worth knowing

- A drag or wheel zoom renders no React: the view lives in a scoped store that a
  subscription writes straight onto the `<img>`; readouts subscribe to their slice
  with `useSelector`. The geometry is pure, in `core/internal/view-model.ts`.
- The chrome is always dark: the viewer's box carries the theme's own `.dark` token
  block by class, since there is no scoped color-mode primitive yet.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: One full-screen image viewer for every image in the app: ViewerThumbnail (the capped inline thumbnail that always shows the whole image, with a tiny-icon shape and a size badge) and useImageViewerTrigger (for callers that keep their own <img>) open it; an image that does not load shows MissingImage (its name, and whether the file is gone or only unreadable, with Retry) and leaves the gallery — useImageLoad gives a caller with its own <img> the same load state, and useImageProbe answers it off-DOM for a caller that must know before it renders; ImageGallery makes every thumbnail inside one ← / → set in page order and renders the viewer inside its own React tree; ImageViewer is the controlled viewer itself — fit, click-to-close, wheel/pinch zoom, drag pan, minimap, copy/download/open, a docked thumbnail strip, a grid of every image with a tile-size slider, a control-less full-screen slideshow, keyboard-isolated. A ViewerThumbnail outside any gallery is its own gallery of one; useImageViewerTrigger requires one.
- Web:
  - Uses: 46 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×6
    - `primitives/persistent-draft` ×3
    - `primitives/css/clip` ×2
    - `primitives/css/coords` ×2
    - `primitives/css/rigid` ×2
    - `primitives/css/spacing` ×2
    - `primitives/hover-reveal` ×2
    - `primitives/announce.announce`
    - `primitives/css/badge.Badge`
    - `primitives/css/center.Center`
    - `primitives/css/fill.Fill`
    - `primitives/css/grid.Grid`
    - `primitives/css/layer.Layer`
    - `primitives/css/line.Line`
    - `primitives/css/pin.Pin`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/slider.Slider`
    - `primitives/css/text.Text`
    - `primitives/css/viewport-overlay.ViewportOverlay`
    - `primitives/css/yield.yieldClass`
    - `primitives/dom/auto-scroll.keepInPlace`
    - `primitives/dom/element-size.useResizeObserver`
    - `primitives/dom/scroll-reveal.useRevealOnActive`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/link-gesture/new-tab.NewTabButton`
    - `primitives/loading.Loading`
    - `primitives/networking.probeUrlStatus`
    - `primitives/overlay/tooltip.Kbd`
    - `primitives/scope/scoped-store.defineScopedStore`
    - `primitives/shortcuts.formatShortcutLabel`
    - `ui/icons.Icon`
  - Exports (types):
    - `ImageFailure`
    - `ImageLoad`
    - `ImageLoadState`
    - `ImageProbeState`
    - `ImageViewerProps`
    - `ImageViewerTrigger`
    - `MissingImageProps`
    - `ViewerImage`
    - `ViewerThumbnailProps`
  - Exports (values):
    - `ImageGallery`
    - `ImageViewer`
    - `MissingImage`
    - `useImageLoad`
    - `useImageProbe`
    - `useImageViewerTrigger`
    - `ViewerThumbnail`
- Cross-plugin:
  - Uses tokens: 24 vars — full list in [REFERENCE.md](./REFERENCE.md)
    - `ui/tokens/color-palette` ×9
    - `ui/tokens/density` ×6
    - `ui/tokens/shadow` ×3
    - `ui/tokens/type-scale` ×3
    - `ui/tokens/shape` ×2
    - `ui/tokens/font-family --font-mono`
  - Imported by:
    - `apps/pages/page-tree`
    - `conversations/conversation-view/artifacts/screenshot`
    - `conversations/conversation-view/jsonl-viewer`
    - `conversations/conversation-view/jsonl-viewer/attachment/attached-file`
    - `conversations/conversation-view/jsonl-viewer/tool-call/read`
    - `conversations/conversation-view/jsonl-viewer/user-image`
    - `conversations/conversation-view/jsonl-viewer/user-text`
    - `conversations/conversation-view/markdown-extensions`
    - `debug/browser-recordings`
    - `page/bookmark`
    - `page/image`
    - `page/read-only-view`
    - `primitives/diff-view`
    - `primitives/file-viewer/image`
    - `primitives/text-editor/paste-images`
    - `tasks/task-attachments`
- Core:
  - Exports (types):
    - `Area`
    - `GridMove`
    - `ImageCapabilities`
    - `KeyInput`
    - `Minimap`
    - `OpenVia`
    - `Rect`
    - `Size`
    - `ThumbnailShape`
    - `View`
    - `ViewerAction`
    - `ViewerChrome`
    - `ViewerKey`
    - `ViewerMode`
    - `WheelInput`
  - Exports (values):
    - `areaCenter`
    - `centerOn`
    - `clampTile`
    - `clampView`
    - `COMPACT_BELOW`
    - `dataUriToBlob`
    - `dataUriType`
    - `DRAG_THRESHOLD`
    - `extensionLength`
    - `fitScale`
    - `fitView`
    - `gridMove`
    - `imageCapabilities`
    - `isAtScale`
    - `isZoomed`
    - `matchViewerKey`
    - `MAX_SCALE`
    - `MINIMAP_BOX`
    - `minimapRect`
    - `overflows`
    - `panView`
    - `splitForMiddleTruncate`
    - `stepScale`
    - `stepTile`
    - `STRIP_HEIGHT`
    - `thumbnailShape`
    - `TILE_CAPTION_MIN`
    - `TILE_DEFAULT`
    - `TILE_MAX`
    - `TILE_MIN`
    - `VIEWER_GESTURES`
    - `VIEWER_KEYS`
    - `viewerArea`
    - `viewerKey`
    - `viewOverRect`
    - `wheelZoomFactor`
    - `ZOOM_LADDER`
    - `zoomAt`

<!-- AUTOGENERATED:END -->
