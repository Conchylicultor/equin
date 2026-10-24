# Conversations-list view abstraction

## Context

Today the conversations sidebar list has exactly one rendering: a grouped/DnD view. The host plugin `conversations-view` ships the `Shell.Sidebar` entry, fetches data + handles "Closed" pagination, then **directly imports** `GroupedConversationList` from sibling plugin `conversation-groups` and renders it. There is no extension point.

We want multiple views of the same list (current "Grouped", future "History" — flat chronological, "Queue" — different sort/filter, etc.) and the ability to switch between them in the sidebar. To do that cleanly, `conversations-view` needs to become a host that owns chrome (launch buttons + a view-switcher) and exposes a slot every view contributes to. The current grouped view becomes the first contributor and gets re-nested under `conversations-view` as `plugins/grouped/`. Each view owns its own data fetching and toolbar — only navigation primitives are shared.

This change is purely structural: zero behavior change for the user today (one view registered → switcher hides, looks identical), and a one-line `ConversationsView.View({...})` plug for every future view.

## Design

### New slot: `ConversationsView.View`

Defined at `plugins/conversations/plugins/conversations-view/web/slots.ts` (new file), shape modeled on `JsonlViewer.EventRenderer` (`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/slots.ts`):

```ts
export const ConversationsView = {
  View: defineSlot<{
    id: string;        // stable slug; used as localStorage key value
    title: string;     // switcher tab label
    icon: ComponentType<{ className?: string }>;
    order?: number;    // switcher tab order (lower first)
    component: ComponentType<{
      activeId: string | null;
      onNavigate: (id: string) => void;
      onCloseConversation: (id: string, e: React.MouseEvent) => Promise<void>;
    }>;
  }>("conversations-view.view"),
};
```

The component's prop signature **is** the shared contract: `activeId / onNavigate / onCloseConversation`. Anything else (data, sub-toolbar, empty state, pagination) is view-private.

### Host responsibilities (`ConversationList`)

After the refactor, `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` keeps only:

1. **Sticky toolbar** with `LaunchButtons` (always shared) + a view-switcher segmented control rendered from `ConversationsView.View.useContributions()`. Hide the switcher when ≤1 view is registered (zero UI churn until a second view exists).
2. **`activeId` tracking** from URL (already there; lines 25-27, 45-53). Stays in the host so every view receives it.
3. **`navigate(id)` and `closeConversation(id, e)`** helpers (already there; lines 111-119). Stay in the host and pass into the active view.
4. **localStorage-backed active view id** under key `"conversations-view:active-view"` (matches existing convention from `conversation-list.tsx:10` and `grouped-conversation-list.tsx:42-43` — same `try/catch`, same key format). Default = lowest-`order` contribution if no stored value.
5. **`ConvCountLabel`** (already a separate `labelExtra` slot value; unchanged) and **`ForkErrorWatcher`** (already a separate `Core.Root` contribution; unchanged).

Everything that moves out of the host:
- `useConversations()` call
- `showSystem` state + visibility toggle button (lines 28-43, 127-142)
- Gone-pagination (`useInfiniteQuery`, `cursorRef`, `liveIds`, `paginatedItems`, sentinel + `IntersectionObserver`; lines 56-109, 154-157)
- "No conversations" empty state (line 158-162)
- The `<GroupedConversationList />` render

### View responsibilities (grouped view)

After the move, `plugins/conversations/plugins/conversations-view/plugins/grouped/web/` owns all of the above. The new `web/components/grouped-view.tsx`:

- Receives `{ activeId, onNavigate, onCloseConversation }` props from the slot.
- Calls `useConversations()` itself.
- Owns `showSystem` localStorage state + the visibility toggle button (renders it in its own header above the list).
- Owns the gone-pagination logic copied verbatim from today's `ConversationList`.
- Renders the existing grouped/DnD content (the current `grouped-conversation-list.tsx` body becomes internal — no longer exported).

The plugin's barrel adds the slot contribution:
```ts
ConversationsView.View({
  id: "grouped",
  title: "Grouped",
  icon: MdGroupWork,
  order: 10,
  component: GroupedView,
})
```
and **drops** the `GroupedConversationList` re-export (no longer used by anyone).

## Migration steps

### 1. Move `conversation-groups` → `conversations-view/plugins/grouped/`

