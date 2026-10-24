# Draw-on-app feature

## Context

We want a quick way to circle/arrow/scribble on the live app and feed that as a screenshot into the `+improve` popover. The existing `screenshot` plugin already has a draw tool, but only inside its dedicated capture-then-edit pane, and the only destination from there is "launch a new conversation". Today, sending a marked-up screenshot to `+improve` requires: take screenshot → annotate in the pane → copy → open improve → manually attach. The new feature collapses that into: click a toolbar button → draw on the live app → click Done → improve opens with the marked-up screenshot pre-attached.

This is also a good moment to fix a structural issue: the draw-canvas component lives inside `plugins/screenshot/web/components/`, which means the new plugin would either have to depend on screenshot's internals (forbidden) or duplicate the code. We extract it into a primitive so both flows share one implementation.

## Approach

Three changes, in dependency order:

1. **Extract `DrawCanvas` into a primitive** — move the canvas component + `applyStrokes` helper out of `screenshot/` into a new `draw-canvas` primitive. Pure refactor, no behavior change.
2. **Add an `Improve.OpenWithAttachments` command** — gives `improve` a clean handoff API any plugin can use.
3. **New `draw-on-app` plugin** — toolbar button that mounts a fullscreen draw overlay; on Done, captures via `domToBlob`, uploads, and dispatches `Improve.OpenWithAttachments`.

Live-draw works because the drawing `<canvas>` lives inside `document.documentElement` while the user is drawing — `modern-screenshot`'s `domToBlob` walks the DOM and renders canvas content, so strokes are baked into the captured image automatically. The only chrome we need to hide before capture is the floating tools toolbar (same `flushSync` + 2 rAFs trick `improve-button.tsx` already uses).

---

### 1. New primitive: `plugins/primitives/plugins/draw-canvas/`

Files:

- `web/index.ts` — plugin barrel; re-exports `DrawCanvas`, `applyStrokes`, types.
- `web/draw-canvas.tsx` — moved from `plugins/screenshot/web/components/draw-overlay.tsx`. Component is renamed `DrawOverlay` → `DrawCanvas` to drop the screenshot-editor framing; props unchanged.
- `web/apply-strokes.ts` — extracted from `plugins/screenshot/web/components/screenshot-view.tsx` (the `applyStrokes` + `loadImageElement` + `canvasToPng` helpers). `applyCrop` stays in `screenshot/` since crop is screenshot-specific.
- `package.json` — workspace package; depends on react.
- `CLAUDE.md` — minimal stub; `./equin build` regenerates the autogen reference block.

Public surface (web):

```ts
export { DrawCanvas } from "./draw-canvas";
export type { Stroke, DrawCanvasProps } from "./draw-canvas";
export { applyStrokes } from "./apply-strokes";
```

Plugin def:

```ts
export default {
  id: "draw-canvas",
  name: "Draw Canvas",
  description: "Reusable freehand draw canvas overlay (color/width/strokes). Used by screenshot editor and draw-on-app.",
  contributions: [],
} satisfies PluginDefinition;
```

Update `web/src/plugins.ts` to register it.

### 2. `screenshot` plugin — switch to primitive

- Delete `plugins/screenshot/web/components/draw-overlay.tsx`.
- In `plugins/screenshot/web/components/screenshot-view.tsx`:
  - Replace `import { DrawOverlay, type Stroke } from "./draw-overlay";` with `import { DrawCanvas, applyStrokes, type Stroke } from "@plugins/primitives/plugins/draw-canvas/web";`
  - Replace the local `applyStrokes` function with the imported one (delete it from the file).
  - Replace `<DrawOverlay …/>` with `<DrawCanvas …/>` (props identical).
- Add `@singularity/plugin-draw-canvas` (or whatever the workspace package name is — match pattern of other primitive deps) to `plugins/screenshot/package.json`.

No behavior change in the screenshot pane. This refactor verifies the primitive is sufficient before any new feature builds on it.

### 3. `improve` plugin — open-with-attachments command

New file: `plugins/improve/web/commands.ts`

```ts
import { defineCommand } from "@core";

export const Improve = {
  OpenWithAttachments: defineCommand<
    { attachmentIds: string[]; placeholderText?: string },
    void
  >("improve.openWithAttachments"),
};
```

