# Draw-on-app feature — v2

## What changed from v1

v1 placed the extracted `DrawCanvas` in `plugins/primitives/`. That was wrong: `primitives/` is for genuinely cross-cutting infra (live-state, networking, pane router, tree). A draw canvas is screenshot/annotation-specific. v2 turns `plugins/screenshot/` into an **umbrella** with sub-plugins, matching the pattern already used by `plugins/conversations/` and `plugins/infra/`.

## Context

(Same as v1 — short version.) Today, marking up a screenshot and feeding it to `+improve` requires a multi-step path: capture → annotate in screenshot pane → copy → open improve → manually attach. The new feature is a one-shot "Draw on app" toolbar button that mounts a fullscreen draw overlay, captures via `domToBlob`, uploads, and pre-attaches the result to the improve popover.

While doing this, we extract the existing `DrawOverlay` component out of `screenshot/web/components/` so the new flow can reuse it without reaching into another plugin's internals.

## Approach

Three changes, in dependency order:

1. **Promote `screenshot` to an umbrella.** Add `plugins/screenshot/plugins/`. Existing `screenshot` parent keeps its current toolbar button + capture-and-edit pane unchanged.
2. **New sub-plugin `screenshot/plugins/draw-canvas/`** — owns the reusable `DrawCanvas` component and `applyStrokes` helper, lifted out of `screenshot/web/components/`. Pure refactor.
3. **New sub-plugin `screenshot/plugins/draw-on-app/`** — toolbar button that mounts the live-draw overlay, captures, uploads, and dispatches `Improve.OpenWithAttachments`.

Plus the small `improve` change: a new command + handler for "open the popover with these attachments already attached".

The capture mechanism is unchanged from v1: drawing happens in a `<canvas>` inside `document.documentElement`, so `domToBlob` bakes strokes in automatically. Floating tools chrome is hidden with `flushSync` + 2 rAFs and additionally filtered via `data-draw-chrome` (belt-and-suspenders).

---

### 1. Umbrella structure

After this change, `plugins/screenshot/` looks like:

```
plugins/screenshot/
├── package.json
├── CLAUDE.md
├── web/                       # unchanged: existing camera button + screenshot pane
│   ├── index.ts
│   ├── panes.ts
│   └── components/
│       ├── screenshot-button.tsx
│       ├── screenshot-view.tsx
│       ├── crop-overlay.tsx          # crop stays here (screenshot-pane-only)
│       ├── tools-pane.tsx
│       └── prompt-form.tsx
│       (draw-overlay.tsx — DELETED, moved into draw-canvas sub-plugin)
├── server/                    # unchanged
└── plugins/
    ├── draw-canvas/
    │   ├── package.json
    │   ├── CLAUDE.md
    │   └── web/
    │       ├── index.ts              # barrel
    │       ├── draw-canvas.tsx       # moved from screenshot/web/components/draw-overlay.tsx
    │       └── apply-strokes.ts      # extracted from screenshot/web/components/screenshot-view.tsx
    └── draw-on-app/
        ├── package.json
        ├── CLAUDE.md
        └── web/
            ├── index.ts
            └── components/
                ├── draw-on-app-button.tsx
                └── live-draw-overlay.tsx
```

The screenshot parent itself stays a normal contributing plugin (camera button + `/screenshot/:id` pane). It's also "the umbrella" — both roles coexist, exactly like `plugins/conversations/` does.

### 2. Sub-plugin: `screenshot/plugins/draw-canvas/`

Files:

- `web/draw-canvas.tsx` — file moved from `plugins/screenshot/web/components/draw-overlay.tsx`. Component renamed `DrawOverlay` → `DrawCanvas` so the name matches the new home (it's not "an overlay on a screenshot", it's "a freehand draw canvas you point at any rect"). Props unchanged.
- `web/apply-strokes.ts` — extracted from `screenshot-view.tsx` (the `applyStrokes` + private helpers `loadImageElement` + `canvasToPng`). `applyCrop` stays in `screenshot/` since it's crop-specific.
- `web/index.ts` — barrel:

  ```ts
  import type { PluginDefinition } from "@core";

  export { DrawCanvas } from "./draw-canvas";
  export type { Stroke, DrawCanvasProps } from "./draw-canvas";
  export { applyStrokes } from "./apply-strokes";

  export default {
    id: "draw-canvas",
    name: "Draw Canvas",
    description: "Reusable freehand draw canvas (color/width strokes). Used by screenshot editor and draw-on-app.",
    contributions: [],
  } satisfies PluginDefinition;
  ```

- `package.json` — workspace package; deps: react.
- `CLAUDE.md` — minimal stub; `./equin build` regenerates the autogen reference block.

Cross-plugin import path: `@plugins/screenshot/plugins/draw-canvas/web` (this is exactly the form used elsewhere — e.g. `@plugins/infra/plugins/attachments/web`).

### 3. `screenshot` parent — switch to sub-plugin

