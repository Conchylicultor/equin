# Image viewer — one full-screen viewer for every image in the app

Mockup: `proto-1789076199-mqjb` (Image viewer). Its options pill shows the
alternatives to each decision listed at the end. The defaults are the chosen
design.

## Context

When you click an image in a conversation, it grows to at most 80% of the
screen height, inside the transcript. A large screenshot (say 2560 × 1600)
never reaches real size, so small text in it can't be read. The Read tool's
image even starts large, so your first click makes it *smaller*.

Across the app, images behave in three different ways:

- **Four transcript renderers each hand-roll the same toggle.** Clicking
  switches between a thumbnail and the 80vh inline version:
  - pasted user images
  - images inside a user message
  - attached files
  - Read tool images
- **Page image blocks and pasted-attachment chips use `Lightbox`.** It opens a
  full-screen overlay, but only fits the image to the screen: no zoom, no pan.
- **Some images do nothing when clicked:** markdown images, the file-preview
  pane, and image diffs.

**What we want:** click any image to open one shared viewer, the way Slack,
Discord, ChatGPT, Google Photos and macOS Quick Look work.

1. The image opens fitted to the screen.
2. Clicking it shows it at 100%, at the spot you clicked.
3. Scrolling or pinching zooms, and dragging pans.
4. ← / → steps through the other images in the conversation.
5. Esc closes it.

## The interaction (validated in the mockup)

**Inline in the transcript:**
- Every image is a capped thumbnail, at most ~240px tall.
- The whole image always shows: it shrinks along whichever axis hits the cap
  first. (Tall images used to show only their top part, fading out; that
  cropped and enlarged narrow images, so it was dropped on 2026-09-15.)
- Tiny images (e.g. a 32px icon) show at real size on a checkerboard tile.
- On hover, a badge shows the image size (e.g. `2560 × 1600`) plus an expand icon.
- Clicking opens the viewer. Nothing expands inline any more.

**Opening and closing:**
- The image grows out of its thumbnail onto a dark backdrop, and shrinks back
  into it on close.
- Clicking the backdrop closes the viewer, unless you're zoomed in.

**Fit:**
- "Fit" means the whole image fits in the space left around the floating
  controls.
- It never enlarges an image beyond its real size.

**Clicking the image:**
- It switches between fit and a closer view. The spot you clicked stays under
  the pointer.
- The closer view is 100% if the fitted image was shrunk below 80%.
- Otherwise (an icon, say), it's a whole-number enlargement from 2× to 8×, so
  pixels stay square.
- Above 100%, pixels render as crisp squares, not blurred.

**Zooming and panning:**
- A trackpad pinch or ⌘-scroll zooms around the pointer.
- The plain mouse wheel zooms too.
- When zoomed in, dragging pans. The image can't be dragged off screen.
- Two fingers pinch on touch screens.

**Controls on screen:**
- Top left: where the image came from (`Read` / `Pasted` / `Markdown` / …), the
  file name, and its size.
- Top right: open original, copy image, download, the counter `2 / 5`, and close.
- Bottom centre: `− 62% +  |  Fit  1:1  |  ⌨`. The keyboard button shows a
  shortcut sheet.
- ‹ › arrows on the sides.
- A minimap in the bottom-right when the zoomed image is larger than the screen.
  Drag it to move around.
- The controls fade after 2s without mouse movement while zoomed. Moving the
  mouse brings them back.

