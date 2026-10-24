# Reorder areas need a floor: claim items by call path, not by React subtree

## Context

`ReorderItemMiddleware` decides whether a slot contribution becomes a dnd-kit
sortable item with exactly one test
(`plugins/reorder/web/internal/dnd-item-middleware.tsx:22-23`):

```ts
const ctx = useContext(ReorderAreaContext);
if (!ctx) return <>{children}</>;
```

`ReorderAreaContext` is a plain React context, provided **once** by
`<ReorderEditor>` around a whole slot's contribution list
(`plugins/reorder/plugins/editor/web/internal/reorder-editor.tsx:80`). Context has
no depth limit and nothing below resets it, so *"inside a reorder area"* actually
means **"anywhere in the React subtree of a reorder area"** — not "a member of
it".

The other half: `applyItemMiddlewares` runs on **every** slot render path, not
just `.Render`. `.Dispatch` calls it too
(`plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx:496`), as
does `renderIsolated` (`:565`).

So on the public website:

```
WebsiteApps.Section → ReorderEditor → ReorderAreaContext.Provider
  └─ SortableReorderItem  id="…editor-toy:…"        ← legitimate member
       └─ EditorToySection → <BlockEditor persist={false}>
            └─ Editor.Block.Dispatch  (once per block)
                 └─ SortableReorderItem  id="page/text:page.text"   ← N of these
```

`contributionKey()` (`plugins/reorder/web/internal/sorting.ts:40-44`) is
`pluginId:id` off the **contribution**, and a block type registers one
contribution for all its instances. Ten paragraphs → ten
`useSortable({ id: "page/text:page.text" })` in one `DndContext`. Under the Pages
app the same editor renders bare, because `PageDetailBody` mounts `<BlockEditor>`
directly inside `PaneChrome`
(`plugins/apps/plugins/pages/plugins/page-tree/web/panes.tsx:139`) with no area
above it.

Duplicate ids within one `DndContext` are not a supported dnd-kit configuration.
What they actually break has **not** been characterised — this plan removes the
condition rather than the symptom, so that stays an open question either way.

### This is not website-only

A sweep for *"a `.Dispatch` / `renderIsolated` loop inside a render-slot
contribution"* found the leak on four surfaces, three of them shipping app UI.
Duplicate ids need the same matched contribution rendered twice under one ambient
area — i.e. a `.map` whose items dispatch to the same handler:

| Area (render slot) | Contribution | Nested dispatch | Collides when |
|---|---|---|---|
| `task-detail.section` | `TaskEvents` (`plugins/tasks/plugins/task-events/web/components/task-events.tsx:182`) | `Item.Avatar.Dispatch` via `ConversationItem` (`…/conversation-ui/plugins/item/web/components/conversation-item.tsx:35`) | a task has ≥2 conversations matching the same avatar contribution — **the ordinary case**, on a default-visible tab |
| `pages.detail.section` | `StorySection` → `StoryRender` | `Story.Content.Dispatch` (`plugins/apps/plugins/story/plugins/renderers/plugins/slides/web/components/story-content-tree.tsx:24`) | any story with ≥2 nodes of one type; **recurses**, so it compounds with depth |
| `conversation.prompt-bar` | `DependenciesButton` → `InlinePopover` content | `Item.Avatar.Dispatch` via `ConversationItem` | ≥2 dependency conversations of one kind, while the popover is open (portals preserve context ancestry) |
| `website.apps.section` | `EditorToySection` → `BlockEditor` | `Editor.Block.Dispatch` (`plugins/page/plugins/editor/web/components/block-row.tsx:287`) | ≥2 blocks of one type — the originally reported case |

Ruled out on inspection: `.Render`-inside-`.Render` (each mounts a fresh area —
the blessed per-row pattern), and anything reached through
`openDialog` (`imperative-dialog` mounts under `Core.Root`, outside the caller's
context) — which is why the Pages version-history preview is safe.

One fragile near-miss worth knowing: `ui/tab-bar`'s `Tab` calls
`renderIsolated` once per open tab with the same variant contribution, and is safe
only because `AppTabBar` is mounted from the app root with no area above it. If
anything ever renders the apps layout inside a render slot, every open tab
collides. The claim removes that latent hazard too.

Two more consequences of the same root cause, both fixed here:

- A **descriptor-less render slot** nested inside an area inherits it too. With no
  descriptor the list middleware renders `contributions.map(renderItem)` with no
  Provider of its own (`dnd-list-middleware.tsx:163-167`), so its items are
  claimed by whatever area happens to be above.
- The **drag overlay** re-renders the dragged contribution through `renderItem`
  (`dnd-list-middleware.tsx:591-596`), and `DragOverlayWrapper` lives inside the
  same `DndContext` (`sortable-list.tsx:126-131`). So during a drag the dragged id
  is registered **twice** — today, in every reorder area in the app.

### Intended outcome

> A contribution is a sortable item iff it was rendered **as an item of** this
> area — by that area's own `renderItem` call — not merely somewhere underneath
> it.

## Design: a per-item claim, consumed once

The two middlewares compose in a way that makes the call path directly
expressible. In `SlotRender`, `renderItem` applies the item middlewares *inside
itself* (`render-slot.tsx:166-172`), and `ReorderInner` embeds the result as each
entry's `node`. So the list middleware can wrap each `renderItem(...)` result in a
claim provider — which lands **above** the item-middleware element — and the item
middleware consumes it and provides `false` to its own children:

```
Area provider            (orientation / onHide / onRemoveNode — stays ambient)
  └─ Claim.Provider value={true}      ← one per item, from THIS area's renderItem
       └─ ReorderItemMiddleware       ← consumes it; provides false below
            └─ contribution subtree   ← no claim, at any depth
```

Nested `.Dispatch` and `renderIsolated` — the two paths that mount no area of
their own, and exactly where the bug lives — then cannot inherit anything.

Chosen over comparing `ctx.slotId === slotId` because it needs no id comparison
(so it holds even if two slot ids ever coincide), and needs no `slotId` threaded
into `<ReorderEditor>`, preserving that component's deliberate "knows nothing
about slots/config/catalog" property.

### Why the area context itself stays inheritable

A full-repo audit found only three readers of `ReorderAreaContext`: the middleware
itself, `SortableReorderItem` (`items.tsx:99` — `orientation`, `onHide`), and
`SpacerReorderItem` (`:221` — `onRemoveNode`). The latter two are rendered *by*
this area (node types are invoked directly by `ReorderInner.renderNode`, bypassing
`applyItemMiddlewares` entirely), never from inside a contribution's own subtree.
Nothing reads the area context from below a claimed item, so killing the whole
context below an item would buy nothing and would break the container-member path
if the wrapping point ever moved. Keep it ambient; the claim is the floor.

## Changes

All of it is internal to `plugins/reorder/web/internal/` — no barrel change, no
cross-plugin API change, nothing in the `editor` sub-plugin.

**1. New `plugins/reorder/web/internal/item-claim.tsx`**

A `createContext<boolean>(false)` plus nothing else. Boolean, so the value is a
stable primitive and can never churn consumers.

**2. `dnd-item-middleware.tsx` — consume the claim, always reset below**

```tsx
const claimed = useContext(ReorderItemClaimContext);
// …existing ctx / override / key / excluded gates, with `!claimed` added…
return (
  <ReorderItemClaimContext.Provider value={false}>
    {body}
  </ReorderItemClaimContext.Provider>
);
```

Two rules, both load-bearing:

- The reset wraps **every** branch, including the bail-outs. An
  `excludeFromReorder` contribution consumes its claim just the same, or a slot
  nested inside it would pick the claim up.
- The Provider is rendered **unconditionally** — never `claimed ? <Provider> :
  <>`. The element type at that position must not depend on state: this middleware
  sits on an ancestor of `<LexicalComposer>`, and an element-type flip there
  remounts the editor and drops the caret (the hazard already documented at
  `plugins/page/plugins/editor/web/slots.ts:72-81`).

**3. `dnd-list-middleware.tsx` — claim exactly the members of this area**

Wrap the result of `renderItem(...)` at the two sites that render a real member:

- the `entries` memo's item arm (`~:554-560`);
- container members inside `renderNode` (`~:511`).

Deliberately **not** wrapped:

- `renderOverlay` (`~:591-596`) — the overlay is a preview, not a member. This is
  what removes the double registration.
- the no-descriptor fallback (`:166`) — that path has no area of its own, so its
  items should not be claimed by an ancestor's.