- Delete `plugins/screenshot/web/components/draw-overlay.tsx`.
- In `plugins/screenshot/web/components/screenshot-view.tsx`:
  - Replace `import { DrawOverlay, type Stroke } from "./draw-overlay";` with:
    ```ts
    import { DrawCanvas, applyStrokes, type Stroke } from "@plugins/screenshot/plugins/draw-canvas/web";
    ```
  - Delete the local `applyStrokes` + `loadImageElement` + `canvasToPng` helpers (now imported).
  - Rename `<DrawOverlay …/>` JSX usage to `<DrawCanvas …/>` (props identical).
- `plugins/screenshot/package.json` — add workspace dep on the new sub-plugin (matching how other plugins reference workspace deps; see existing `plugins/screenshot/package.json` for the pattern).

No behavior change in the existing screenshot pane. This refactor verifies the sub-plugin works before any new feature builds on it.

### 4. `improve` plugin — open-with-attachments command

(Identical to v1 — copying for completeness.)

New file: `plugins/improve/web/commands.ts`

```ts
import { defineCommand } from "@core";

export const Improve = {
  OpenWithAttachments: defineCommand<
    { attachmentIds: string[] },
    void
  >("improve.openWithAttachments"),
};
```

Re-export from `plugins/improve/web/index.ts`:

```ts
export { Improve as ImproveCommands } from "./commands";
```

`plugins/improve/web/components/improve-button.tsx`:

- Add state `prefilledAttachmentIds: string[]` (default `[]`) and `prefilledFilenames: Record<string, string>`.
- Register `Improve.OpenWithAttachments.useHandler(({ attachmentIds }) => { setPrefilledAttachmentIds(attachmentIds); setOpen(true); })`. `ImproveButton` is always mounted in the toolbar, so it's the right home for the handler.
- `submit()`: prepend `...prefilledAttachmentIds` to `attachmentIds[]` in the body. No re-upload — they're already on disk.
- `openForm(false)` (popover close): clear `prefilledAttachmentIds`.
- Pass prefilled IDs/filenames to `ImproveForm` for display.

`plugins/improve/web/components/improve-form.tsx`:

- New prop `prefilledAttachments: { id: string; filename: string }[]`.
- If non-empty, render small chips above the textarea, one per attachment, showing the filename. No remove button in v1 — cancelling the popover is the only "remove" path; keeps the surface minimal.

### 5. Sub-plugin: `screenshot/plugins/draw-on-app/`

Files:

- `web/index.ts` — plugin def:

  ```ts
  import type { PluginDefinition } from "@core";
  import { Shell } from "@plugins/shell/web";
  import { DrawOnAppButton } from "./components/draw-on-app-button";

  export default {
    id: "draw-on-app",
    name: "Draw on App",
    description: "Toolbar button to draw freehand on the live app, capture as a screenshot with strokes baked in, and pre-attach to +improve.",
    contributions: [
      Shell.Toolbar({ component: DrawOnAppButton, group: "actions" }),
    ],
  } satisfies PluginDefinition;
  ```

- `web/components/draw-on-app-button.tsx` — toolbar button + portal-mounted overlay state.
- `web/components/live-draw-overlay.tsx` — fullscreen overlay (canvas + floating mini-toolbar).
- `package.json` — workspace deps: `react`, `react-dom`, `react-icons`, `modern-screenshot`, sibling `draw-canvas`, `infra/attachments`, `improve`, `shell`.
- `CLAUDE.md` — minimal stub.

**Toolbar button (`draw-on-app-button.tsx`):**

- Icon: `MdGesture` (distinct from `MdPhotoCamera` used by screenshot and `MdAdd` used by improve).
- `aria-label="Draw on app"`, `title="Draw on app"`.
- Local state: `active: boolean`, `strokes: Stroke[]`, `color: string` (default `#ef4444`), `width: number` (default `4`), `busy: boolean`, `chromeVisible: boolean` (default `true`).
- When `active`, renders `<LiveDrawOverlay …/>` via `createPortal(…, document.body)`.

**Live overlay (`live-draw-overlay.tsx`):**

- `fixed inset-0 z-[60]` container (above shell, below toasts).
- Inside:
  - `<DrawCanvas displayed={viewportRect} natural={{ w: viewportRect.width, h: viewportRect.height }} strokes={strokes} onStrokesChange={setStrokes} color={color} width={width} />` — 1:1 mapping (no scaling) since drawing happens at viewport resolution.
  - When `chromeVisible`, a floating mini-toolbar pinned top-center (color swatches, width slider, Undo, Clear) and a bottom-right pair of buttons (Cancel, Done). Color swatches and width range are lifted from `plugins/screenshot/web/components/tools-pane.tsx` (lines 72–113); copy-paste is fine here, this is a light variant and doesn't justify a third primitive.
  - The floating toolbar carries `data-draw-chrome="true"` so capture can filter it.
- Viewport rect from `window.innerWidth/innerHeight`; recompute on resize via `ResizeObserver` on `document.documentElement`.

**Done flow:**

