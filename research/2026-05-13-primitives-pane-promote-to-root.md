# Pane Chrome: Promote to Root

## Context

The Miller columns layout chains panes left-to-right (root -> leaf). Users often want to "detach" a nested pane and make it the root of a fresh chain — e.g. when a conversation is embedded under a task view and the user wants to focus on it. Today this is handled by a bespoke `ExpandConversationButton` that calls `openPane(conversationPane, params, { root: true })`, but every pane could benefit from this affordance.

The `chrome.expand` option exists but serves a different purpose: it navigates to an arbitrary URL (used by 2 side-panes that redirect to a different view entirely). The new "promote" is generic and automatic — no per-pane URL builder needed.

## Design

### New `chrome.promote` option (default: true)

Add `promote?: boolean` to `PaneChromeConfig`. Defaults to `true` — every pane with chrome gets a promote button unless it opts out.

**Visibility:** `chrome.promote && !chrome.expand && depth > 0`
- `depth > 0` — already root means nothing to promote
- `!chrome.expand` — panes with URL-redirect expand keep that behavior instead (side-panes)
- `chrome.promote` — opt-out escape hatch

### Button behavior

Collects `fullParams` from the chain (root through this pane's position), then calls `openPaneImpl(internal, fullParams, { root: true })`. This builds a minimal ancestor chain with this pane as the focus — exactly `buildFreshChain()`.

### Relationship to `chrome.expand`

They're mutually exclusive in the chrome header:
- `expand` defined -> show expand button (URL redirect)
- `expand` NOT defined, `promote` true -> show promote button
- Neither -> no button

Both use the `MdOpenInFull` icon. Same position in the header (before close button).

### Supersedes `ExpandConversationButton`

The generic promote button replaces the manual `ExpandConversationButton` component. The conversation pane has no `chrome.expand` and no `after: [null]` constraint, so promote works correctly: shows at depth > 0, hides at root.

## Implementation

### 1. `plugins/primitives/plugins/pane/web/pane.ts`

- Add `promote?: boolean` to `PaneChromeConfig<Params>`
- Add `promote: boolean` to `NormalizedChrome`
- Update `normalizeChrome()`: default `promote` to `true` (and `false` when `chrome === false`)
- Add `promote(): void` to `PaneObject` interface
- Implement `promote()` in `makePaneObject()`:
  ```ts
  function promote(): void {
    if (typeof window === "undefined") return;
    const chain = getChain();
    const idx = chain.findIndex((s) => s.paneId === internal.id);
    if (idx < 0) return;
    const fullParams: Record<string, string> = {};
    for (let i = 0; i <= idx; i++) {
      Object.assign(fullParams, chain[i]!.params);
    }
    openPaneImpl(internal, fullParams, { root: true });
  }
  ```

### 2. `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx`

After `showClose` computation, add:
```tsx
const showPromote = chrome.promote && !chrome.expand && depth > 0;
```

Render promote button after the expand block, before the close button:
```tsx
{showPromote && (
  <Button variant="ghost" size="sm" onClick={() => pane.promote()} aria-label="Promote">
    <MdOpenInFull className="size-4" />
  </Button>
)}
```

### 3. Remove `ExpandConversationButton`

- Delete `plugins/conversations/plugins/conversation-view/web/components/expand-button.tsx`
- Update `plugins/conversations/plugins/conversation-view/web/index.ts`:
  - Remove `ExpandConversationButton` import
  - Remove `ActionBarConversation` import
  - Remove the `ActionBarConversation.ActionBar(...)` contribution

### 4. Update pane CLAUDE.md

Add `promote: false` documentation alongside existing `close: false` docs.

## Files

| File | Change |
|------|--------|
| `plugins/primitives/plugins/pane/web/pane.ts` | Add promote to types, normalizer, PaneObject |
| `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx` | Render promote button |
| `plugins/conversations/plugins/conversation-view/web/index.ts` | Remove ExpandConversationButton contribution |
| `plugins/conversations/plugins/conversation-view/web/components/expand-button.tsx` | Delete |
| `plugins/primitives/plugins/pane/CLAUDE.md` | Document promote opt-out |

## Verification

1. `./equin build`
2. Open a conversation via tasks view (nested, depth > 0) — promote button should appear
3. Click promote — conversation becomes root of chain at `/c/:convId`
4. Open a conversation directly (`/c/:convId`) — no promote button (depth 0)
5. Open a side-task pane — should still show the old expand button (redirects to `/tasks/:id`)
6. Verify no regressions with existing expand behavior
