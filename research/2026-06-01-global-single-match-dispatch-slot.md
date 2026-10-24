# Single-match dispatch slots with automatic isolation

## Context

Visual slots that resolve their contributions by hand — `slot.useContributions()`
then rendering `<match.component .../>` directly — skip the slot-render
error-boundary middleware that `slot.Render` applies automatically. A single
throwing contribution therefore propagates to the nearest *ancestor* boundary
instead of being contained to its own card. This recently took down the **entire
miller layout (both panes)** when one malformed `Read` tool-call event threw,
rather than just blanking that row.

The root cause is structural: there is no first-class primitive for the very
common "pick **one** matching contribution and render it" pattern, so every site
re-implements dispatch by hand and silently bypasses isolation. Four sites do
this today (all defined with bare `defineSlot`, not `defineRenderSlot`):

| Site | Slot | Match | Fallback |
|---|---|---|---|
| `EventRow` | `JsonlViewer.EventRenderer` | exact `kind` | `UnknownEventRow` |
| `ToolCallRow` | `JsonlViewerTool.Renderer` | exact `name`, then regex `pattern` | `GenericToolView` |
| `AttachmentRow` | `JsonlViewerAttachment.Renderer` | exact `subtype` | `GenericAttachmentView` |
| `JsonlPane` overlays | `JsonlViewer.Overlay` | none — renders **all**, no props | — |

The first three are single-match dispatch; the fourth is multi-match render-all.
None get crash isolation today.

**Goal:** add a consistent, isolation-by-default API for single-match slot
rendering where the safe path is at least as ergonomic as the manual one (so
authors reach for it rather than bypass it), and migrate all four sites.

## Design

Two additions to the `slot-render` primitive
(`plugins/primitives/plugins/slot-render/web/`), plus one correctness fix in
`reorder`. The whole surface stays coherent: every slot-render variant routes
its rendered node through the **same** item-middleware pipeline, which is what
guarantees error-boundary isolation everywhere.

### 1. `defineDispatchSlot<Props, Key>` — single match (new)

```ts
export interface DispatchContribution<Props, Key extends string> {
  /** Plain string = exact match; RegExp = pattern match (exact wins). */
  match: Key | RegExp;
  component: ComponentType<Props>;
}

export interface DispatchSlotConfig<Props, Key extends string> {
  /** Project the dispatch key out of the render props. */
  key: (props: Props) => Key;
  /** Rendered (and isolated) when nothing matches. */
  fallback?: ComponentType<Props>;
  docLabel?: (c: DispatchContribution<Props, Key>) => string | undefined;
}

export interface DispatchSlot<Props, Key extends string = string>
  extends Slot<DispatchContribution<Props, Key>> {
  Dispatch: ComponentType<Props>;
}
```

- **Contribution shape is uniform `{ match, component }`** — no `id` (no reorder),
  and the two-field `name?`+`pattern?` split in tool-call collapses into one
  `match: string | RegExp` field. (Confirmed via AskUserQuestion: unified `match`.)
- `<Slot.Dispatch {...props} />` computes `key = config.key(props)`, then:
  1. first contribution whose `match` is a string `=== key` (exact), else
  2. first contribution whose `match` is a `RegExp` and `.test(key)` passes (pattern), else
  3. `config.fallback` (or `null`).
- Renders the chosen component as `<Component {...props} />`, wrapped in the
  item-middleware pipeline → **error-boundary isolation applies automatically**.
  Applies **no list middlewares** (single match has no list / no reorder).
- **Match precedence** (exact before pattern) lives in the primitive, once —
  deleting the hand-rolled `resolveRenderer` from every site.

**Component form only — no component-returning hook.** A hook like
`useResolved(props): ComponentType` would hand the component back to the caller
to render `<Resolved {...} />` themselves — recreating exactly the
outside-the-boundary bypass we are removing. The component form is the single
blessed, isolation-guaranteeing path, and it mirrors the existing `.Render`
shape on `RenderSlot`. (Open question resolved.)

**Typing.** `Props` is the single source for both `Dispatch`'s props and each
contribution's `component` props. `Key` types the exact-match strings: for
`EventRenderer`, `Key = JsonlEvent["kind"]` gives contributors autocomplete +
union exhaustiveness on `match` (strictly better than today's loosely-typed
`kind` field); for tool names / attachment subtypes `Key = string` (open set).

**Fallback isolation.** The error-boundary middleware reads
`contribution._pluginName` (`error-boundary-middleware.tsx:15`). A matched
contribution carries the real stamped `Contribution`; for the fallback path
(no contribution) we synthesize a minimal `{ _slotId: id } as Contribution`.
`PluginErrorBoundary` already null-guards its label
(`plugin-error-boundary.tsx`), so the fallback renders inside a boundary with a
generic label — fallbacks are isolated too.

