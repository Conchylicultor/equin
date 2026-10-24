# Caller-Aware Pane Navigation

## Context

The Miller pane system renders a chain of panes as horizontal columns. `pane.open(params)` is caller-unaware — it doesn't know which column initiated the navigation. This causes two bugs:

1. **Right-side overwrite broken**: Chain `conv > task-side > file-peek`, clicking a file link in conv should produce `conv > file-peek`, but the "already in chain" fast path updates file-peek at its existing index instead of truncating after the caller.

2. **Left-insert drops children**: Chain `conv > task-side`, clicking the attempt-view button should produce `attempt > conv > task-side`, but `buildFreshChain` only builds minimal ancestors and loses the right side.

Root cause: `open()` has no concept of "who called me," so it can't determine where to truncate or insert.

## Design

### 1. Stable instance identity on `PaneSlot`

Add an auto-incrementing `instanceId` to `PaneSlot`. Internal only — never serialized to URLs, never exposed in public API. Lets `useOpenPane()` find the caller in the chain even if the chain was mutated (depths shifted) between render and callback invocation.

```ts
// pane.ts
let nextInstanceId = 0;

export interface PaneSlot {
  instanceId: number;
  paneId: string;
  params: Record<string, string>;
}

function createSlot(paneId: string, params: Record<string, string>): PaneSlot {
  return { instanceId: nextInstanceId++, paneId, params };
}
```

`chainsEqual` does NOT compare `instanceId` (it's identity, not equality).
`buildChainUrl` ignores it (URL serialization).

### 2. `useOpenPane()` hook

```ts
export function useOpenPane(): (target: PaneObject, params: Record<string, string>) => void
```

Implementation:
1. Read depth from `PaneDepthContext`
2. Capture `instanceId` of `getChain()[depth]` at render time
3. Return a stable callback that:
   - Gets current chain, finds caller by `instanceId`
   - If caller not found or depth < 0 → fall back to `target.open(params)` (fresh stack)
   - If `callerPane.after.has(target.id)` → **wrap left**: insert target before caller, validate rest
   - Otherwise → **open right**: truncate after caller, append target

**Key decision**: "open right" is the default. The topology check is only needed to detect the rarer "wrap left" case. This means:
- Normal child opening (file after conv) → right ✓
- Same-pane-type navigation (task-detail → different task-detail) → right ✓ 
- Attempt wrapping (attempt before conv) → left, detected by `conversationPane.after.has("attempt")` ✓

### 3. `pane.unwrap()` method

Add `unwrap()` to `PaneObject` — the inverse of wrap-left. Removes the pane from the chain while preserving its children.

```ts
// pane.ts, inside makePaneObject:
function unwrap(): void {
  const chain = getChain();
  const idx = chain.findIndex(s => s.paneId === internal.id);
  if (idx < 0) return;
  const newChain = [...chain.slice(0, idx), ...chain.slice(idx + 1)];
  setChain(validateChain(newChain));
}
```

Usage in attempt-switch-button:
```tsx
if (inAttemptView) {
  attemptPane.unwrap(); // attempt > conv > task → conv > task
} else {
  openPane(attemptPane, { attemptId }); // conv > task → attempt > conv > task
}
```

`validateChain` ensures the remaining chain is topologically valid. For `attempt > conversation > task-side`, removing attempt: `conversation.after.has(null)` ✓, `task-side.after.has("conversation")` ✓.

### 4. Existing `pane.open()` unchanged

Stays as-is for sidebar, shortcuts, and any "reset the whole stack" intent.

## Topology verification

Attempt wrap-left:
- Caller: `conversationPane` (after: `[null, "attempt", "task-detail"]`)
- Target: `attemptPane` (after: `[null]`)
- `callerPane.after.has("attempt")` → YES → wrap left
- Chain: `conv > task-side` → `attempt > conv > task-side` ✓

File open-right:
- Caller: `conversationPane` at depth 0
- Target: `filePeekPane` (after: `[conversationPane, taskDetailPane, "task-side", "conv-side", "plugin-conv-side"]`)
- `callerPane.after.has("file-peek")` → NO → default to open right
- Chain: `conv > task-side > file-peek` → `conv > file-peek` ✓

## Implementation steps

### Step 1: Core changes in `pane.ts`

File: `plugins/primitives/plugins/pane/web/pane.ts`

**a) Add `instanceId` to `PaneSlot` and create helper:**

