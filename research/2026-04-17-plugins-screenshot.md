---
date: 2026-04-17
category: plugins
status: proposed
---

# Screenshot plugin

## Context

Singularity needs a quick way to grab a screenshot of the current page and immediately open it in a lightweight in-app editor (crop + freehand annotation) so users can copy / save the result. This is a top-level plugin contributing a button to the **Shell.Toolbar** (the global app toolbar, not the per-conversation toolbar). When clicked, it captures the current viewport DOM, copies the PNG to the system clipboard, and opens a **new browser tab** at `/screenshot/:id` with the captured image as the main view and a side pane with tools.

## High-level flow

1. User clicks the **Screenshot** button in the global toolbar.
2. Frontend captures the current document via `html-to-image` → PNG `Blob`.
3. Frontend writes the PNG to the system clipboard (`navigator.clipboard.write`).
4. Frontend `POST /api/screenshots` with the PNG body → server returns `{ id }`.
5. Frontend calls `window.open('/screenshot/' + id, '_blank')` → real new browser tab.
6. The new tab boots the SPA, the `Shell.Route` `/screenshot/:id` resolves and renders `ScreenshotView`, which fetches `GET /api/screenshots/:id` and renders the editor.

The new tab is a fresh app boot, so the screenshot **must** live on the server (closure / in-memory state in the original tab is not visible to the new tab). v1 stores blobs in an in-process `Map<string, Buffer>` keyed by id — ephemeral across server restarts, which is fine since the user opens the new tab immediately.

## Architecture

New top-level plugin: `plugins/screenshot/` with `web/` and `server/`. No DB, no resources, no slots/commands defined for others.

```
plugins/screenshot/
├── package.json                       # @singularity/plugin-screenshot
├── web/
│   ├── index.ts                       # PluginDefinition: Shell.Toolbar + Shell.Route
│   ├── package.json                   # depends on html-to-image
│   ├── views.tsx                      # screenshotPane(id) factory
│   └── components/
│       ├── screenshot-button.tsx      # toolbar button: capture → clipboard → open tab
│       ├── screenshot-view.tsx        # main view: image area + tools side pane
│       ├── tools-pane.tsx             # right side pane (Crop / Draw / actions)
│       ├── crop-overlay.tsx           # drag-rect overlay over image
│       └── draw-overlay.tsx           # canvas overlay capturing pen strokes
└── server/
    ├── index.ts                       # ServerPluginDefinition + routes
    └── internal/
        ├── store.ts                   # in-memory Map<id, Buffer>
        ├── handle-create.ts           # POST /api/screenshots
        └── handle-get.ts              # GET /api/screenshots/:id
```

## Files to modify

- `web/src/plugins.ts` — import `screenshotPlugin from "@plugins/screenshot/web"` and append to the `plugins` array.
- `server/src/plugins.ts` — import `screenshotPlugin from "@plugins/screenshot/server"` and append to the `plugins` array.

That's it for wiring — the plugin slots into the existing `Shell.Toolbar` and `Shell.Route` infra without touching anything else.

## Implementation details

### Frontend

**`web/index.ts`** — mirrors `plugins/build/web/index.ts`. Two contributions:

```ts
import type { PluginDefinition } from "@core";
import { Shell } from "@plugins/shell/web/slots";
import { ScreenshotButton } from "./components/screenshot-button";
import { screenshotPane } from "./views";

const screenshotPlugin: PluginDefinition = {
  id: "screenshot",
  name: "Screenshot",
  description: "Capture the current page and edit it in-app.",
  contributions: [
    Shell.Toolbar({ component: ScreenshotButton, group: "actions" }),
    Shell.Route({
      pattern: "/screenshot/:id",
      resolve: (params) => screenshotPane({ id: params.id! }),
    }),
  ],
};
export default screenshotPlugin;
```

**`web/views.tsx`** — small factory like `welcome/views.tsx`:

```ts
import type { PaneDescriptor } from "@plugins/shell/web/commands";
import { ScreenshotView } from "./components/screenshot-view";

export function screenshotPane({ id }: { id: string }): PaneDescriptor {
  const Component = () => <ScreenshotView id={id} />;
  return { title: "Screenshot", component: Component, path: `/screenshot/${id}` };
}
```

**`web/components/screenshot-button.tsx`** — modelled on `BuildButton`. Uses `html-to-image`'s `toBlob(document.documentElement)` to capture the current viewport. On success: copy to clipboard, POST to backend, open new tab. Wrap in `try/catch` and surface failures via `Shell.Toast`.

```ts
const blob = await toBlob(document.documentElement, { pixelRatio: window.devicePixelRatio });
await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
const res = await fetch("/api/screenshots", { method: "POST", body: blob, headers: { "content-type": "image/png" } });
const { id } = await res.json();
window.open(`/screenshot/${id}`, "_blank", "noopener");
```

Notes:
- The button itself is part of `document.documentElement`, so it will appear in the screenshot. Acceptable for v1 — the user can crop it out. If we want to hide it, we can add a CSS class `.screenshot-hide` to the toolbar host briefly, with `filter: html-to-image filter` excluding elements with that class.
- `navigator.clipboard.write` requires a user gesture (we have one — the click) and a secure context. `localhost` qualifies.

**`web/components/screenshot-view.tsx`** — the main route view. Layout:

```
┌──────────────────────────────────────────────────────┬──────────────┐
│                                                      │  Tools pane  │
│             <image + active overlay>                 │              │
│                                                      │              │
└──────────────────────────────────────────────────────┴──────────────┘
```

