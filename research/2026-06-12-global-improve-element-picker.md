# Improve — "Select a UI element" context picker

## Context

The `+Improve` flow lets a user launch an agent to improve the app, seeding a
prompt with text, screenshots, and the current URL. Today there is no way to
point at **a specific part of the UI** and say "this is what I'm talking
about." This adds a Chrome-inspector-style element picker: the user clicks a
toolbar button, hovers/clicks any element on the live app, and the element's
metadata (owning plugin, URL, slot, a fine-grained element descriptor) is
captured. It is then injected into the Improve prompt as a **single rich block**
(a chip, mirroring how a screenshot appears inline) and serialized into the
sent prompt as a readable `<ui-context …/>` tag the agent can read.

Decisions locked with the user:
- **Granularity:** free element pick (Chrome-like) — metadata is finer-grained
  than just the plugin (element tag, label, slot, pane, URL).
- **Plugin mapping:** explicit DOM markers (`data-plugin-id` / `data-slot-id`),
  added app-wide via a slot-render middleware so the DOM is introspectable. This
  is also reusable for e2e/debugging/studio.

This mirrors the existing **draw-on-app** feature (`plugins/screenshot/plugins/draw-on-app/`),
which is an ActionBar button that overlays the live app, captures something, and
hands off to Improve via `Improve.OpenWithText`. We follow that pattern exactly.

## How the existing pieces fit (verified)

- **Rich inline block = a Lexical node extension.** `registerNodeExtension({ node,
  serializeNode, deserializePattern, createNodeFromMatch })`
  (`plugins/primitives/plugins/text-editor/web`) makes a markdown token render as
  an inline decorator chip. The screenshot/paste-images `ImageNode`
  (`…/paste-images/web/internal/image-node.tsx`) is the template. Markdown↔Lexical
  sync is **line-based** (`…/text-editor/web/internal/markdown.ts`): each line is
  scanned with every extension's `deserializePattern`, so our token must be
  **single-line**. On serialize, the node's `serializeNode` string is what ends up
  in the card text → task description → agent prompt.
- **Hand-off to Improve.** `ImproveCommands.OpenWithText({ text })` (`@plugins/improve/web`)
  opens the Improve `TaskDraftPopover` with `initialText = text`
  (`plugins/improve/web/components/improve-button.tsx`). Seeding the head card with
  our token triggers `applyMarkdownToEditor`, which deserializes it into our chip.
- **No DOM→plugin mapping exists today.** `_pluginId` / `_slotId` live only on the
  in-memory `Contribution` object. The single chokepoint where every contribution
  is wrapped is `applyItemMiddlewares` in
  `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx`, fed by
  registered item middlewares (`registerSlotItemMiddleware`). `error-boundary` is
  the precedent: a standalone plugin that registers an item middleware.
- **Overlay pattern.** `draw-on-app-button.tsx` + `live-draw-overlay.tsx`:
  `createPortal(<Overlay/>, document.body)`, `fixed inset-0 z-…`, Esc/Cancel,
  chrome marked with a `data-*` attribute so it's excluded from hit-testing.

## Plan

### 1. DOM markers — internal to the `element-picker` plugin

The explicit DOM markers exist **only** to serve this picker, so they live inside
`element-picker/web/internal/` rather than as a standalone primitive (a
one-consumer primitive is the wrong altitude). The middleware still acts
app-wide — exactly like `error-boundary`/`reorder`, which are separate plugins
that register global item middlewares — but it's owned by its sole consumer. If
real reuse appears later (e2e, studio, debug), promote it to a primitive then.

- `web/internal/marker-middleware.tsx` — an item middleware that wraps its
  children in a **layout-neutral** marker:
  ```tsx
  export function PluginMarkerMiddleware({ slotId, contribution, children }) {
    return (
      <span style={{ display: "contents" }}
            data-plugin-id={contribution._pluginId ?? ""}
            data-slot-id={slotId}>
        {children}
      </span>
    );
  }
  ```
  `display:contents` generates **no box** (layout identical to today's `Fragment`/
  cell), but the element is still in the DOM tree so `Element.closest('[data-plugin-id]')`
  finds it. Nested slots yield nested markers → `closest` returns the **nearest**
  (most specific) plugin — exactly the fine-grained attribution we want.
- `web/internal/find-plugin-context.ts`:
  ```ts
  export function findPluginContext(el: Element) {
    const p = el.closest<HTMLElement>("[data-plugin-id]");
    const pane = el.closest<HTMLElement>("[data-pane-id]");
    return {
      pluginId: p?.dataset.pluginId || undefined,
      slotId: p?.dataset.slotId || undefined,
      paneId: pane?.dataset.paneId || undefined,
    };
  }
  ```