```ts
async function onDone() {
  if (busy || strokes.length === 0) return; // empty-draw guard
  setBusy(true);
  try {
    flushSync(() => setChromeVisible(false));
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
    const blob = await domToBlob(document.documentElement, {
      scale: window.devicePixelRatio || 1,
      filter: (node) =>
        !(node instanceof HTMLElement && node.dataset.drawChrome === "true"),
    });
    if (!blob) {
      ShellCommands.Toast({ description: "Capture failed", variant: "error" });
      return;
    }
    const uploaded = await uploadAttachment(blob, "drawing.png", "image/png");
    setActive(false);
    setStrokes([]);
    setChromeVisible(true);
    ImproveCommands.OpenWithAttachments({ attachmentIds: [uploaded.id] });
  } catch (err) {
    ShellCommands.Toast({
      description: `Capture failed: ${(err as Error).message}`,
      variant: "error",
    });
  } finally {
    setBusy(false);
  }
}
```

**Cancel flow:** `setActive(false); setStrokes([])`. No capture, no upload, no improve.

### 6. Registration

`web/src/plugins.ts`:

```ts
import drawCanvasPlugin from "@plugins/screenshot/plugins/draw-canvas/web";
import drawOnAppPlugin from "@plugins/screenshot/plugins/draw-on-app/web";
// …
export const plugins = [..., drawCanvasPlugin, drawOnAppPlugin];
```

The parent `screenshotPlugin` registration stays as-is.

---

## Critical files

**Created:**

- `plugins/screenshot/plugins/draw-canvas/web/index.ts`
- `plugins/screenshot/plugins/draw-canvas/web/draw-canvas.tsx` (moved from `plugins/screenshot/web/components/draw-overlay.tsx`)
- `plugins/screenshot/plugins/draw-canvas/web/apply-strokes.ts` (extracted from `screenshot-view.tsx`)
- `plugins/screenshot/plugins/draw-canvas/package.json`
- `plugins/screenshot/plugins/draw-canvas/CLAUDE.md`
- `plugins/screenshot/plugins/draw-on-app/web/index.ts`
- `plugins/screenshot/plugins/draw-on-app/web/components/draw-on-app-button.tsx`
- `plugins/screenshot/plugins/draw-on-app/web/components/live-draw-overlay.tsx`
- `plugins/screenshot/plugins/draw-on-app/package.json`
- `plugins/screenshot/plugins/draw-on-app/CLAUDE.md`
- `plugins/improve/web/commands.ts`

**Modified:**

- `plugins/screenshot/web/components/screenshot-view.tsx` — import primitive from sub-plugin, drop local `applyStrokes`, swap `DrawOverlay` for `DrawCanvas`.
- `plugins/screenshot/package.json` — add workspace dep on `draw-canvas` sub-plugin.
- `plugins/improve/web/index.ts` — re-export `ImproveCommands`.
- `plugins/improve/web/components/improve-button.tsx` — register handler, manage prefilled IDs.
- `plugins/improve/web/components/improve-form.tsx` — render attachment chips.
- `web/src/plugins.ts` — register two new sub-plugins.

**Deleted:**

- `plugins/screenshot/web/components/draw-overlay.tsx`

## Reuse

- `DrawOverlay` / `Stroke` / `applyStrokes` — moved into the new `draw-canvas` sub-plugin (was `plugins/screenshot/web/components/draw-overlay.tsx`).
- `domToBlob` from `modern-screenshot` — same pattern as `improve-button.tsx:47` and `screenshot-button.tsx:30`.
- `uploadAttachment` from `@plugins/infra/plugins/attachments/web` — same as `improve-button.tsx:54`.
- `flushSync` + 2 rAFs hide-before-capture — pattern from `improve-button.tsx:43-46`.
- `defineCommand` / `useHandler` — canonical example: `Shell.Toast` in shell plugin.
- Color swatches + width slider styling — lifted from `plugins/screenshot/web/components/tools-pane.tsx:72-113`.

## Verification

`./equin build`, then in the browser at `http://<worktree>.localhost:9000`:

1. **Refactor smoke test (existing screenshot still works).** Click camera icon → screenshot pane opens → switch to Draw tool → draw strokes → Apply → strokes baked into the image; Copy/Download produce expected PNG. Confirms the sub-plugin extraction didn't regress anything.
2. **Live-draw happy path.** Click new gesture icon → cursor becomes crosshair → draw a circle around the toolbar → click Done → `+improve` popover opens with one attachment chip showing `drawing.png`.
3. **Submit.** Type "fix this" → click Sonnet → toast "Launched with Sonnet"; the linked task in the Improvements meta-task shows the attachment with the strokes baked in.
4. **Cancel.** Open overlay → draw → Cancel → overlay disappears, no popover, no new file in `~/.singularity/attachments/`.
5. **Empty-draw guard.** Open overlay → click Done immediately → no-op (button is disabled or returns early).
6. **Chrome not in capture.** Inspect the resulting PNG: floating draw chrome (color swatches, Done/Cancel) must not be present; strokes and underlying app UI must be.
7. **Plugin boundaries.** `./equin check` passes — in particular `--plugin-boundaries`. All cross-plugin imports use `@plugins/<name>/{web,server,shared}` (incl. nested `@plugins/screenshot/plugins/draw-canvas/web`).
8. **Playwright optional sanity.** `bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000 --click "Draw on app" --out /tmp/draw` confirms button reachability and overlay render.