### 2. `defineRenderSlot` config gains `reorder?: boolean` (default `true`)

When `false`, `.Render` applies the item middlewares but **skips list
middlewares**, so contributions are isolated but not draggable/reorderable.
Used to migrate `JsonlViewer.Overlay`: overlays are absolutely-positioned
floating widgets (`absolute … z-10`) anchored to the `relative` pane container
(`jsonl-pane.tsx:214`); wrapping them in `SortableReorderItem` would break their
positioning, so non-reorderable render-all is the semantically correct fit.

### 3. Harden `ReorderItemMiddleware` (correctness fix that unlocks the above)

`plugins/reorder/web/internal/dnd-item-middleware.tsx` currently does
`storageId={ctx?.storageId ?? ""}` and renders `<SortableReorderItem>` even when
no `ReorderAreaContext` is present. `SortableReorderItem` calls dnd-kit's
`useSortable`, which requires the `DndContext` that only the reorder **list**
middleware provides — so the item middleware is silently broken outside a
reorder list today.

Fix: **bail to `<>{children}</>` when `useContext(ReorderAreaContext)` is null.**

```tsx
const ctx = useContext(ReorderAreaContext);
if (!ctx) return <>{children}</>;   // no reorder list above us → pass through
```

This is the single invariant that keeps the whole surface coherent: **item
middlewares must be safe no-ops when their required context is absent; list
middlewares own that context.** With it, both `.Dispatch` and `reorder:false`
`.Render` reuse the unchanged item-middleware pipeline (error-boundary still
wraps; reorder cleanly passes through) with **no middleware "scope/category"
taxonomy required**. Behavior of normal `.Render` (reorder list present →
context present) is unchanged.

### How it composes with the existing surface

- `defineRenderSlot` → render **all**, isolated; reorderable unless `reorder:false`.
- `defineDispatchSlot` → render **one** (or fallback), isolated; never reordered.
- Both live in `slot-render`, share the item-middleware registry and the same
  isolation mechanism. Shared internal helper `applyItemMiddlewares(node, slotId,
  contribution)` (extracted from the existing inline loop in `render-slot.tsx`)
  is used by `Render` and `Dispatch` alike.

### Docgen

The slots facet's static parser (`parse-utils/core/helpers.ts:62` →
`parseDefineGroup`, called from `slots/facet/index.ts:54`) recognizes only the
`defineSlot(` builder. Add `defineDispatchSlot` to its accepted builders so the
three migrated dispatch slots stay in their plugins' `Slots:` doc lines:

- `parse-utils/core/helpers.ts:64` — widen `builder` to include
  `"defineDispatchSlot"`.
- `slots/facet/index.ts` — also call `parseDefineGroup(..., "defineDispatchSlot", ...)`
  and union the results.

We intentionally do **not** add `defineRenderSlot` here: that would document
every render slot repo-wide (a large, mechanical doc regen). `JsonlViewer.Overlay`
moving to `defineRenderSlot` will drop from the jsonl-viewer `Slots:` line —
which is already consistent with how all render slots are handled (e.g.
`JsonlViewer.RowAction`, a `defineRenderSlot` in the same file, is already
absent from that line). Contribution detection is unaffected — `findCalls`
keys on the callee name (`JsonlViewer.EventRenderer(`), not the prop fields.
(Open question resolved: the facet is current, but we keep the change surgical.)

## Migration

### Primitive
- `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` — add
  `defineDispatchSlot` + `DispatchSlot`/`DispatchContribution`/`DispatchSlotConfig`
  types; extract shared `applyItemMiddlewares`; add `reorder?: boolean` to
  `RenderSlotConfig` and gate list-middleware application in `Render`.
- `plugins/primitives/plugins/slot-render/web/index.ts` — export
  `defineDispatchSlot` and the new types.
- `plugins/reorder/web/internal/dnd-item-middleware.tsx` — null-ctx bail.

### Docgen
- `plugins/plugin-meta/plugins/parse-utils/core/helpers.ts` — accept `"defineDispatchSlot"`.
- `plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts` — parse it.

### Site 1 — EventRenderer (`jsonl-viewer`)
- `web/slots.ts` — `EventRenderer` → `defineDispatchSlot<{ event: JsonlEvent }, JsonlEvent["kind"]>("…event-renderer", { key: (p) => p.event.kind, fallback: UnknownEventRow, docLabel: (c) => String(c.match) })`. Export `UnknownEventRow` (move it out of `event-row.tsx` or keep co-located and import). `EventRendererContribution` becomes `DispatchContribution`-shaped (drop `kind`, add `match`).
- `web/components/event-row.tsx` — delete the manual `find`; render
  `<JsonlViewer.EventRenderer.Dispatch event={event} />`. Keep `RowMarkdownProvider`,
  the `group/row` wrapper, and `HoverActions` (already isolated via `RowAction.Render`).
