# Eliminate the `isLoading` + empty-defaults footgun in adapter hooks

## Context

Two adapter hooks return a boolean loading flag **alongside default/empty data**:

- `useConversations` → `{ active, recentGone, hasMoreGone, totalGoneCount, system, isLoading }`, with `[]`/`0`/`false` defaults while loading.
- `useActiveDataBinding` → `{ value: T | null, isLoading, enabled, set, clear }`, with `value: null` while loading.

With this shape, "not yet loaded" is **indistinguishable from "loaded and genuinely empty."** Every consumer must remember to AND its empty-state rendering with `!isLoading`; forgetting it is a *silent* bug (flashing "No conversations" / a duplicate-invite card during cold load). The audit found 0 outright bugs today but 2 near-misses already slipping (queue inner label, drop-and-exit label) — the pattern works only because authors keep remembering the gate.

This is the shape the load-bearing primitives deliberately avoid: `useResource` returns a **discriminated union** `{ pending: true } | { pending: false, data }` where the loading variant carries **no data**, so TypeScript forces a branch. `useConfig` goes further and suspends. These two hooks are thin adapters over `useResource` that threw that safety away.

**Goal:** align both hooks with the discriminated-union convention (`{ pending: true } | { pending: false, ...data }`). NOT Suspense — these consumers deliberately keep their chrome mounted and would flash under Suspense. User-visible behavior stays identical, except the 2 near-misses get fixed for free. Scope: 2 hooks + 10 consumer sites + 2 internal consumers.

## Target hook shapes

### `plugins/conversations/web/use-conversations.ts`

```ts
export type ConversationsState =
  | { pending: true }
  | {
      pending: false;
      active: ConversationEntry[];
      recentGone: ConversationEntry[];
      hasMoreGone: boolean;
      totalGoneCount: number;
      system: ConversationEntry[];
    };

export function useConversations(): ConversationsState {
  const q = useResource(conversationsResource);
  if (q.pending) return { pending: true };
  return {
    pending: false,
    active: q.data.active,
    recentGone: q.data.recentGone,
    hasMoreGone: q.data.hasMoreGone,
    totalGoneCount: q.data.totalGoneCount,
    system: q.data.system,
  };
}
```

- Drop `error`/`refetch` passthrough — no consumer reads them and the old shape never exposed them.
- Export `ConversationsState` and add it to the barrel re-export in `plugins/conversations/web/index.ts` (parity with how `ResourceResult` is exported; not strictly required, no consumer annotates it today).

**Internal consumer in the same file** — `useConversation` (lines 31–34) destructures the old shape:

```ts
export function useConversation(id: string): ConversationEntry | null {
  const c = useConversations();
  if (c.pending) return null;
  return [...c.active, ...c.recentGone, ...c.system].find((x) => x.id === id) ?? null;
}
```
`useConversationById` calls `useConversation` and needs no change.

### `plugins/active-data/web/internal/use-active-data-binding.ts`

`enabled`/`set`/`clear` are available regardless of load; only `value` is gated.

```ts
interface ActiveDataBindingBase<T> {
  enabled: boolean;
  set: (next: T) => Promise<void>;
  clear: () => Promise<void>;
}
export type ActiveDataBindingHandle<T> =
  | (ActiveDataBindingBase<T> & { pending: true })
  | (ActiveDataBindingBase<T> & { pending: false; value: T | null });
```

- Keep all hook calls (`useMemo` value, `useCallback` set/clear) where they are — only the final `return` branches, so rules-of-hooks is preserved:
  ```ts
  if (!identity || resource.pending) return { pending: true, enabled: identity !== null, set, clear };
  return { pending: false, value, enabled: true, set, clear };
  ```
- `ActiveDataBindingHandle` keeps its name (interface → union alias); the `export type` re-export at `plugins/active-data/web/index.ts:17` needs **no edit**.

## Consumer edits (10 sites)

**Dominant idiom — local defaults** (use wherever the data feeds a `useMemo`/`useCallback`, so we must NOT early-return before those hooks):
```ts
const conv = useConversations();
const active = conv.pending ? [] : conv.active;   // etc. per field actually used
```
Then rewrite each `!isLoading` guard to `!conv.pending`.