**Keys:** Esc closes (it closes the shortcut sheet first if that's open).
`+` / `−` zoom, `0` fits, `1` goes to 100%, `←` / `→` change image, `⌘C`
copies the image, `?` toggles the shortcut sheet.

## Design

### Where it lives

`plugins/primitives/plugins/overlay/plugins/image-viewer/`, a new plugin with a
`core/` and a `web/` barrel.

Why there:
- The `overlay` umbrella exists to answer "what floats above the page".
- It is nested, not a new top-level primitive.
- An umbrella folder adds no import edge of its own.
- It must not go under `css/**`: that folder's allowlist would silently exempt
  it from the layout lint.

Imports are checked, and there's no cycle:
- **It imports:** `css/viewport-overlay`, `css/ui-kit`, `css/{pin,center,coords,…}`,
  `icon-button`, `overlay/tooltip`, `shortcuts` (only the label formatter),
  `dom/element-size`, `scope/scoped-store` and `announce`.
- **None of those import:** `text-editor`, `paste-images`, `page` or `conversations`.

Pan and zoom are hand-written (~150 lines, ported from the mockup) rather than
using `react-zoom-pan-pinch`. The behaviour already works in the mockup, and it
has rules a library would fight:
- "fit" leaves room for the controls and never enlarges
- clicking zooms at the click point
- `+` / `−` step through fixed zoom levels
- the image grows out of its thumbnail
- the minimap

It also adds no dependency, and the maths is unit-testable.

### Public API (`web/index.ts`)

```ts
export interface ViewerImage {
  src: string;                  // data:, blob:, or a URL
  name: string;                 // shown in the top bar; the download filename
  sourceLabel?: string;         // "Read" | "Pasted" | "Markdown" | "Attached" …
  alt?: string;
  width?: number; height?: number; // natural size if known, else measured on load
}

/** Every thumbnail inside it joins one gallery for ← / →, in the order the
 *  thumbnails appear on the page. Renders the viewer while it is open. */
export function ImageGallery(p: { children: ReactNode }): JSX.Element;

/** The inline thumbnail: capped size (whole image, never cropped), tiny shape, hover badge, opens the viewer. */
export function ViewerThumbnail(p: { image: ViewerImage; size?: "inline" | "chip" }): JSX.Element;

/** For callers that keep their own <img> (e.g. the resizable page image block).
 *  Throws outside an <ImageGallery>: a hook cannot render the viewer. */
export function useImageViewerTrigger<T extends HTMLElement>(image: ViewerImage):
  { ref: RefCallback<T>; onClick: MouseEventHandler<T>; "aria-haspopup": "dialog" };

/** Controlled viewer, for callers that don't render thumbnails (mail HTML). */
export function ImageViewer(p: {
  images: readonly ViewerImage[]; index: number;
  onIndexChange(i: number): void; onClose(): void;
  originOf?: (i: number) => Element | null;   // where the open/close animation starts and ends
}): JSX.Element;
```

- **A `ViewerThumbnail` outside any `ImageGallery` is a gallery of one**: it
  wraps itself in one, so task descriptions and composer chips get the viewer
  with no ← / → and no extra wiring. `useImageViewerTrigger` throws outside a
  gallery instead, so the page image block renders its own `<ImageGallery>`.
- **Every viewer renders inside its opener's React tree; there is no app-root
  host.** The viewer is portaled to `<body>`, but its React events still bubble
  through the opener's ancestors. A pasted-image chip sits in editors hosted by
  Base UI popovers (Improve, launch agent), whose dismiss logic counts a press
  as inside only when it bubbles through the popup's React tree. A viewer
  rendered from `Core.Root` would close the popover on every click.
- **Copy / download / open aren't passed in.** A `core/` helper,
  `imageCapabilities(src)`, works them out from the image's address:
  - `data:`, `blob:` and same-origin images can be copied and downloaded.
  - Other sites' images only get "Open original".
  - Copy re-encodes to PNG, because that's what the clipboard accepts.
  - "Open original" turns a `data:` image into a `blob:` URL first, because
    browsers refuse to open `data:` URLs in a new tab.
- **No imperative `openImageViewer()`.** Every place that opens it is a
  component, and it needs the thumbnail element for the grow-out animation.

### Gallery

- `ImageGallery` holds one scoped store (`defineScopedStore`): the registered
  images (image + element, by key) and which one is open.
- Order is page order (`compareDocumentPosition`), recomputed whenever an image
  appears or disappears.
- The open image is tracked by key, so the `2 / 5` counter stays right when new
  images stream into the conversation.
- `JsonlPane` (`jsonl-viewer/web/components/jsonl-pane.tsx`) wraps the
  transcript in `<ImageGallery>`. It does **not** wrap the prompt composer, so
  images you've pasted but not sent aren't in the gallery.
- Two panes open on the same conversation get two independent galleries.
- The transcript isn't virtualized, so every mounted image is in the gallery.
  One gap: a collapsed tool card doesn't render its body, so its image is
  skipped until expanded. Read and attached-image cards start open.

### Internals

- **The maths lives in `core/internal/view-model.ts`, as pure functions with a
  `.test.ts` next to it:**
  - `fitScale`: never above 1, leaves room for the controls.
  - `clampView`: centres a small image, keeps a large one from being dragged
    off screen.
  - `zoomAt`: keeps the point under the pointer fixed.
  - `detailScale`: 100%, or 2–8× for small images.
  - `stepScale`: the fixed zoom levels for `+` / `−`.
  - `minimapRect`, and `thumbnailShape` (normal / tiny).
- **One `VIEWER_KEYS` table** drives the key handler, the shortcut sheet, and
  each button's tooltip, so they can't disagree.
- **Drag and wheel don't re-render React.** The image's position and zoom are
  written straight onto the element through a ref, and the image is placed with
  `coords`' `placedClasses`. The readouts (zoom %, which button is pressed) read
  the state through the store's selector.
- **Keyboard stays inside the viewer.** An `onKeyDown` on the focused viewer
  calls `stopPropagation`. The global shortcut manager listens on `window`
  (`shortcut-manager.tsx:76`), and the viewer is rendered straight into `body`.
  So stopping the event there keeps app-wide shortcuts, like Esc leaving solo
  mode, from also firing.
  - The shortcut registry can't express "only this overlay gets keys while it's
    open", which is why the viewer doesn't register there.
- **Focus:**
  - The viewer takes focus when it opens, and Tab cycles through its buttons only.
  - On close, focus returns to the thumbnail of the image being viewed at close.
- **Motion:**
  - With reduced motion turned on, it fades instead of growing out of the thumbnail.
  - Closing keeps the viewer on screen until the shrink-back animation ends.
- **Loading:** until the image's size is known, the viewer shows `Loading`, not
  a guessed fit.
- **Buttons and feedback:**
  - Buttons are `IconButton`s, so an async copy shows its own pending state.
  - Copy feedback is a small pill inside the viewer plus `announce()` for
    screen readers. A primitive doesn't import `shell/toast`.

## Migration

| Where | Becomes |
|---|---|
| `jsonl-viewer/plugins/user-image/…/user-image-row.tsx` | `<ViewerThumbnail sourceLabel="Pasted">`. The expand toggle is deleted |
| `jsonl-viewer/plugins/user-text/…/user-text-row.tsx` (`InlineImage`) | `<ViewerThumbnail>` |
| `jsonl-viewer/plugins/attachment/plugins/attached-file/…/attached-file-view.tsx` (`AttachedImage`) | `<ViewerThumbnail sourceLabel="Attached">` |
| `jsonl-viewer/plugins/tool-call/plugins/read/…/read-image-view.tsx` | `<ViewerThumbnail sourceLabel="Read">`. The "keep tiny images pixelated" logic moves into the thumbnail |
| `conversation-view/plugins/markdown-extensions/…/img-enhancer.tsx` | Both `<img>` branches become `<ViewerThumbnail sourceLabel="Markdown">` |
| `jsonl-viewer/web/components/jsonl-pane.tsx` | Wraps the transcript in `<ImageGallery>` |
| `page/plugins/image/…/image-block.tsx` | `useImageViewerTrigger` on its resizable `<img>` |
| `paste-images/…/attachment-thumbnail.tsx` | `<ViewerThumbnail size="chip">` + its existing Remove button |
| `paste-images/…/lightbox.tsx` | **Deleted**, and removed from the `paste-images` barrel |

Later phases:
- **Phase 2:**
  - the file-preview pane image
  - the image diff in `diff-view`
  - the read-only page image
  - task attachments, which open a new browser tab today
- **Phase 3:** mail. Its images are inside injected HTML, so it needs one click
  listener on the message container that feeds the controlled `<ImageViewer>`.

Don't wire it into:
- the screenshot crop/draw canvas
- page covers
- wallpapers
- favicons and logos
- bookmark cards (the whole card is a link)
- gallery-card covers
- tiny table image cells

## Phase 1 steps

1. Create the `image-viewer` plugin: the `core/` maths and its tests, then the
   `web/` pieces (`ImageViewer`, `ImageGallery`, `ViewerThumbnail`,
   `useImageViewerTrigger`).
2. Add `<ImageGallery>` in `JsonlPane`. Migrate the four transcript renderers
   and `img-enhancer`.
3. Migrate `AttachmentThumbnail` and `image-block`, then delete `Lightbox`.
4. Write each plugin's CLAUDE.md prose. Its tables are regenerated by `./equin build`.

## Verification

- `./equin test plugins/primitives/plugins/overlay/plugins/image-viewer`:
  - The maths: fit never above 1, the clicked point stays fixed, dragging
    can't lose the image, 100% vs 2–8× for small images, `+` / `−` stepping,
    and the minimap rectangle.
  - The gallery: images come out in page order, and the current image stays
    right while new ones appear.
- `./equin check` passes: type-check, layout/spacing/z-index lint,
  plugin boundaries, docs in sync.
- `./equin build`, then an e2e script at
  `plugins/primitives/plugins/overlay/plugins/image-viewer/e2e/viewer-verify.ts`.
  Open a conversation that has a Read-tool screenshot, click the thumbnail, and
  check:
  - The viewer opens fitted, and the zoom readout is below 100%.
  - Clicking the image shows 100%, and the minimap appears.
  - Dragging moves the image.
  - `→` goes to the next image and the counter changes.
  - `Esc` closes it, and focus is back on the thumbnail.
  - Esc does **not** also trigger an app shortcut (check with solo mode on).
- Screenshot the conversation view, before and after, with `screenshot.ts`.

## Decisions (confirmed by the user, 2026-09-11)

The mockup's options pill shows each alternative.

1. **Plain mouse wheel zooms.** That suits mouse users. Pinch and ⌘-scroll
   zoom too. The "wheel pans" variant is not built.
2. **Side arrows** move between images. No filmstrip.
3. **Markdown images in assistant replies become thumbnails**, the same ~240px
   thumbnail as every other image, not full width.
4. **The viewer covers the whole browser window**, rail and tab bar included.
   It renders through `ViewportOverlay`, not `SurfaceOverlay`.

Deferred: v1's ← / → covers only the images currently on screen, so collapsed
tool cards are skipped. Covering every image in the conversation's events
would need a new "list your images" hook that each transcript renderer
implements.