## Deltas to expect

- **Blocks on the website stop being sortable items.** Intended.
- **Ordered-dispatch slots never produce sortable items anywhere.**
  `page.editor.block` is in the reorderable manifest and owes an authored config,
  but renders via `.Dispatch` (one match) and mounts no area, so it is now always
  a Fragment. Its config order still feeds the grouped block menus through
  `useReorderedEntries` — unchanged. Worth a line in `reorder/CLAUDE.md`:
  "reorderable slot" and "draggable item" are now formally decoupled.
- **The drag overlay loses its item chrome** (ring / ×-badge) and renders the bare
  contribution inside the existing
  `rounded-md border border-border bg-background/90 shadow-lg` box. Accepted: the
  alternative is extracting a presentational shell out of `SortableReorderItem`,
  which is more surface for a preview-only difference. If the preview looks wrong
  in practice, that extraction is the follow-up — not re-claiming the overlay.
- **Anything else currently sortable only by inheritance loses it.** That set is
  the same unbounded set that made this a bug; the pen edit-mode sweep below is
  how we find out whether any of it was load-bearing.

## Verification

1. `./equin build`, then `./equin check`.
2. **Regression test** — `plugins/reorder/web/__tests__/item-claim.test.tsx`
   (vitest, auto-discovered by the root config; run with
   `bun run test:dom plugins/reorder`). Mount `ReorderAreaContext.Provider` +
   `DndContext`/`SortableContext`, then a claimed `ReorderItemMiddleware` whose
   children contain a second, unclaimed one (simulating the nested `.Dispatch`).
   Assert the first renders a sortable wrapper (`aria-roledescription="sortable"`)
   and the second renders its child bare. If dnd-kit proves awkward under jsdom,
   `vi.mock` `SortableReorderItem` to a marker element — the assertion is about
   which branch the middleware takes, not about dnd-kit.
3. **The four leaking surfaces** (table above). Same console probe on each —
   count `[aria-roledescription="sortable"]` *inside* the nested content; it must
   be `0` after the fix (non-zero before), while the enclosing section keeps
   exactly one.

   **Turn pen edit mode ON first, or the probe proves nothing.**
   `SortableReorderItem` passes `disabled={!editMode}`, dnd-kit returns
   `listeners: undefined` when disabled, and `SortableItem` then spreads no
   attributes at all (`sortable-item.tsx:39`) — so the marker is absent
   everywhere outside edit mode and reads `0` both before and after. (The
   registration itself is not gated on edit mode; only this DOM marker is.)
   - `/website/apps` → inside the editor toy:
     `document.querySelectorAll('[data-block-id] [aria-roledescription="sortable"]').length`
   - a task with ≥2 conversations → task detail, Events section (the most common
     instance, and the one to check first)
   - a conversation whose task has ≥2 dependency conversations → open the
     dependencies popover
   - a page with a Story section containing ≥2 nodes of one type
4. **Pages is unchanged** — `/pages`, open a page: typing, Enter/Backspace,
   indent/outdent and caret behaviour identical (this path already had a null
   context, so a regression here means the unconditional Provider disturbed the
   element chain).
5. **Pen edit-mode sweep**, since the middleware is app-wide: toggle edit mode and
   drag one item in the agent-manager sidebar/toolbar, a conversation section, and
   the Settings → Config `reorder-tree` field editor (a second, independent
   `<ReorderEditor>` consumer that builds its own chips and never goes through the
   middleware — it must be unaffected). Confirm drag, hide/restore, Add Spacer and
   container collapse still work, and check the drag overlay looks acceptable.
6. Update `plugins/reorder/CLAUDE.md`: state the claim invariant, that an area is
   floored at its own items, and the reorderable-slot ≠ draggable-item decoupling.

## Out of scope

- Characterising what the duplicate ids currently break on the website.
- `contributionKey` being per-contribution rather than per-instance. It is correct
  for a render slot (one contribution = one rendered thing); the claim makes the
  mismatch unreachable rather than fixing the key, which is the right order —
  changing the key would change persisted `ReorderTree` `entryKey`s.
- Promoting the floor to a lint rule or `./equin check`. There is no static
  signal for "rendered beneath an area", so the vitest regression is the guard.