Add `instanceId: number` field, `nextInstanceId` counter, `createSlot()` helper.

**b) Update all 5 PaneSlot construction points to use `createSlot()`:**

| Location | Line | Current | Change |
|---|---|---|---|
| `parseUrl` main loop | 244 | `{ paneId: ..., params: ... }` | `createSlot(...)` |
| `parseUrl` root fallback | 254 | `{ paneId: ..., params: {} }` | `createSlot(...)` |
| `buildFreshChain` map | 402 | `{ paneId: ..., params: own }` | `createSlot(...)` |
| `open()` in-place update | 587 | `{ paneId: ..., params: ownParams }` | `createSlot(...)` |
| `open()` insertion | 620 | `{ paneId: ..., params: ownParams }` | `createSlot(...)` |

**c) Add `unwrap()` to `makePaneObject`:**

Add alongside existing `close()`. Finds the pane in the chain, removes it, preserves children via `validateChain`.

**d) Add `useOpenPane()` hook:**

```ts
export function useOpenPane(): (target: PaneObject<any, any, any>, params: Record<string, string>) => void {
  const depth = useContext(PaneDepthContext);
  const chain = getChain();
  const callerInstanceId = depth >= 0 ? chain[depth]?.instanceId : undefined;

  return useCallback((target, params) => {
    if (callerInstanceId === undefined) {
      target.open(params);
      return;
    }

    const currentChain = getChain();
    const callerIndex = currentChain.findIndex(s => s.instanceId === callerInstanceId);
    if (callerIndex < 0) {
      target.open(params);
      return;
    }

    const callerPaneId = currentChain[callerIndex]!.paneId;
    const callerPane = registry.get(callerPaneId);
    const targetInternal = target._internal;
    const ownParams = extractOwnParams(targetInternal, params);
    const replace = targetInternal.chrome.enabled && !targetInternal.chrome.history;

    // Wrap left: caller can follow target → insert target before caller
    if (callerPane?.after.has(targetInternal.id)) {
      const newChain = [
        ...currentChain.slice(0, callerIndex),
        createSlot(targetInternal.id, ownParams),
        ...currentChain.slice(callerIndex),
      ];
      setChain(validateChain(newChain), replace);
      return;
    }

    // Open right (default): truncate after caller, append target
    const newChain = [
      ...currentChain.slice(0, callerIndex + 1),
      createSlot(targetInternal.id, ownParams),
    ];
    setChain(validateChain(newChain), replace);
  }, [callerInstanceId]);
}
```

### Step 2: Export from barrel

File: `plugins/primitives/plugins/pane/web/index.ts`

Add `useOpenPane` to value exports. `unwrap()` is already on `PaneObject` — no separate export needed.

### Step 3: Migrate call sites

Each migration follows this pattern:
```tsx
// Before:
function MyComponent() {
  // ...
  return <button onClick={() => targetPane.open(params)}>Go</button>;
}

// After:
function MyComponent() {
  const openPane = useOpenPane();
  // ...
  return <button onClick={() => openPane(targetPane, params)}>Go</button>;
}
```

#### Special cases

**`attempt-switch-button.tsx`** — The "open attempt" path changes target from `attemptConversationPane` to `attemptPane` (the wrap-left logic inserts attempt before conversation). The "close attempt" path uses `attemptPane.unwrap()` to remove the attempt wrapper while preserving the rest of the chain.

**`expand-button.tsx`** — Keep as `conversationPane.open(...)` (intentional "make me root" fresh-stack).