- 10 contributors rename `kind:` → `match:`: `summary`, `user-text`, `unknown`,
  `task-notification`, `tool-call`, `attachment`, `assistant-thinking`,
  `user-image`, `system`, `assistant-text` (`…/<plugin>/web/index.ts`).

### Site 2 — tool Renderer (`tool-call`)
- `web/slots.ts` — `Renderer` → `defineDispatchSlot<ToolRendererProps, string>("…tool-renderer", { key: (p) => (p.event as ToolCallEvent).name, fallback: GenericToolView })`. Drop `name?`/`pattern?`, add `match`.
- `web/components/tool-call-row.tsx` — delete `resolveRenderer`; render
  `<JsonlViewerTool.Renderer.Dispatch event={e} />` (keep the `JsonlEvent → ToolCallEvent` cast in the `key` selector, mirroring today's cast).
- 16 contributor calls across `add-task`, `write`, `agent`, `flag-raise`,
  `edit` (×2), `bash`, `ask-user-question`, `task-tools` (×6), `skill`, `read`:
  `name:`→`match:` and `pattern:`→`match:`.

### Site 3 — attachment Renderer (`attachment`)
- `web/slots.ts` — `Renderer` → `defineDispatchSlot<AttachmentRendererProps, string>("…attachment-renderer", { key: (p) => (p.event as AttachmentEvent).subtype, fallback: GenericAttachmentView })`. Drop `subtype`, add `match`.
- `web/components/attachment-row.tsx` — delete `resolveRenderer`; render
  `<JsonlViewerAttachment.Renderer.Dispatch event={e} />`.
- 5 contributors rename `subtype:` → `match:`: `task-reminder`, `nested-memory`,
  `skill-listing`, `command-permissions`, `deferred-tools-delta`.

### Site 4 — Overlay (`jsonl-viewer`)
- `web/slots.ts` — `Overlay` → `defineRenderSlot<OverlayContribution>("…overlay", { reorder: false, docLabel: (p) => p.id })`. Contributions already carry `id` + `component` (no props); no contributor change needed.
- `web/components/jsonl-pane.tsx` — replace `const overlays = …useContributions()`
  and `{overlays.map((o) => <o.component key={o.id} />)}` with
  `<JsonlViewer.Overlay.Render />`. (2 contributors: `task-tools` task-progress
  overlay, `message-toc` — unchanged.)

### Build / docs
- `./equin build` regenerates the slot-render and jsonl-viewer family
  CLAUDE.md / `plugins-details.md`. Commit the regen so `plugins-doc-in-sync`
  passes. (Diff is local to these plugins, since only `defineDispatchSlot` was
  added to the parser.)

## Verification

1. `./equin build` — must succeed (TS compile of the renamed contributions
   proves the uniform `match` types line up; `Key = JsonlEvent["kind"]` will fail
   the build if any `match:` string is not a valid kind).
2. `./equin check` — `eslint`, `plugin-boundaries`, and `plugins-doc-in-sync`
   green.
3. Open a conversation at `http://<worktree>.localhost:9000/c/<id>` and confirm
   the transcript renders normally: tool cards (Bash/Read/Edit), attachments,
   thinking blocks, the task-progress overlay, and the message TOC all appear.
4. **Isolation regression test** — temporarily make one tool renderer throw
   (e.g. `throw new Error("boom")` in `ReadToolView`), rebuild, and confirm:
   only that one row shows the error-boundary fallback (with Retry); the rest of
   the transcript, the hover actions, the overlays, and **both miller panes**
   stay alive. Revert the throw. Use `e2e/screenshot.mjs` to capture before/after.
5. Confirm match precedence: a tool whose name matches both an exact contributor
   and a regex contributor (e.g. an `add_task`-suffixed MCP name) renders the
   exact match when one exists, else the regex one, else `GenericToolView`.

## Critical files
- `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx`
- `plugins/primitives/plugins/slot-render/web/index.ts`
- `plugins/reorder/web/internal/dnd-item-middleware.tsx`
- `plugins/plugin-meta/plugins/parse-utils/core/helpers.ts`
- `plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/slots.ts`
- `…/jsonl-viewer/web/components/event-row.tsx`, `…/jsonl-pane.tsx`
- `…/jsonl-viewer/plugins/tool-call/web/{slots.ts,components/tool-call-row.tsx}`
- `…/jsonl-viewer/plugins/attachment/web/{slots.ts,components/attachment-row.tsx}`
- the 31 contributor `index.ts` files (10 event + 16 tool + 5 attachment)
