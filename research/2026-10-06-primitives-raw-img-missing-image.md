# Route the remaining raw `<img>` surfaces through the missing-image handling

## Context

`research/2026-10-06-primitives-missing-image-placeholder.md` gave the image-viewer primitive one failure state. `useImageLoad(src)` probes once and reports `gone` (404/410) or `unreadable`, and `<MissingImage>` is the fixed-size placeholder. `ViewerThumbnail` and the editable page image block use both. That plan left out the surfaces that draw their own raw `<img>`. When their file disappears they still show the browser's broken-image glyph around the alt text. Some of them also stay zoom targets.

This plan:
- moves the surfaces where the image *is* the content onto the viewer;
- gives every content-addressed image a failure state.

## Which surfaces get which treatment

"Should this open the viewer?" can't be detected from syntax: a page cover and a figure are both `<img src={attachmentUrl(id)}>`. "Is this image served from an address that can disappear, and does anything handle its failure?" can be detected exactly. So the decision about the viewer is made here, by hand.

| Surface | Treatment |
|---|---|
| Task attachments (`tasks/task-attachments/web/components/task-attachments.tsx`) | **`ViewerThumbnail`** in one `<ImageGallery>`, so ← / → step through the task's images. `name: a.filename`, `sourceLabel: "Attached"`. The `<a target=_blank>` wrapper goes away (the viewer has "Open original"). |
| Read-only page image block (`page/read-only-view/web/components/read-only-blocks.tsx`) | **Viewer**, same as the editable block: `<ImageGallery>` + `useImageViewerTrigger` + `useImageLoad`, and `<MissingImage>` while failed. It keeps its own `<img>` so the stored `width` is honoured. |
| File viewer image tab (`primitives/file-viewer/image/web/components/image-view.tsx`) | Already opens the viewer. Adds `useImageLoad` and renders `<MissingImage>` while failed: no zoom cursor, no click, `originOf` gets `null`. The pixelated-small-image `onLoad` logic composes with `imgProps.onLoad`. |
| Image diff (`primitives/diff-view/web/components/image-diff-view.tsx`) | Its private `useImageStatus` (`new Image()`, any error counted as "missing") is replaced by an exported **`useImageProbe(src)`** that uses the same classification. A side that is `gone` still means added or deleted. An `unreadable` side now renders `<MissingImage reason="unreadable" onRetry>` in its panel instead of being misread as "Added". The rendered `<img>`s spread `useImageLoad` so a later failure is handled too. No viewer: it's a comparison view. |
| Page cover (`apps/pages/page-tree/web/components/page-cover.tsx`) | Failure handling only, no viewer (the cover's click is reposition). It shows a `<MissingImage size="fill">` band so the user sees that their cover is gone, and can still change or remove it. |
| Bookmark favicon and preview (`page/bookmark/web/components/bookmark-block.tsx`) | Failure handling only, no viewer (the card opens the link). On failure the image is dropped, which renders the same as the existing "no image" branch. |
| Wallpaper, wallpaper search, prototype thumbnail, website app card, favicons, `/icon.svg`, screenshot editor, the viewer's own stage and minimap, DataView gallery card, image-field cell | Untouched. They aren't content-addressed, or they already handle failure. The gallery card and image-field cell take arbitrary `src` strings (out of scope). |

## Primitive additions (image-viewer)

- **`useImageProbe(src): ImageLoad & { retry }`** (`web/internal/use-image-load.ts`): loads the image off-DOM and returns the same `ImageLoad` union. It shares `failureOf` with `useImageLoad`, so "gone" means the same thing everywhere. It's exported for callers that must know the outcome *before* choosing a layout (the diff).
- **`MissingImage size="fill"`**: fills its parent's box with the same content, for crop-style surfaces (the cover). It's added to the `BOX` record.
- **CLAUDE.md**: new rows for `useImageProbe` and `size="fill"`.

## No lint rule

A rule could detect content-addressed `<img>`s that handle no failure, but not which ones should open the viewer. The user chose to fix the sites and not add a rule.

## Files

- `plugins/primitives/plugins/overlay/plugins/image-viewer/`: `web/internal/use-image-load.ts`, `web/components/missing-image.tsx`, `web/index.ts`, `web/__tests__/image-gallery.test.tsx`, `CLAUDE.md`
- the 6 surface files in the table above
- `research/2026-10-06-primitives-missing-image-placeholder.md`: point its "Out of scope" bullet at this plan

Out of scope: `<video>` / `<audio>` page blocks (same problem, different element), and the gallery card and image-field cell (arbitrary `src`).

## Verification

- `./equin test plugins/primitives/plugins/overlay/plugins/image-viewer`:
  - jsdom: `useImageProbe` gives 404 → `gone` and 500 → `unreadable`.
- `./equin check type-check`.
- `./equin build`, then `screenshot.ts`:
  - a task with an image attachment: the thumbnail opens the viewer;
  - the file viewer on a host path to a deleted `.png`: the "No longer available" box, with no zoom.