**`filePeekPane` self-update** — `openPane(filePeekPane, newParams)` in the useEffect and onSelect. "Open right" truncates after self (nothing to truncate if it's last), then appends a new file-peek. But `validateChain` needs `filePeekPane.after` to include `"file-peek"` for self-chaining. Alternative: detect self-reference in `useOpenPane` and update params in-place instead. Simpler: add a self-reference check before the direction logic — if `targetInternal.id === callerPaneId`, update params in-place at `callerIndex` and truncate after.

**Dual-context components** (`LaunchButtons`, `BuildButton`) — `useOpenPane()` auto-falls-back when depth < 0, so they work in both sidebar and in-pane contexts without branching.

#### Full file list

**attempt-view:**
- `plugins/attempt-view/web/components/attempt-pane.tsx`
- `plugins/attempt-view/web/components/attempt-switch-button.tsx`

**agents:**
- `plugins/agents/web/components/agent-detail.tsx`
- `plugins/agents/web/components/agent-launches.tsx`
- `plugins/agents/web/components/agent-avatar-title-prefix.tsx`
- `plugins/agents/web/components/agents-list.tsx`
- `plugins/agents/web/components/system-folder.tsx`

**active-data:**
- `plugins/active-data/plugins/attempt/web/components/attempt-chip.tsx`
- `plugins/active-data/plugins/task/web/components/task-card.tsx`
- `plugins/active-data/plugins/conv/web/components/conv-chip.tsx`
- `plugins/active-data/plugins/task-link/web/components/task-link-chip.tsx`
- `plugins/active-data/plugins/plugin-link/web/components/plugin-link-chip.tsx`

**tasks:**
- `plugins/tasks/plugins/task-description/web/components/task-description.tsx`
- `plugins/tasks/plugins/task-events/web/components/task-events.tsx`
- `plugins/tasks/plugins/task-dependencies/web/components/task-dependencies.tsx`
- `plugins/tasks/plugins/task-graph/web/components/task-graph.tsx`
- `plugins/tasks/plugins/task-header/web/components/author-display.tsx`
- `plugins/tasks/plugins/task-detail/web/panes.tsx`

**conversation-view and children:**
- `plugins/conversations/plugins/conversation-view/plugins/side-task/web/components/side-task-body.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/terminal-pane/web/components/terminal-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/tasks-panel/web/components/tasks-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/tasks-panel/web/components/expand-to-tasks-action.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/commits-graph/web/components/commits-chip.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/commits-graph/web/components/commits-graph-body.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/web/components/review-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/docs-button/web/components/docs-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/file-peek-pane.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/markdown-extensions/web/internal/file-links-enhancer.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/markdown-extensions/web/internal/img-enhancer.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/markdown-extensions/web/internal/code-enhancer.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web/components/tool-file-path.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/user-text/web/components/user-text-row.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/add-task/web/components/add-task-tool-view.tsx`
- `plugins/conversations/plugins/summary/web/components/summarize-button.tsx`

**other:**
- `plugins/code-explorer/web/components/conv-tree-button.tsx`
- `plugins/plugin-meta/plugins/plugin-view/plugins/public-api/web/components/public-api-section.tsx`
- `plugins/plugin-meta/plugins/plugin-view/plugins/sub-plugins/web/components/sub-plugins-section.tsx`
- `plugins/apps/plugins/deploy/plugins/servers/web/panes.tsx`
- `plugins/apps/plugins/deploy/plugins/servers/web/components/servers-list.tsx`
- `plugins/build/web/components/build-button.tsx`
- `plugins/auth/web/components/default-provider-row.tsx`
- `plugins/plugin-meta/plugins/publish/web/components/publish-view.tsx`
- `plugins/stats/plugins/cost/web/components/top-conversations-table.tsx`
- `plugins/primitives/plugins/launch/web/components/launch-buttons.tsx`

**NOT migrated (intentional fresh-stack):**
- `plugins/conversations/plugins/conversation-view/web/components/expand-button.tsx`
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`
- `plugins/welcome/web/components/welcome-view.tsx`
- All sidebar `index.ts` onClick handlers

## Verification

1. `./equin build`
2. **Bug 1** (right-side overwrite): Open `conv > task-side > file-peek`. Click a file link in conv's JSONL → verify chain becomes `conv > file-peek`
3. **Bug 2** (left-insert preserves children): Open `conv > task-side`. Click attempt-switch → verify chain becomes `attempt > conv > task-side`
4. **Sidebar**: Click items in sidebar → verify fresh-stack behavior unchanged
5. **Browser back/forward**: Navigate several states → verify correct chain restoration
6. **Self-reference**: Open a file, then click another file link in the same conv → verify file-peek updates params in-place
