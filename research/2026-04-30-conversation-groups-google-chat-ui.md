# Conversation Groups — Google Chat-inspired UI redesign

## Context

The `conversation-groups` plugin currently renders user-defined groups (`GroupBox`) and task-derived auto-groups (`AutoGroupBox`) as two visually distinct boxy containers (solid border for user groups, dashed border for auto-groups), with chrome that is always visible. Drag-and-drop works but provides no special affordance: users must drop a conversation onto an existing group's body, and there is no way to create a new group via drag.

Inspired by Google Chat's group/section UI, this redesign focuses on three changes to the **outer group container** (inner conversation rows are out of scope):

1. **Flat by default.** Groups have no borders or background by default; subtle hover and drag-over states reveal chrome.
2. **Collapse-on-drag.** Starting a drag visually collapses every group to its header so any drop target is reachable without scrolling. Hovering a collapsed group's header for ~500ms expands it during the drag, letting users drop into a specific position. Persisted expand state is untouched.
3. **"Drop here to create a new group" zone** at the top of the list, shown during any drag. Dropping a conversation there creates a fresh group containing it and immediately focuses the rename input.

The user also called out that user-groups and auto-groups currently look inconsistent — they should be unified into a single primitive, with the auto-group's merge-icon being the only differentiating cue.

## Files to modify (web only)

- `plugins/conversations/plugins/conversation-groups/web/components/group-box.tsx` — refactored to render via the new shared primitive
- `plugins/conversations/plugins/conversation-groups/web/components/auto-group-box.tsx` — refactored to render via the new shared primitive
- `plugins/conversations/plugins/conversation-groups/web/components/grouped-conversation-list.tsx` — adds drag-in-progress prop drilling, the "create new group" drop zone, and post-drop focus orchestration
- `plugins/conversations/plugins/conversation-groups/web/components/group-rename.tsx` — adds optional `autoFocus` prop for the drop-to-create flow

## New files

- `plugins/conversations/plugins/conversation-groups/web/components/group-container.tsx` — **new shared primitive** owning all outer chrome: hover/drag-over visuals, expand chevron, droppable wrapper, collapse-on-drag override, hover-dwell expand, slotted header content (rename input or static title) and slotted body. Both `GroupBox` and `AutoGroupBox` become thin wrappers that pass props.
- `plugins/conversations/plugins/conversation-groups/web/components/new-group-drop-zone.tsx` — **new** the dashed pill drop target rendered above the list while a drag is in progress.

No changes to server, schema, or shared types. The existing `POST /api/conversation-groups` endpoint already supports `{ conversationIds: [convId] }` for the create-on-drop flow.

## Key implementation details

### 1. Shared `GroupContainer` primitive