Re-export from `plugins/improve/web/index.ts`:

```ts
export { Improve as ImproveCommands } from "./commands";
```

Modify `plugins/improve/web/components/improve-button.tsx`:

- Add state `prefilledAttachmentIds: string[]` (default `[]`) and `prefilledFilenames: Record<string, string>` for display.
- Register `Improve.OpenWithAttachments.useHandler(({ attachmentIds }) => { setPrefilledAttachmentIds(attachmentIds); setOpen(true); })`. The handler must live in a mounted component, so `ImproveButton` (always mounted in toolbar) is the right home.
- In `submit`: prepend `...prefilledAttachmentIds` to the `attachmentIds[]` sent in the body. Don't re-upload — they're already on disk.
- On popover close (`openForm(false)`): clear `prefilledAttachmentIds`.
- Pass prefilled IDs/filenames into `ImproveForm` for display.

Modify `plugins/improve/web/components/improve-form.tsx`:

- New prop `prefilledAttachments: { id: string; filename: string }[]`.
- If non-empty, render small chips above the textarea — e.g. one chip per attachment showing the filename, with no remove button in v1 (cancel-the-popover is the only remove path; keep it minimal).

### 4. New plugin: `plugins/draw-on-app/`

Files:

- `web/index.ts` — barrel; default-exports plugin def.
- `web/components/draw-on-app-button.tsx` — toolbar button + portal-mounted overlay state.
- `web/components/live-draw-overlay.tsx` — fullscreen overlay component (canvas + floating mini-toolbar).
- `package.json` — workspace deps: `react`, `react-dom`, `react-icons`, `modern-screenshot`, primitive `draw-canvas`, `infra/attachments`, `improve`, `shell`.

Plugin def:

```ts
export default {
  id: "draw-on-app",
  name: "Draw on App",
  description: "Toolbar button to draw freehand on the live app, then capture and attach to +improve.",
  contributions: [
    Shell.Toolbar({ component: DrawOnAppButton, group: "actions" }),
  ],
} satisfies PluginDefinition;
```

Toolbar button (`draw-on-app-button.tsx`):

- Icon: `MdGesture` (distinct from `MdPhotoCamera` and `MdAdd`).
- `aria-label="Draw on app"`, `title="Draw on app"`.
- Local state: `active: boolean`, `strokes: Stroke[]`, `color: string` (default `#ef4444`), `width: number` (default `4`), `busy: boolean`, `chromeVisible: boolean` (default `true`).
- When `active`, render `<LiveDrawOverlay …/>` via `createPortal(…, document.body)`.

Live overlay (`live-draw-overlay.tsx`):

- A `fixed inset-0 z-[60]` container (above shell, below toasts which use a higher z).
- Inside it:
  - A full-viewport `<DrawCanvas displayed={viewportRect} natural={{ w: viewportRect.width, h: viewportRect.height }} strokes={strokes} onStrokesChange={setStrokes} color={color} width={width} />` (1:1 mapping, no scaling).
  - When `chromeVisible`, a floating mini-toolbar pinned top-center (color swatches, width slider, Undo, Clear) and a bottom-right pair of buttons (Cancel, Done). Color/width controls reuse the same swatches and range as `tools-pane.tsx` — copy-paste is fine; this is a light variant, not worth a second primitive yet.
  - The floating toolbar carries `data-draw-chrome="true"` so capture can filter it.
- Viewport rect comes from `window.innerWidth/innerHeight`; recompute on resize via `ResizeObserver` on `document.documentElement`.

Done flow inside the button:

```ts
async function onDone() {
  if (busy || strokes.length === 0) return; // guard against empty draws
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

Cancel flow: tear down (`setActive(false); setStrokes([])`) — no capture, no upload, no improve.

The `filter` in `domToBlob` is belt-and-suspenders alongside `chromeVisible=false`; if either layer fails, the chrome still doesn't end up in the screenshot.

### 5. Registration

Add three lines to `web/src/plugins.ts`:

```ts
import drawCanvasPlugin from "@plugins/primitives/plugins/draw-canvas/web";
import drawOnAppPlugin from "@plugins/draw-on-app/web";
// …
export const plugins = [..., drawCanvasPlugin, drawOnAppPlugin];
```

---

## Critical files

**Created:**

- `plugins/primitives/plugins/draw-canvas/web/index.ts`
- `plugins/primitives/plugins/draw-canvas/web/draw-canvas.tsx` (moved from `plugins/screenshot/web/components/draw-overlay.tsx`)
- `plugins/primitives/plugins/draw-canvas/web/apply-strokes.ts` (extracted from `screenshot-view.tsx`)
- `plugins/primitives/plugins/draw-canvas/package.json`
- `plugins/primitives/plugins/draw-canvas/CLAUDE.md`
- `plugins/improve/web/commands.ts`
- `plugins/draw-on-app/web/index.ts`
- `plugins/draw-on-app/web/components/draw-on-app-button.tsx`
- `plugins/draw-on-app/web/components/live-draw-overlay.tsx`
- `plugins/draw-on-app/package.json`
- `plugins/draw-on-app/CLAUDE.md`

**Modified:**

- `plugins/screenshot/web/components/screenshot-view.tsx` — import primitive, drop local `applyStrokes`, swap `DrawOverlay` for `DrawCanvas`.
- `plugins/screenshot/package.json` — add primitive dep.
- `plugins/improve/web/index.ts` — re-export `ImproveCommands`.
- `plugins/improve/web/components/improve-button.tsx` — register handler, manage prefilled IDs.
- `plugins/improve/web/components/improve-form.tsx` — render attachment chips.
- `web/src/plugins.ts` — register new plugins.

**Deleted:**

- `plugins/screenshot/web/components/draw-overlay.tsx`

## Reuse

- `DrawOverlay` / `Stroke` / `applyStrokes` — moved into the new primitive (was `plugins/screenshot/web/components/draw-overlay.tsx`).
- `domToBlob` from `modern-screenshot` — same usage as `improve-button.tsx:47` and `screenshot-button.tsx:30`.
- `uploadAttachment` from `@plugins/infra/plugins/attachments/web` — same as `improve-button.tsx:54`.
- `flushSync` + 2 rAFs hide-before-capture pattern from `improve-button.tsx:43-46`.
- `defineCommand` / `useHandler` pattern from `plugins/shell/web/commands.ts` (the canonical example with `Shell.Toast`).
- Color swatch + width slider styling lifted from `plugins/screenshot/web/components/tools-pane.tsx:72-113`.

## Verification

Run `./equin build`, then in the browser at `http://<worktree>.localhost:9000`:

1. **Refactor smoke test (screenshot still works).** Click the camera icon → screenshot pane opens → switch to Draw tool → draw a few strokes → Apply → strokes are baked into the image, Copy/Download produce the expected PNG. Confirms the primitive extraction didn't regress anything.
2. **Live-draw happy path.** Click the new gesture icon in the toolbar → cursor becomes crosshair, app behind dims slightly (or just transparent overlay) → draw a circle around the toolbar → click Done → toast/no toast (no toast is fine on success) → `+improve` popover opens with one attachment chip showing `drawing.png`.
3. **Submit.** Type "fix this" in the popover → click Sonnet → toast "Launched with Sonnet" → open `~/.singularity/attachments/` and confirm a new file exists; open the linked task and confirm the attachment is visible and shows the drawing baked in.
4. **Cancel.** Click gesture icon → draw → Cancel → overlay disappears, no popover opens, no upload (`ls -la ~/.singularity/attachments/` shows no new file).
5. **Empty-draw guard.** Click gesture icon → click Done without drawing → button is disabled (or no-op).
6. **Chrome not in capture.** After step 2, view the resulting PNG: the floating draw toolbar (color swatches, Done/Cancel) must NOT be visible in the captured image. Drawing should be visible. App UI underneath should be visible.
7. **Plugin boundaries.** Run `./equin check` — passes. In particular `--plugin-boundaries` should be clean (only `@plugins/<name>/web` imports across plugins).
8. **Playwright sanity (optional).** `bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000 --click "Draw on app" --out /tmp/draw` — confirms the toolbar button is reachable and the overlay renders.
