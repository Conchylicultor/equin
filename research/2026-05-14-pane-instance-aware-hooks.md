# Instance-Aware Pane Hooks

## Context

The Expand and Close buttons in pane chrome (miller columns) act on the wrong column. Root cause: `close()`, `promote()`, `unwrap()` on `PaneObject` found their target by scanning the chain for the first slot matching the pane's static type ID (`paneId`). When the same pane type appears multiple times in the chain, they always hit the first occurrence.

A partial fix made these methods take `instanceId: number` — the unique per-slot runtime identifier already set via `PaneInstanceContext` by the miller layout. But callers still have to manually scan the chain to extract the right `instanceId`, leaking chain internals (`._internal`, `usePaneMatch()`, `chain.find(...)`) into 12+ call sites.

This plan replaces the manual scanning with clean hooks on `PaneObject`.

## Design

### Two new hook categories

**Self-aware hooks** — "close/promote myself" (used by PaneChrome):

```ts
pane.useClose()   → (() => void) | null
pane.usePromote() → (() => void) | null
```

Read `PaneInstanceContext` internally. Return a bound function when the pane is in the chain and not root; `null` otherwise. PaneChrome renders the button only when the hook returns non-null.

Note: `useClose()` / `usePromote()` do NOT check `chrome.close` / `chrome.promote` config — that stays in PaneChrome as a rendering concern. The hooks only handle the "am I closeable from this position?" logic (not root, in chain).

**Toggle hook** — "toggle a child pane open/close" (used by toolbar buttons):

```ts
pane.useToggle(params, opts?) → { isOpen: boolean; toggle: () => void }
```

Encapsulates the full open-or-close pattern. Internally uses:
- `PaneInstanceContext` to know the caller's chain position
- `useChain()` (reactive `useSyncExternalStore`) for chain state
- `useOpenPane()` for the open path
- `close(instanceId)` / `unwrap(instanceId)` for the close path

Disambiguation for duplicate pane types: finds the first matching slot **after the caller's position** in the chain.

`opts` shape: `{ action?: "close" | "unwrap"; side?: "left" | "right"; mode?: PaneOpenMode }`. Defaults: `action: "close"`, `mode: "push"`.

Params stability: use `useRef` to capture latest params without making `toggle` recreate on every render. Callers pass object literals freely — no `useMemo` required.

### What stays

`close(instanceId)`, `unwrap(instanceId)`, `promote(instanceId)` remain on `PaneObject` as escape hatches for callers with non-standard logic (Group C below).

## Implementation

### Step 1 — Add hooks to `makePaneObject` in `pane.ts`

File: `plugins/primitives/plugins/pane/web/pane.ts`

Add inside `makePaneObject`, after the existing methods:

**`useClose`**: Read `PaneInstanceContext`. Use `useChain()` to reactively find the slot. Return `null` if `instanceId` is undefined, slot not found, or `idx <= 0` (root). Otherwise return `() => close(instanceId)` wrapped in `useMemo`.

**`usePromote`**: Same pattern. Return `null` if `instanceId` is undefined, slot not found, or `idx < 0`. Otherwise return `() => promote(instanceId)`.

**`useToggle`**: Read `PaneInstanceContext` for caller position. Use `useChain()` for reactive chain. Use `useOpenPane()` for the open path. Store `params` in a `useRef` to avoid stale closures without forcing callers to memoize. Find the target slot: first slot with matching `paneId` after the caller's index. Return `{ isOpen: !!targetSlot, toggle }` where `toggle` calls close/unwrap when open, or openPane when closed.

Update `PaneObject` interface to add the three hooks. Keep existing `close`, `unwrap`, `promote` methods.

### Step 2 — Migrate PaneChrome

File: `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx`

Replace:
```tsx
const instanceId = useContext(PaneInstanceContext);
const isRoot = instanceId !== undefined && match?.chain[0]?.instanceId === instanceId;
const showClose = chrome.close && !isRoot;
const showPromote = chrome.promote && !isRoot;
// ...
onClick={() => pane.close(instanceId)}
onClick={() => pane.promote(instanceId)}
```

With:
```tsx
const doClose = pane.useClose();
const doPromote = pane.usePromote();
// ...
{chrome.close && doClose && <Button onClick={doClose} .../>}
{chrome.promote && doPromote && <Button onClick={doPromote} .../>}
```

Drop the `PaneInstanceContext` import (unless still needed for other logic in the file — check `isRoot` usages beyond close/promote).

### Step 3 — Migrate Group A: simple toggle buttons (7 files)

All follow the identical pattern. Before:
```tsx
const match = usePaneMatch();
const openPane = useOpenPane();
const chainEntry = match?.chain.find(e => e.pane === targetPane._internal) ?? null;
// variant={chainEntry ? "secondary" : "ghost"}
// aria-pressed={!!chainEntry}
// onClick: chainEntry ? targetPane.close(chainEntry.instanceId) : openPane(targetPane, params, { mode: "push" })
```

After:
```tsx
const { isOpen, toggle } = targetPane.useToggle(params);
// variant={isOpen ? "secondary" : "ghost"}
// aria-pressed={isOpen}
// onClick={toggle}
```

Drop `usePaneMatch` and `useOpenPane` imports.

Files:
- `plugins/conversations/plugins/conversation-view/plugins/terminal-pane/web/components/terminal-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/web/components/review-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/docs-button/web/components/docs-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/commits-graph/web/components/commits-chip.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/tasks-panel/web/components/tasks-button.tsx`
- `plugins/conversations/plugins/summary/web/components/summarize-button.tsx`
- `plugins/code-explorer/web/components/conv-tree-button.tsx`

### Step 4 — Migrate Group B: `AgentAvatarTitlePrefix`

File: `plugins/agents/web/components/agent-avatar-title-prefix.tsx`

Same pattern as Group A but with `{ convId, agentId }` params. The `disabled={!agentId}` guard stays on the button — `useToggle` receives the params unconditionally.

### Step 5 — Migrate Group D: `AttemptSwitchButton` (unwrap)

File: `plugins/attempt-view/web/components/attempt-switch-button.tsx`

```tsx
const { isOpen, toggle } = attemptPane.useToggle(
  { attemptId: conversation.attemptId },
  { action: "unwrap", side: "left" },
);
```

### Step 6 — Group C: no change (escape hatch)

These 3 callers have non-standard logic (per-row params, "last entry" filtering) that doesn't fit `useToggle`:
- `plugins/agents/web/components/agent-launches.tsx`
- `plugins/active-data/plugins/task/web/components/task-card.tsx`
- `plugins/tasks/plugins/task-events/web/components/task-events.tsx`

They keep using `usePaneMatch()` + `conversationPane.close(entry.instanceId)`. The raw methods exist for exactly this purpose.

## Verification

1. `./equin build` — must compile cleanly
2. Navigate to a two-pane URL like `/c/conv-A/c/conv-B`:
   - Click Expand on the second column → URL should become `/c/conv-B` (not `/c/conv-A`)
   - Navigate back, click Close on the second column → URL should become `/c/conv-A`
3. Toggle buttons (terminal, tasks, review, docs, commits, summary, file explorer): click to open side pane, click again to close — verify the correct pane toggles
4. AttemptSwitchButton: open attempt view (inserts left), close → unwraps correctly
5. Group C list rows (agent launches, task events): click a conversation row to open, click same row to close — verify correct conversation toggles