- The plugin's `web/index.ts` side-effect-imports `./internal/marker-middleware`
  (which calls `registerSlotItemMiddleware(PluginMarkerMiddleware)` at module load,
  alongside the `register-node` import). `findPluginContext` is internal — no
  cross-plugin export. `registerSlotItemMiddleware` comes from
  `@plugins/primitives/plugins/slot-render/web`.

**Caveat to vet:** `display:contents` is invisible to layout but **is** part of the
DOM tree, so any CSS using a direct-child combinator *across a slot boundary*
(`.host > .contribution`) would no longer match. This is rare (hosts style the
slot container, not its children; horizontal slots already interpose a
`min-w-0` cell). Verification step below screenshots key screens to confirm no
regression. (Portaled content — popovers mounted to `body` — won't resolve a
plugin via `closest`; acceptable, the picker targets the live app surface.)

### 2. Pane markers: add `data-pane-id`

Add `data-pane-id={paneId}` at the pane render chokepoints so `findPluginContext`
can report the containing pane:
- `plugins/layouts/plugins/miller/web/…/column.tsx` (the per-column root div),
- `plugins/layouts/plugins/full-pane/web/…` (the full-pane root).
Low risk (few nodes, no `display:contents`).

### 3. Core token schema: `plugins/improve/plugins/element-picker/core/index.ts`

Single-line, **human/agent-readable**, round-trippable tag.

```ts
export interface UiContextMeta {
  url: string;
  pluginId?: string;
  slotId?: string;
  paneId?: string;
  element: string;    // e.g. "button — Improve this app"
  selector?: string;  // short CSS path for precision, e.g. "header>div>button"
}

const sanitize = (v: string) => v.replace(/"/g, "'").replace(/\s+/g, " ").trim();

export function serializeUiContext(m: UiContextMeta): string {
  const attr = (k: string, v?: string) => (v ? ` ${k}="${sanitize(v)}"` : "");
  return `<ui-context${attr("plugin", m.pluginId)}${attr("slot", m.slotId)}` +
         `${attr("pane", m.paneId)} url="${sanitize(m.url)}" element="${sanitize(m.element)}"` +
         `${attr("selector", m.selector)} />`;
}

export const UI_CONTEXT_RE = /<ui-context\s+[^>]*?\/>/g;

export function parseUiContext(match: RegExpExecArray): UiContextMeta | null {
  const body = match[0];
  const get = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(body)?.[1];
  const url = get("url");
  const element = get("element");
  if (!url || !element) return null;
  return { url, element, pluginId: get("plugin"), slotId: get("slot"),
           paneId: get("pane"), selector: get("selector") };
}
```

The serialized tag is exactly what the agent receives in the prompt — that is
"the metadata injected into the prompt when sent."

### 4. Feature plugin: `plugins/improve/plugins/element-picker/web/`

(`improve` becomes an umbrella with its own `web/`+`server/` plus this child —
identical shape to `screenshot` which has `web/`/`server/` + `draw-canvas`/`draw-on-app`.)

- `web/index.ts` — `export default definePlugin({ contributions: [ActionBar.Item →
  ElementPickerButton] })`; side-effect `import "./internal/register-node"` and
  `import "./internal/marker-middleware"` (registers the DOM-marker middleware).
- `web/components/element-picker-button.tsx` — `IconButton` (e.g. `MdHighlightAlt`/
  `MdAdsClick`, label "Pick UI element"); on click sets `active`, renders
  `createPortal(<PickerOverlay onPick={…} onCancel={…}/>, document.body)`. On pick:
  `ImproveCommands.OpenWithText({ text: serializeUiContext(meta) })` then teardown.
  Contributed to `ActionBar.Item` (parity with draw-on-app/screenshot).
- `web/components/picker-overlay.tsx` — full-screen portal, `fixed inset-0 z-max`,
  `data-element-picker` root, **`pointer-events:none`** so `document.elementFromPoint`
  returns the real underlying element. Window-level capture-phase `mousemove`
  (update hovered element + highlight box via `getBoundingClientRect`) and `click`
  (`preventDefault`+`stopPropagation`, resolve target, call `onPick`). Renders a
  highlight box + a small label chip (plugin id + tag) + an instruction bar
  ("Click an element to attach it as context · Esc to cancel"). Esc → `onCancel`.
  Skip targets inside `[data-element-picker]`.