Owns:
- A `useDroppable` registration scoped to a caller-provided `droppableId` and `dropData` (so user-groups still drop as `kind: "group"`, auto-groups as `kind: "auto-group"`, etc.).
- Outer container styling — no border or background by default; on `:hover` shows `border-border/40 bg-muted/10`; on `droppable.isOver` shows `border-primary/60 bg-accent/40`. Implement via `group/box` named class + `group-hover/box:border-border/40` rather than the `:hover` pseudo-class so child interactions don't flicker the border.
- Header row with chevron (left), title slot (the caller's `<GroupRename>` or static title element), and a right-side action slot for delete / merge-icon / etc.
- Effective expand state computed as:
  ```ts
  const expanded = (dragInProgress ? dwellExpanded : persistedExpanded);
  ```
  When `dragInProgress` flips `true`, all groups visually collapse. `dwellExpanded` is local state set to `true` after `droppable.isOver` has been continuously true for 500ms (see `useDwellExpand` below). When the drag ends, `dragInProgress` returns to `false` and `persistedExpanded` takes over again — naturally restoring per-group state without writes.
- A small `useDwellExpand(isOver, delayMs = 500)` helper inside the same file: `useRef<NodeJS.Timeout>`, set on `isOver` rising edge, clear on falling edge or unmount.

### 2. Drag-in-progress prop drilling

Reuse the existing `activeConvId` already tracked in `GroupedConversationList` (`grouped-conversation-list.tsx:148-156`). Pass `dragInProgress = activeConvId != null` as a prop down to every `<GroupBox>` and `<AutoGroupBox>`, which forward it to `<GroupContainer>`. No new context, no `useDndMonitor`.

### 3. New-group drop zone

`new-group-drop-zone.tsx` renders only when `dragInProgress` is true. It registers a droppable with `id: "drop-new-group"` and `data: { kind: "new-group" } as const`. Visual: dashed pill with subtle text "Drop here to create a new group". When `isOver`, swap to accent ring.

Add `"new-group"` to the `DropTarget` discriminated union in `draggable-row.tsx`. In `grouped-conversation-list.tsx::onDragEnd`, add a fourth branch:

```ts
if (target.kind === "new-group") {
  const res = await fetch("/api/conversation-groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationIds: [convId] }),
  });
  const { id } = await res.json();
  setPendingFocusGroupId(id);  // triggers <GroupRename autoFocus> on the next render
}
```

### 4. Imperative rename focus after drop-to-create

Smallest change: add an `autoFocus?: boolean` prop to `GroupRename`. When `true`, an internal `useEffect` runs `inputRef.current?.focus(); inputRef.current?.select()` once on mount. (Add `useRef<HTMLInputElement>` to the existing `<input>`.)

In `grouped-conversation-list.tsx`, hold `pendingFocusGroupId` state. Pass `autoFocus={group.id === pendingFocusGroupId}` to the matching `<GroupRename>`. Clear `pendingFocusGroupId` after the focus has been applied (e.g. inside `GroupRename`'s effect via an `onFocused?: () => void` callback). This avoids re-focusing on subsequent renders.

### 5. Auto-group / user-group unification

Both boxes now share `<GroupContainer>`. The remaining differences are passed in as slots/props:
- User-group → `<GroupRename>` in the title slot, `<DeleteButton>` in the right-action slot, `expanded` from server.
- Auto-group → `<GroupRename>` in the title slot too (it has its own `onSave`), the merge `MdCallMerge` icon in the right-action slot, `expanded` from localStorage.

This eliminates the dashed-vs-solid inconsistency and the right-vs-left chevron divergence (current `auto-group-box.tsx` puts the chevron on the right; the unified primitive puts it on the left, matching `group-box.tsx`).

### 6. What we're explicitly *not* changing

- Inner conversation row visuals (`draggable-row.tsx` body, `ConversationItem`).
- Server schema, endpoints, or any persisted state shape.
- `useTaskAutoGroups` derivation logic.
- The `DndContext` location, sensor config, or collision detection.
- `auto-group:collapsed:<key>` localStorage key — still used for auto-groups' `persistedExpanded`.
- `expanded` DB column on `conversation_groups` — still the source of truth for user-groups' `persistedExpanded`.

## Verification

After implementing, deploy with `./equin build` and load `http://<worktree>.localhost:9000`. Then in the conversations sidebar:

1. **Default look** — groups should have no border or background. Hovering a group reveals a subtle border + background. Auto-groups and user-groups look identical except for the merge icon.
2. **Collapse-on-drag** — start dragging a conversation. All groups collapse to header rows immediately. Release without dropping (Esc or drop outside) — groups restore to their previous expanded/collapsed state without any server write (verify via DevTools Network panel: zero `PATCH /api/conversation-groups` calls during drag/cancel).
3. **Hover-dwell** — start a drag, hover a collapsed group's header without releasing. After ~500ms it expands. Move away — it collapses again. Drop into a specific row inside the dwell-expanded group; verify position is honored.
4. **New-group drop zone** — start a drag of any conversation (grouped or ungrouped). The dashed pill appears at the top. Drop onto it. Verify a new group is created with that conversation as its only member, and the group's title input is focused and selected. Type a name, press Enter — verify it persists.
5. **Drop into existing group via collapsed header** — drag a conversation, drop directly on a collapsed group's header (no dwell). Verify it joins that group. Reload — verify membership persisted.
6. **Auto-group → user-group promotion** — drag from an auto-group onto an existing user-group. Existing path still works.
7. **No regressions** — close conversation button, delete-group button, rename existing group still work.

Run `./equin check --plugin-boundaries` to confirm no new cross-plugin violations.
