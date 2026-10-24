# Migrate BURNDOWN `void fetchEndpoint` → `useEndpointMutation`

## Context

The `endpoints/no-void-fetch-endpoint` lint rule bans `void fetchEndpoint(...)` because a non-2xx response throws an unhandled rejection that escapes to `window.onunhandledrejection` — recorded as a contextless `browser-rejection` crash, never a user-facing toast. The config_v2 sites that triggered the original crash have already been migrated. The remaining exemptions in `plugins/infra/plugins/endpoints/lint/index.ts` fall into two categories:

- **PERMANENT** — genuine fire-and-forget (DnD rank writes, toggle-state writes backed by live-state WS push). Leave these alone.
- **BURNDOWN** — user-triggered mutations (delete, rerank, scope fork/delete, block update). These are the target of this migration.

After migrating, the 3 file-glob BURNDOWN entries in `lint/index.ts` are removed, and the inline `// eslint-disable-next-line ... TODO(task-1781184772731-0e1w2e)` comments in the 3 mixed files are dropped. The rule must stay green with no new exemptions added.

---

## `useEndpointMutation` API recap

```typescript
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";

const { mutate } = useEndpointMutation(endpoint, opts?);
// mutate({ params?, body? }) — fire-and-forget; global toast on error (zero boilerplate)
// No opts needed for the default "global toast" behavior.
// The `mutate` function is reference-stable across renders (TanStack Query internals).
```

---

## Files to edit (7 total)

### 1. `plugins/infra/plugins/endpoints/lint/index.ts` — remove 3 BURNDOWN glob entries

Remove lines 84–86 (the 3 file paths under the BURNDOWN block):
```
"plugins/ui/plugins/tweakcn/plugins/community-browser/web/components/community-browser-section.tsx",
"plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx",
"plugins/apps/plugins/sonata/plugins/library/web/components/song-card.tsx",
```

---

### 2. `plugins/apps/plugins/sonata/plugins/library/web/components/song-card.tsx` — simplest: one call, no existing hooks

**Import change:** `fetchEndpoint` → `useEndpointMutation`

**Hook addition** at top of `SongCard` body:
```typescript
const { mutate: deleteSongMutation } = useEndpointMutation(deleteSong);
```

**Call-site change** (delete button onClick):
```typescript
// Before:
void fetchEndpoint(deleteSong, { id: song.id });
// After:
deleteSongMutation({ params: { id: song.id } });
```

---

### 3. `plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx` — one BURNDOWN call; other fetchEndpoint calls are non-voided (leave them)

**Import change:** Add `useEndpointMutation` to the existing `fetchEndpoint` import (keep `fetchEndpoint` — other calls use it without `void`).

**Hook addition** inside `QueueView` body (near other state declarations):
```typescript
const { mutate: rerankMutation } = useEndpointMutation(rerankQueue);
```

**Call-site change** ("Add to queue" button onClick, line 485):
```typescript
// Before:
void fetchEndpoint(rerankQueue, {}, { body: { conversationId: conv.id } })
// After:
rerankMutation({ body: { conversationId: conv.id } })
```

---

### 4. `plugins/ui/plugins/tweakcn/plugins/community-browser/web/components/community-browser-section.tsx` — loop inside onSuccess callback

The file already imports and uses `useEndpointMutation` (for `applyCatalogTheme`). Remove `fetchEndpoint` from the import.

**Hook addition** inside `CommunityBrowserSection` body (after `applyMutation`):
```typescript
const { mutate: setConfigMutation } = useEndpointMutation(setConfigField);
```

**`handleApply` change** — replace the `void fetchEndpoint(setConfigField, ...)` inside the `forEach` loop:
```typescript
// Before:
void fetchEndpoint(setConfigField, {}, {
  body: scopeId
    ? { storePath: reg.storePath, key: "preset", value: presetId, scopeId }
    : { storePath: reg.storePath, key: "preset", value: presetId },
});
// After:
setConfigMutation({
  body: scopeId
    ? { storePath: reg.storePath, key: "preset", value: presetId, scopeId }
    : { storePath: reg.storePath, key: "preset", value: presetId },
});
```

Note: Calling `mutate()` in a loop is fine — each call is independent; the global toast fires per failure.

---

### 5. `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer.tsx` — two BURNDOWN inline-disables in `CustomizeForAppToggle`

**Import change:** Add `useEndpointMutation` to the existing `fetchEndpoint` import (keep `fetchEndpoint` — the `GlobalPresetPicker` fire-and-forget line stays).

**Hook additions** inside `CustomizeForAppToggle` body:
```typescript
const { mutate: deleteScopeMutation } = useEndpointMutation(deleteScope);
const { mutate: forkScopeMutation } = useEndpointMutation(forkScope);
```