- `web/internal/collect-meta.ts` — `collectMeta(el): UiContextMeta` using
  `findPluginContext(el)` from `plugin-markers`, `window.location.href`, and a
  fine-grained element descriptor: `el.tagName` + `aria-label`/trimmed
  `textContent`/`title` (truncated ~60 chars), plus a short ancestor CSS path for
  `selector`.
- `web/internal/ui-context-node.tsx` — `UiContextNode extends DecoratorNode<ReactNode>`
  (inline), holding `UiContextMeta`; `$createUiContextNode` / `$isUiContextNode`;
  `decorate()` → `<UiContextChip meta onRemove>` with the same key-based remove as
  `ImageNodeView`.
- `web/components/ui-context-chip.tsx` — the rich single block: `inline-flex`
  rounded bordered chip (compose `badge`/`card`/`text` primitives), icon + element
  label + muted plugin/host, `contentEditable={false}`, hover × to remove.
- `web/internal/register-node.ts`:
  ```ts
  registerNodeExtension({
    node: UiContextNode,
    serializeNode: (n) => $isUiContextNode(n) ? serializeUiContext(n.getMeta()) : null,
    deserializePattern: UI_CONTEXT_RE,
    createNodeFromMatch: (m) => { const meta = parseUiContext(m); return meta ? $createUiContextNode(meta) : null; },
  });
  ```
- Register the plugin in `web/src/plugins.ts`.

### Flow end-to-end

1. User clicks **Pick UI element** in the toolbar → overlay over the live app.
2. Hover highlights elements; click selects one → `collectMeta` → `serializeUiContext`.
3. `Improve.OpenWithText({ text: token })` opens the Improve popover; the head
   card seeds the token, which `applyMarkdownToEditor` deserializes into the
   `UiContextNode` chip — the rich single block. User types their comment.
4. On submit, `serializeEditorToMarkdown` emits the `<ui-context …/>` tag back into
   `card.text` → `POST /api/tasks/chain` → task description → `buildTaskPrompt` →
   agent prompt contains the readable tag. No attachment plumbing needed.

## Files

**New**
- `plugins/improve/plugins/element-picker/core/index.ts`
- `plugins/improve/plugins/element-picker/web/{index.ts, internal/marker-middleware.tsx, internal/find-plugin-context.ts, internal/register-node.ts, internal/ui-context-node.tsx, internal/collect-meta.ts, components/element-picker-button.tsx, components/picker-overlay.tsx, components/ui-context-chip.tsx}`

**Modified**
- `web/src/plugins.ts` — register `element-picker`.
- `plugins/layouts/plugins/miller/web/…/column.tsx` and `plugins/layouts/plugins/full-pane/web/…` — add `data-pane-id`.

**Reused (no change)**
- `registerNodeExtension`, `TextEditor` markdown sync — `plugins/primitives/plugins/text-editor/web`
- `ImproveCommands.OpenWithText` — `plugins/improve/web`
- `registerSlotItemMiddleware` / `applyItemMiddlewares` — `plugins/primitives/plugins/slot-render/web`
- `IconButton`, `ActionBar.Item`, `badge`/`card`/`text` primitives, `createPortal`

## Verification

1. `./equin build`; open `http://<worktree>.localhost:9000`.
2. **Markers:** in devtools, confirm contributions carry `data-plugin-id`/`data-slot-id`
   and pane roots carry `data-pane-id`. Spot-check `document.elementFromPoint`→
   `findPluginContext` returns the expected plugin for a few regions.
3. **No layout regression:** screenshot a few dense screens (agent-manager,
   task-detail, settings, a sonata view) before/after via `bun e2e/screenshot.mjs`
   and compare — watch for any `>`-combinator breakage from `display:contents`.
4. **Picker:** click the toolbar button, hover (highlight tracks elements), click
   one → Improve popover opens with the `<ui-context>` chip as a single block; Esc
   cancels.
5. **Round-trip:** type a comment, confirm the chip persists; inspect the submitted
   task description (or `query_db` the task row) to confirm the prompt contains the
   readable `<ui-context plugin="…" url="…" element="…" />` tag.
6. `./equin check` (boundaries, type-check, plugins-doc-in-sync).

## Open follow-ups (not blocking)

- `Improve.OpenWithText` **replaces** `initialText` (same as draw-on-app), so a
  second pick overwrites the first. If multi-pick is desired, evolve OpenWithText
  to append — separate change.
- `data-pane-id` / app id: if an explicit `app` field is wanted in the metadata,
  add a small imperative `getActiveAppId()` accessor; deferred for v1.
