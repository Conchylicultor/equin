# Pane Chain Restore per Conversation

## Context

When switching conversations in the sidebar, the entire pane chain resets to bare `/c/<convId>`. All sub-panes (terminal, file viewer, tasks panel, etc.) are lost. The user wants navigating back to a conversation to restore the pane layout they had before.

## Approach

Save `Array<{ paneId, params }>` to localStorage on every chain change when the root pane is a conversation. On sidebar navigation to a conversation, check for a saved chain and restore it instead of opening a bare root.

## Implementation

### 1. Export `restoreChain` from the pane primitive

**File:** `plugins/primitives/plugins/pane/web/pane.ts`

Add a new exported function that takes `Array<{ paneId, params }>` (no instanceId — those are ephemeral), assigns fresh instanceIds via `createSlot()`, validates via `validateChain()`, builds the URL via `buildChainUrl()`, and navigates via `applyBasePath()` + `pushState` + event dispatch. This must live inside `pane.ts` because `applyBasePath`, `createSlot`, and `validateChain` are all internal.

**File:** `plugins/primitives/plugins/pane/web/index.ts`

Add `restoreChain` to the barrel exports.

### 2. Create `pane-restore` plugin

**New:** `plugins/conversations/plugins/pane-restore/web/internal/pane-restore-store.ts`

Module-level store with:
- `saveChainForConversation(convId, slots)` — writes to localStorage key `miller.chain.<convId>` as `{ v: slots, ts: timestamp }` envelope
- `loadChainForConversation(convId)` — reads and validates TTL (30 days)
- Module-level listeners on `popstate` + `shell:navigate` that auto-save the current chain when root pane is `"conversation"`. Uses 50ms trailing debounce to skip transitional states during rapid navigation.

Saves for any chain depth (including depth=1 bare conversation) so that manually closing sub-panes correctly overwrites a previous deeper save. The restore side gates on `length > 1`.

**New:** `plugins/conversations/plugins/pane-restore/web/index.ts`

Plugin definition with `contributions: []`. Side-effect import of the store module to register listeners. Exports `loadChainForConversation` for use by `conversation-list.tsx`.

Plugin registration is automatic — `./equin build` regenerates `plugins.generated.ts` from the filesystem.

### 3. Wire restore into sidebar navigation

**File:** `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`

Change the `navigate` function from:
```ts
const navigate = (id: string) => {
  openPane(conversationPane, { convId: id }, { mode: "root" });
  setActiveId(id);
};
```
to:
```ts
const navigate = (id: string) => {
  const saved = loadChainForConversation(id);
  if (saved && saved.length > 1) {
    restoreChain(saved);
  } else {
    openPane(conversationPane, { convId: id }, { mode: "root" });
  }
  setActiveId(id);
};
```

Only the sidebar gets restore behavior. Other entry points (welcome page, task events, agent launches) intentionally bypass it — when jumping to a conversation from a task event, the user expects to land on the conversation, not a restored layout.

## Edge cases

- **Stale chain entries:** `validateChain` inside `restoreChain` truncates at the first unknown pane. If a pane plugin is removed, the chain degrades gracefully to whatever prefix is still valid.
- **Registry timing:** The pane registry is populated by `useSyncPaneRegistry()` during the first `MillerColumns` render. The sidebar's `navigate()` fires from user clicks after mount — safe.
- **Manually closed sub-panes:** Saving at any depth (including 1) means closing all sub-panes updates the saved state. On next visit, `saved.length <= 1` triggers the normal `openPane` path.
- **Rapid switching:** 50ms debounce on save prevents writing transitional states.

## Files changed

| File | Action |
|---|---|
| `plugins/primitives/plugins/pane/web/pane.ts` | Add `restoreChain()` |
| `plugins/primitives/plugins/pane/web/index.ts` | Export `restoreChain` |
| `plugins/conversations/plugins/pane-restore/web/internal/pane-restore-store.ts` | New — save/load store |
| `plugins/conversations/plugins/pane-restore/web/index.ts` | New — plugin definition |
| `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` | Use `loadChainForConversation` in `navigate()` |

## Verification

1. `./equin build` — deploys successfully
2. Open a conversation → open terminal pane and file viewer
3. Click a different conversation in sidebar
4. Click back to the first conversation → terminal + file viewer should be restored
5. Open a conversation → manually close all sub-panes → navigate away → navigate back → should show bare conversation (no stale restore)
6. Rapid-click between 3+ conversations → each should restore its own layout