- `git mv plugins/conversations/plugins/conversation-groups plugins/conversations/plugins/conversations-view/plugins/grouped`
- Rename `package.json` `name` → `@singularity/plugin-conversations-conversations-view-grouped` (matches convention: path segments joined by `-` after `@singularity/plugin-`, see `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/user-text/package.json`).
- Keep web `id: "conversation-groups"` unchanged in the barrel (it's the runtime plugin id; renaming would only add churn, and the DB tables under `server/internal/tables.ts` stay put either way — Drizzle is content-based, not path-based).
- Update import paths in:
  - `web/src/plugins.ts` (one import line + array entry — `@plugins/conversations/plugins/conversation-groups/web` → `@plugins/conversations/plugins/conversations-view/plugins/grouped/web`)
  - `server/src/plugins.ts` (same path swap on the server side)
  - The host's `conversation-list.tsx` import (about to be removed in step 4 anyway)
- Run `bun install` so the workspace re-links the renamed package.

### 2. Define the slot

Create `plugins/conversations/plugins/conversations-view/web/slots.ts` with the `ConversationsView` namespace shown above.

Export it from `plugins/conversations/plugins/conversations-view/web/index.ts` (re-export `* from "./slots"`).

### 3. Build the grouped view component

Create `plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/grouped-view.tsx`. Move into it:
- `useConversations()` call
- `showSystem` state + toggle button (now rendered as the view's own header row, above the list)
- Pagination (`useInfiniteQuery`, `cursorRef`, sentinel, `liveIds`, `paginatedItems`)
- "No conversations" empty state
- Render of the existing `GroupedConversationList` body (stays in `grouped-conversation-list.tsx`, now internal)

Update `plugins/conversations/plugins/conversations-view/plugins/grouped/web/index.ts`:
- Drop the `export { GroupedConversationList }` and `export type { GroupedConversationListProps }` lines.
- Add the `ConversationsView.View({ id: "grouped", ... })` contribution.

### 4. Refactor host `ConversationList`

Edit `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`:
- Remove imports of `useConversations`, `GonePageSchema`, `GroupedConversationList`, `useInfiniteQuery`, `MdVisibility/Off`.
- Remove all data fetching, pagination, `showSystem` state.
- Keep `activeId` URL tracking, `navigate`, `closeConversation`.
- Add `const views = ConversationsView.View.useContributions()` (sorted by `order ?? 0`).
- Add `activeViewId` state with localStorage read/write under `"conversations-view:active-view"`. Fall back to `views[0]?.id` when stored value isn't a registered id.
- Render the sticky toolbar: `<LaunchButtons />` + switcher segmented control (only when `views.length > 1`).
- Mount the active view's component: `<ActiveView.component activeId={activeId} onNavigate={navigate} onCloseConversation={closeConversation} />`.

### 5. Docs + checks

- `./equin check --plugin-boundaries` — confirms no deep imports leaked.
- `./equin build` — regenerates `docs/plugins-compact.md` and `docs/plugins-details.md` autogen blocks (the `plugins-doc-in-sync` check picks up the new slot definition + the moved sub-plugin).
- Spot-edit the hand-written sections of `plugins/conversations/plugins/conversations-view/CLAUDE.md` and `plugins/conversations/plugins/conversations-view/plugins/grouped/CLAUDE.md` if they say anything that rotted.

## Critical files

**New:**
- `plugins/conversations/plugins/conversations-view/web/slots.ts`
- `plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/grouped-view.tsx`

**Modified:**
- `plugins/conversations/plugins/conversations-view/web/index.ts` (re-export slots)
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` (becomes chrome only)
- `plugins/conversations/plugins/conversations-view/plugins/grouped/web/index.ts` (was `conversation-groups/web/index.ts` — adds slot contribution, drops re-exports)
- `plugins/conversations/plugins/conversations-view/plugins/grouped/package.json` (renamed name)
- `web/src/plugins.ts` (import path update)
- `server/src/plugins.ts` (import path update)

**Moved (no content change beyond imports):**
- Entire `plugins/conversations/plugins/conversation-groups/` tree → `plugins/conversations/plugins/conversations-view/plugins/grouped/` (web + server + DB schema + CLAUDE.md).

## Verification

1. `./equin check` — boundaries + migrations-in-sync + plugins-doc-in-sync all pass.
2. `./equin build` — builds and restarts cleanly.
3. Open `http://<worktree>.localhost:9000/` and confirm:
   - Conversations sidebar renders identically to today (only one view registered → no switcher tab visible).
   - Drag/drop grouping still works (DB rows untouched: same tables, same package, just at a new path).
   - "Show system" toggle still works and persists across reloads (`localStorage` key unchanged: `conversations-view:show-system`).
   - "Closed" infinite scroll still works.
   - Active view persistence: open devtools → Application → Local Storage → confirm `conversations-view:active-view` is `"grouped"` after first load.
4. Smoke a fake second view to prove the abstraction works: temporarily add a second `ConversationsView.View({...})` contribution rendering a placeholder `<div>history</div>`, confirm the switcher appears, the persisted selection round-trips a reload, then revert.