Implementation: a flex row, image area on the left (`flex-1`, dark bg, centered image), `ToolsPane` on the right (~280px). Use plain CSS rather than `react-resizable-panels` for v1 simplicity (the conversation-view uses it, but we don't need resizing here).

State (in `ScreenshotView`):
- `imageBlob: Blob | null` — the current edited image (starts as the fetched original).
- `tool: 'none' | 'crop' | 'draw'`
- Tool-local state lives in the overlay components.

On mount: `fetch('/api/screenshots/' + id)` → blob → `imageBlob`.

`Apply` from a tool flattens its overlay onto the image (via an offscreen `<canvas>`) and replaces `imageBlob`. `Reset` re-fetches the original from the server.

**`tools-pane.tsx`** — three sections stacked vertically:

1. **Tool selector** — three buttons: None / Crop / Draw (mutually exclusive).
2. **Tool options** — depends on `tool`:
   - Crop: "Apply" + "Cancel" buttons (disabled until a rectangle is drawn).
   - Draw: color swatches (4 fixed colors), width slider (1–12), "Apply" + "Clear" + "Undo".
3. **Actions** — always visible at the bottom: "Copy" (writes current image to clipboard via Clipboard API), "Download" (anchor `download="screenshot.png"` on a fresh `URL.createObjectURL(imageBlob)`), "Reset to original".

**`crop-overlay.tsx`** — absolutely-positioned div over the image. Mouse-down starts a rectangle; mouse-move updates; mouse-up locks. Renders the rectangle with a translucent fill outside the selection (4-rect "vignette" trick) and a solid border. Exposes the chosen rect (in image coordinates) to the parent. On Apply, parent draws the rect region to a new canvas and re-encodes as blob.

**`draw-overlay.tsx`** — full-image-sized `<canvas>`. Listens to pointer events; uses `getContext('2d').lineTo / stroke` to draw paths. Keeps an array of strokes (for Undo / Clear). On Apply, parent composites image + canvas pixels onto a new canvas and re-encodes as blob.

Both overlays receive the displayed image's natural size and rendered size to map mouse coordinates to image pixel coordinates (so the edit always operates on the original-resolution image, not the displayed scaled-down view).

### Backend

**`server/index.ts`** — flat plugin definition like `plugins/build/server/index.ts`:

```ts
import type { ServerPluginDefinition } from "../../../server/src/types";
import { handleCreate } from "./internal/handle-create";
import { handleGet } from "./internal/handle-get";

const plugin: ServerPluginDefinition = {
  id: "screenshot",
  name: "Screenshot",
  httpRoutes: {
    "POST /api/screenshots": handleCreate,
    "GET /api/screenshots/:id": handleGet,
  },
};
export default plugin;
```

**`server/internal/store.ts`** — module-scoped `Map<string, { png: Buffer; createdAt: number }>`. Helpers `put(buf): id` and `get(id): Buffer | null`. `id` is `crypto.randomUUID()`. A trivial cleanup: when `put` is called, drop entries older than 1 hour to keep memory bounded.

**`handle-create.ts`** — read `req.arrayBuffer()`, validate `content-type === "image/png"`, store, return `Response.json({ id })`.

**`handle-get.ts`** — second arg is `params: { id: string }` (per the route-matching contract in `server/CLAUDE.md`). Look up in the store; return `new Response(buf, { headers: { "content-type": "image/png" } })` or `new Response(null, { status: 404 })`.

### Dependencies

- `web/`-only addition: `html-to-image` in `plugins/screenshot/web/package.json`. Single dep (~30KB), MIT, well-maintained, returns a real `Blob`. (Mature alternative `html2canvas` is heavier and quirkier; `snapdom` is faster but newer/less battle-tested. Sticking with `html-to-image`.)
- No backend deps — everything uses Bun stdlib + `crypto.randomUUID()`.
- `bun install` from the repo root after editing the package.json (workspaces will pick it up).

## Caveats / known v1 limitations

- **Ephemeral storage.** Server restarts (i.e. `./equin build`) drop all stored screenshots. The new-tab flow only opens immediately after capture, so this is fine; revisiting an old `/screenshot/:id` URL will 404. Acceptable for v1; can swap to disk-backed in a follow-up.
- **The toolbar appears in the screenshot.** We're capturing the whole document. Users can crop it out. We could mask it later with a `data-screenshot-ignore` attribute + filter; not worth the complexity in v1.
- **No iframe content.** `html-to-image` cannot reach into cross-origin iframes (the proxied worktree apps). Out of scope for v1; the user explicitly chose DOM capture over `getDisplayMedia`.
- **No undo across applies.** Each Apply bakes into the image. Reset re-fetches the original. Per-tool undo (e.g. stroke history) lives only in the active draw session.

## Verification

1. `./equin build` — deploys both the web bundle and the server plugin.
2. Open `http://<worktree>.localhost:9000`.
3. Confirm the Screenshot button appears in the top toolbar (in the `actions` group, next to Build).
4. Click it. Expected:
   - A toast or no error (button briefly disabled while capturing).
   - The PNG is on the clipboard — paste into any other app to confirm.
   - A new browser tab opens at `http://<worktree>.localhost:9000/screenshot/<uuid>` showing the screenshot image with the tools pane on the right.
5. In the screenshot view:
   - Click **Crop**, drag a rectangle, click **Apply** → the image is replaced with the cropped region.
   - Click **Draw**, pick a color/size, scribble on the image, click **Apply** → the strokes are baked in.
   - Click **Copy** → confirm the (modified) image lands on the clipboard.
   - Click **Download** → a `screenshot.png` is saved.
   - Click **Reset** → original image returns.
6. Hit `Cmd-Shift-R` on the screenshot tab to confirm the route + GET endpoint works on a cold reload.
7. Optional: scripted check via `e2e/screenshot.mjs` — click the Screenshot button and capture a before/after of the toolbar to confirm wiring.