| # | File | Change |
|---|------|--------|
| 1 | `…/conversations-view/plugins/history/web/components/history-view.tsx` (22,68) | local-defaults for active/recentGone/hasMoreGone/system; `!isLoading` → `!conv.pending` |
| 2 | `…/conversations-view/plugins/grouped/web/components/grouped-view.tsx` (17,88) | local-defaults; `!isLoading` → `!conv.pending` |
| 3 | `…/conversations-view/plugins/queue/web/components/queue-view.tsx` (108,311,346) | local-defaults active/recentGone; line 311 `!isLoading` → `!conv.pending`; **near-miss fix at 346:** add `!conv.pending &&` to the inner "No conversations waiting" guard |
| 4 | `plugins/welcome/web/components/welcome-view.tsx` (11,37,63) | local-defaults active/recentGone/totalGoneCount; both `!isLoading` → `!conv.pending` |
| 5 | `…/conversation-view/plugins/push-and-exit/web/components/push-and-exit-button.tsx` (48,57) | hoist `const conversationsLoading = conv.pending; const active = conv.pending ? [] : conv.active;` before the `mode` memo; memo body/deps unchanged |
| 6 | `…/conversation-view/plugins/op-status/web/components/op-status-banner.tsx` (23) | local-defaults active/recentGone/system inside `useTitleBySlug` |
| 7 | `…/conversation-view/plugins/dependencies/web/components/dependencies-button.tsx` (25) | local-default active |
| 8 | `…/conversation-view/plugins/drop-and-exit/web/components/drop-and-exit-button.tsx` (19,26) | feed memo via `conv.pending ? false : conv.active.some(...)`; **near-miss fix:** add `if (conv.pending) return null;` after the `useEndpointMutation` hook + `disabled` calc, so the button never flashes a wrong "Drop & Exit" label mid-load |
| 9 | `…/conversations-view/web/components/conv-count-label.tsx` (4) | no downstream hooks → clean early-return: `const conv = useConversations(); if (conv.pending) return null;` then read `conv.active`/`conv.totalGoneCount` |
| 10 | `plugins/active-data/plugins/task/web/components/task-card.tsx` (54,56,60,65) | keep the `enabled` semantics + narrow cleanly: `if (binding.enabled && binding.pending) return null;` then `const value = binding.pending ? null : binding.value;` and read `value?.…` at 56/60/65/66 |

**Two intentional behavior improvements** (call out in the PR):
- #3 queue inner "No conversations waiting" no longer flashes during cold load.
- #8 drop-and-exit button no longer briefly shows the destructive "Drop & Exit" for a conversation that actually has active siblings.

All other sites stay user-visibly identical.

### task-card narrowing note
`if (binding.enabled && binding.pending)` does **not** narrow `binding` to the `pending:false` arm. Reading `binding.value` afterward won't typecheck. Use a narrowed local `const value = binding.pending ? null : binding.value;` — this also **preserves the legacy `!enabled` behavior** (renders the card immediately rather than waiting), unlike collapsing to a bare `if (binding.pending) return null`.

## Docs
- `plugins/active-data/CLAUDE.md` — update the `if (binding.isLoading) return null;` snippet to `if (binding.enabled && binding.pending) return null;` + the `binding.value` example.
- The `useConversations` / `ActiveDataBindingHandle` autogen reference blocks regenerate via `./equin build`.

## Critical files
- `plugins/conversations/web/use-conversations.ts`
- `plugins/active-data/web/internal/use-active-data-binding.ts`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/drop-and-exit/web/components/drop-and-exit-button.tsx`
- `plugins/active-data/plugins/task/web/components/task-card.tsx`

## Verification
1. **Typecheck is the load-bearing gate.** Run `./equin build`. The discriminated union makes TypeScript flag any consumer that reads `.active`/`.value` or `isLoading` without narrowing — a clean build proves all 10 sites + 2 internal consumers were converted. (`isLoading` no longer exists on either hook, so any missed site is a compile error.)
2. **Lint (rules-of-hooks):** ensure no early-return precedes a `useMemo`/`useCallback`. Risk files: `drop-and-exit-button.tsx`, `conv-count-label.tsx`, `task-card.tsx`.
3. **Manual cold-load click-through** (hard-refresh `http://<worktree>.localhost:9000`, throttle network to widen the load window):
   - Sidebar **Queue / History / Grouped**: no "No conversations" / "No conversations waiting" / "All clear" flash before lists populate (incl. queue inner-label fix #3).
   - **Welcome** (`/`): stats + recent blocks appear only after load; no `0/0` flash.
   - **Conversation view**: the **Drop & Exit** button appears already correctly labeled (Exit / Complete / Drop), never flashing destructive "Drop & Exit" for a conversation with active siblings (#8). op-status banner + dependencies popover unchanged.
   - **Active-data task card**: render a conversation with a `<task>` widget that already has a saved binding; the editable card must not flash before collapsing to its chip.
