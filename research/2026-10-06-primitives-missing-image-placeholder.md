# Missing-image placeholder in the image-viewer primitive

## Context

Agents save screenshots in temp folders, and those folders get cleaned up. When a transcript is reopened, a Read-tool image (or an artifact screenshot, or a markdown image) points at a file that no longer exists. `ViewerThumbnail` already records `measure.kind === "failed"` but renders nothing different. The result is the browser's broken-image glyph squeezed around the alt text. Each tile gets a different size and the grid turns ragged. The broken thumbnail is still a zoom target and still a member of the gallery's ← / → set.

Prototype: `proto-1791259381-356q`. The user picked the defaults: `style: tile` and `grid: each` (one placeholder per missing image, nothing collapsed).

Goal: one placeholder, owned by the image-viewer primitive, that every image surface gets automatically.

## Design

### 1. A load-state hook: `useImageLoad(src)` (web/internal)

Replaces the ad-hoc `Measure` state in `viewer-thumbnail.tsx`.

```ts
type ImageLoad =
  | { kind: "pending" }
  | { kind: "loaded"; size: Size }
  | { kind: "failed"; reason: "probing" | "gone" | "unreadable" };
```

It returns `{ load, imgProps: { onLoad, onError, key }, retry }`.

- **On error**, the hook probes `src` once with `fetch(src, { cache: "no-store" })` and cancels the body. It sends no HEAD request, since the handlers don't promise to serve HEAD. The reason comes from the probe:
  - **404 / 410** → `gone`. The host-fs raw and code image endpoints return 404 for a missing file. The attachments endpoint returns 410 when the file is missing on disk.
  - **Anything else** → `unreadable`. That covers a thrown fetch (offline, CORS on an external URL), a 5xx, a 403/415/413, an ok response that would not decode, and a corrupt `data:` / `blob:` URI.
  - **`data:` / `blob:` sources** are never probed: they go straight to `unreadable`.
  - **`probing`** renders exactly like `gone` minus its sub-line, so the box never flashes.
- **`retry()`** bumps a nonce that is used as the `<img>`'s `key` (remounting it) and returns to `pending`. It is offered only for `unreadable`: a gone file stays gone.
- The probe result is guarded against a `src` change and an unmount (generation counter), so a stale answer never lands.

### 2. The placeholder: `<MissingImage>` (web/components, exported)

It takes `name`, `reason`, `onRetry?` and `size: "inline" | "chip"`.

- **A fixed box, never sized by text.**
  - Inline: `w-56 h-32`, capped by `max-w-full`.
  - Chip: `h-16 w-24`, matching the chip thumbnail's `max-h-16`.
  - Dashed `border-border` on `bg-muted`, `rounded-md`, `text-muted-foreground`.
- **Content, centred:**
  - The `hide-image` symbol (a valid Material Symbols name, unused elsewhere). `unreadable` uses `broken-image` in the warning tone.
  - The name, middle-truncated.
  - The sub-line: "No longer available" for `gone`, "Couldn't load · Retry" for `unreadable`. The sub-line is hidden in the chip size.
- **Accessibility and tooltip:** `role="img"`, `aria-label="Image unavailable: <name>"`, and a tooltip (`WithTooltip`) with `alt ?? name`.
- **No zoom cursor and no button wrapper.** The Retry is a small ghost `Button`.
- **Middle truncation** is a two-span flex: the head truncates (`min-w-0`, ellipsis) and the last ~10 characters stay fixed (`shrink-0`). The split lives in a pure helper in `core/` (`splitForMiddleTruncate(name, tail)`) with a unit test. It is local to this plugin, since there is no middle-truncate primitive yet and only one consumer.

### 3. `ViewerThumbnail` uses both

- While `load.kind === "failed"`, it renders `<MissingImage>` instead of the `<button><img/></button>`, still inside the same outer `span`, so `children` (the composer chip's Remove button) still paint over it. A broken attachment can be removed.
- No `<img>` means `attach` gets `null`, so the member leaves the gallery automatically. It is out of ← / → and `open` is a no-op. Nothing new is needed in `gallery-store`.
  - Edge case: the viewer is open on an image that then fails. The viewer already renders its own "Couldn't load this image." for that.
  - Verify that `image-gallery.tsx` tolerates an `openKey` whose member left. If it doesn't, the store's leave should clear `openKey` when it removes the open member.

### 4. The page image block (the one `useImageViewerTrigger` caller)

`plugins/page/plugins/image/web/components/image-block.tsx` owns its `<img>`. It uses the exported `useImageLoad` + `<MissingImage>` the same way: while failed, it renders the placeholder in place of the `<img>` and keeps the Remove pin. The page block was the only surface that needed a call-site edit. The other 7 `ViewerThumbnail` sites need none:

- the Read tool
- the composer chip
- the attached-file card
- the user-text image
- the user-image row
- markdown images
- artifact screenshots

### Out of scope (listed, not done)

- **Raw `<img>` sites that bypass the viewer.** These are task attachments, read-only page blocks, the file-viewer image tab and image diffs. Done in `research/2026-10-06-primitives-raw-img-missing-image.md`.
- **The root cause:** temp screenshots being read from a temp dir. The fix is to copy Read-tool images into attachments when the transcript records them (task).

## Files

- `plugins/primitives/plugins/overlay/plugins/image-viewer/web/internal/use-image-load.ts` (new)
- `plugins/primitives/plugins/overlay/plugins/image-viewer/web/components/missing-image.tsx` (new)
- `plugins/primitives/plugins/overlay/plugins/image-viewer/core/internal/view-model.ts`: `splitForMiddleTruncate` (+ test)
- `.../web/components/viewer-thumbnail.tsx`: use the hook and the placeholder
- `.../web/index.ts`: export `MissingImage` and `useImageLoad`
- `.../CLAUDE.md`: a "missing image" row in the "Which piece to use" table
- `plugins/page/plugins/image/web/components/image-block.tsx`

## Verification

- **`web/__tests__/image-gallery.test.tsx`:**
  - `fireEvent.error` on a thumbnail's `<img>` with `fetch` mocked to 404 shows "No longer available", and there is no "View image x" button.
  - In a gallery of a, b, c with b failed, ← / → from a goes to c.
  - With `fetch` mocked to 500, "Couldn't load" appears, and Retry brings the `<img>` back.
- `./equin test plugins/primitives/plugins/overlay/plugins/image-viewer`
- `./equin build`, then screenshot the conversation from the user's report (`/agents/c/conv-1790333977-xoi5`) to see the placeholder on the deleted scratchpad screenshots.