**`onToggle` rewrite** — drop both `// eslint-disable-next-line` comments and both `void fetchEndpoint` calls:
```typescript
// Before:
const onToggle = () => {
  if (forked) {
    // eslint-disable-next-line endpoints/no-void-fetch-endpoint -- TODO(task-1781184772731-0e1w2e): ...
    void fetchEndpoint(deleteScope, {}, { body: { scopeId } });
  } else {
    // eslint-disable-next-line endpoints/no-void-fetch-endpoint -- TODO(task-1781184772731-0e1w2e): ...
    void fetchEndpoint(forkScope, {}, { body: { scopeId } });
  }
};
// After:
const onToggle = () => {
  if (forked) {
    deleteScopeMutation({ body: { scopeId } });
  } else {
    forkScopeMutation({ body: { scopeId } });
  }
};
```

---

### 6. `plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/grouped-conversation-list.tsx` — one BURNDOWN inline-disable (X button in renderRow)

**Import change:** Add `useEndpointMutation` to the existing `fetchEndpoint` import (keep `fetchEndpoint` — many awaited calls and DnD fire-and-forget calls remain).

**Hook addition** inside `GroupedConversationList` body:
```typescript
const { mutate: removeMemberMutation } = useEndpointMutation(removeConversationGroupMember);
```

**Call-site change** (`renderRow` SidebarMenuAction onClick, line ~374) — drop the `// eslint-disable-next-line` comment:
```typescript
// Before:
// eslint-disable-next-line endpoints/no-void-fetch-endpoint -- TODO(task-1781184772731-0e1w2e): ...
void fetchEndpoint(removeConversationGroupMember, { conversationId: conv.id });
// After:
removeMemberMutation({ params: { conversationId: conv.id } });
```

`renderRow` is an inner function (not a component) that closes over `removeMemberMutation` from the enclosing component — standard React pattern, no issues.

---

### 7. `plugins/page/plugins/editor/web/block-editor-context.tsx` — three BURNDOWN inline-disables across two callbacks

**Import change:** Add `useEndpointMutation` to the existing `fetchEndpoint` import (keep `fetchEndpoint` — `bulkMove`, `move`, `dispatchOp` have permanent fire-and-forget exemptions; `bulkDuplicate` and `paste` are awaited).

**Hook additions** inside `BlockEditorProvider` body (after `focusBlock`, before the callbacks):
```typescript
const { mutate: bulkDeleteMutation } = useEndpointMutation(bulkDeleteBlocks);
const { mutate: updateBlockMutation } = useEndpointMutation(updateBlock);
```

The `mutate` function is reference-stable across renders (TanStack Query wraps it in a ref internally), making it safe to include in `useCallback` deps.

**`bulkDelete` callback change** — drop eslint-disable comment, update call and deps:
```typescript
// Before deps:
[pageId]
// After deps:
[pageId, bulkDeleteMutation]

// Before call (line 141):
// eslint-disable-next-line endpoints/no-void-fetch-endpoint -- TODO(...)
void fetchEndpoint(bulkDeleteBlocks, { pageId }, { body: { ids } });
// After:
bulkDeleteMutation({ params: { pageId }, body: { ids } });
```

**`makeBlockAPI` callback changes** — drop 2 eslint-disable comments, update both calls and deps:
```typescript
// Before deps (line 357):
[pageId, dispatchOp, focusNew, focusBlock]
// After deps:
[pageId, dispatchOp, focusNew, focusBlock, updateBlockMutation]

// Before update() (line 238-239):
// eslint-disable-next-line endpoints/no-void-fetch-endpoint -- TODO(...)
void fetchEndpoint(updateBlock, { id: blockId }, { body: { data } });
// After:
updateBlockMutation({ params: { id: blockId }, body: { data } });

// Before convertTo() (line 246-247):
// eslint-disable-next-line endpoints/no-void-fetch-endpoint -- TODO(...)
void fetchEndpoint(updateBlock, { id: blockId }, { body: { type, data, ...(opts ?? {}) } });
// After:
updateBlockMutation({ params: { id: blockId }, body: { type, data, ...(opts ?? {}) } });
```

---

## Execution order

1. `song-card.tsx` — simplest, isolated
2. `queue-view.tsx` — one void call
3. `community-browser-section.tsx` — loop, but existing mutation already present
4. `theme-customizer.tsx` — two calls in a sub-component
5. `grouped-conversation-list.tsx` — one call in an inner function
6. `block-editor-context.tsx` — most changes, two mutation hooks, deps update
7. `lint/index.ts` — remove 3 glob entries (do last, after all 3 pure-burndown files are migrated)

---

## Verification

```bash
# Confirm no remaining BURNDOWN void calls in the 3 pure-burndown files:
rg "void fetchEndpoint" \
  plugins/apps/plugins/sonata/plugins/library/web/components/song-card.tsx \
  plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx \
  plugins/ui/plugins/tweakcn/plugins/community-browser/web/components/community-browser-section.tsx
# Expected: empty

# Confirm no remaining BURNDOWN inline-disables in the 3 mixed files:
rg "TODO.task-1781184772731" \
  plugins/page/plugins/editor/web/block-editor-context.tsx \
  plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer.tsx \
  plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/grouped-conversation-list.tsx
# Expected: empty

# Full type-check + ESLint (includes no-void-fetch-endpoint rule):
./equin check type-check
```
