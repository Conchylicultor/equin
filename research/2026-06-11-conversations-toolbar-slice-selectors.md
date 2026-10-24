# Migrate per-conversation toolbar `useConversations()` reads to slice selectors

## Context

The live-state `select` primitive and its first adopter (`useConversation(id)`)
already shipped (commit `152ea2b6b`). `useResource(resource, params, { select })`
lets a caller subscribe to a derived **slice** of a list resource and re-render
only when that slice changes — see
`research/2026-06-11-global-live-state-resource-slice-selectors.md` and the
"Slice selectors" section of
`plugins/primitives/plugins/live-state/CLAUDE.md`.

This is the **follow-up** that doc filed: four per-conversation toolbar
components still call the whole-list `useConversations()` to compute a
derived value, so they re-render on **every** `conversations` push (any row's
status/title flip, any conversation going gone, the gone-count ticking) even
when their specific derived value is unchanged. On a busy conversation page
that is the dominant remaining re-render driver.

**Goal — the clean end state from the research doc:** `useConversations()`
(whole-list) is used **only** by true full-list renderers
(`conversations-view/{history,grouped,queue}`, `welcome`, `conv-count-label`).
Every point/derived read goes through a `select` slice.

## Current consumers of `useConversations()`

Migrate (per-conversation toolbar, derived read):

| Component | File | Derived value today |
|---|---|---|
| `DropAndExitItem` | `plugins/conversations/plugins/conversation-view/plugins/drop-and-exit/web/components/drop-and-exit-button.tsx` | `active.some(c => c.taskId === X && c.id !== Y)` (bool) |
| `PushAndExitButton` | `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-button.tsx` | `active.some(c => c.id !== Y && c.worktreePath === W && isActiveStatus(c.status))` (bool) |
| `DependenciesButton` | `plugins/conversations/plugins/conversation-view/plugins/dependencies/web/components/dependencies-button.tsx` | the whole `active` list (cross-task dep picker) |
| `useTitleBySlug` (in `OpStatusBanner`) | `plugins/conversations/plugins/conversation-view/plugins/op-status/web/components/op-status-banner.tsx` | `Record<slug, title>` from active+recentGone+system |

Keep as-is (true full-list renderers — legitimately repaint on any list change):
`conversations-view/{history,grouped,queue}`, `welcome`, `conv-count-label`.
(`drop-dependents` already uses only `useConversation(id)` — no work.)

## Approach

Mirror the existing `useConversation` convention (`useCallback`-memoized
`select`, read `q.pending ? <stable fallback> : q.data`). Add three named
selector hooks to the conversations web barrel; inline the fourth selector in
op-status (it depends on op-status's local `slugOf`).

### 1. `plugins/conversations/web/use-conversations.ts` — add three selector hooks

Import `isActiveStatus` from `../core`. Add a module-level stable empty array
for the array hook's pending branch (referential stability).

```ts
import { isActiveStatus } from "../core";

const EMPTY_CONVERSATIONS: ConversationEntry[] = [];

// drop-and-exit: does this task have another active conversation?
export function useHasActiveSiblings(taskId: string, excludeId: string): boolean {
  const select = useCallback(
    (p: ConversationListPayload) =>
      p.active.some((c) => c.taskId === taskId && c.id !== excludeId),
    [taskId, excludeId],
  );
  const q = useResource(conversationsResource, undefined, { select });
  return q.pending ? false : q.data;
}

// push-and-exit: is there another active conversation in this worktree?
export function useHasActiveSiblingInWorktree(
  worktreePath: string,
  excludeId: string,
): boolean {
  const select = useCallback(
    (p: ConversationListPayload) =>
      p.active.some(
        (c) =>
          c.id !== excludeId &&
          c.worktreePath === worktreePath &&
          isActiveStatus(c.status),
      ),
    [worktreePath, excludeId],
  );
  const q = useResource(conversationsResource, undefined, { select });
  return q.pending ? false : q.data;
}

// dependencies: the active list only (narrows away recentGone/system/gone-count churn)
export function useActiveConversations(): ConversationEntry[] {
  const select = useCallback((p: ConversationListPayload) => p.active, []);
  const q = useResource(conversationsResource, undefined, { select });
  return q.pending ? EMPTY_CONVERSATIONS : q.data;
}
```

### 2. `drop-and-exit-button.tsx`

- Replace `const conv = useConversations();` + the `hasOtherActive` `useMemo`
  with `const hasOtherActive = useHasActiveSiblings(conversation.taskId, conversation.id);`.
- Drop the `if (conv.pending) return null;` guard (line 47).
  **Safe:** the only effect of the guard was to delay rendering the menu item
  until the list loaded. `live = useConversation(conversation.id) ?? conversation`
  already supplies status from the prop, and `hasPush` has no equivalent guard.
  During the sub-ms hydration window `hasOtherActive` is `false` (shows
  "Drop & Exit"); it self-corrects reactively. The exit menu is opened by a user
  click, by which point the list is loaded.
- Update import: drop `useConversations`, add `useHasActiveSiblings`.

### 3. `push-and-exit-button.tsx`

- Replace `useConversations()` + `conversationsLoading` + `active` `useMemo`
  with `const hasOtherActiveInWorktree = useHasActiveSiblingInWorktree(conversation?.worktreePath ?? "", convId);`
  (computed unconditionally at hook level; `conversation` may be null on first
  render so default the path — the value is only consumed inside `mode` after
  the `if (!conversation || !live)` guard).
- In the `mode` `useMemo`: remove `if (conversationsLoading) return "push-and-exit";`
  and the inline `active.some(...)`; use the `hasOtherActiveInWorktree` boolean.
  **Safe to drop the loading guard:** the drop-vs-exit branch is only reached
  after `if (!conversation || !live) return "exit"`. `conversation` comes from
  `useConversationById` whose live fast path is `useConversation(convId)` —
  reading the **same** `conversationsResource` slice. A non-null live
  conversation implies the resource is loaded, hence `active` is populated and
  the sibling check is accurate. (The only "conversation present but list
  pending" case is the gone-conversation one-shot fallback, where status is
  `gone`/`done` → `isNotRunning` → `"restore"`, so the branch isn't reached.)
- Update `mode`'s dependency array: drop `active`, `conversationsLoading`; add
  `hasOtherActiveInWorktree`.
- Update import: drop `useConversations`, add `useHasActiveSiblingInWorktree`.

### 4. `dependencies-button.tsx`

- Replace `const conv = useConversations();` + `const active = useMemo(...)` with
  `const active = useActiveConversations();` (already a stable reference; the
  downstream `convByTaskId` `useMemo` keyed on `[active, ...]` is unchanged).
- Update import: `useConversations` → `useActiveConversations`.

### 5. `op-status-banner.tsx` — inline `select` in `useTitleBySlug`

The map is built with op-status's local `slugOf`, so keep the selector here
rather than in the barrel:

```ts
import { useCallback, useMemo, ... } from "react";
import { conversationsResource, type ConversationListPayload } from "@plugins/conversations/core";

const EMPTY_TITLES: Record<string, string> = {};

function useTitleBySlug(): Record<string, string> {
  const select = useCallback((p: ConversationListPayload): Record<string, string> => {
    const map: Record<string, string> = {};
    // Lowest-priority first so a live `active` title wins over a stale one.
    for (const c of [...p.system, ...p.recentGone, ...p.active]) {
      const title = c.title?.trim();
      if (title) map[slugOf(c.worktreePath)] = title;
    }
    return map;
  }, []);
  const q = useResource(conversationsResource, undefined, { select });
  return q.pending ? EMPTY_TITLES : q.data;
}
```

Structural sharing (`replaceEqualDeep`) deep-compares the returned `Record`, so
the banner re-renders only when a slug→title mapping actually changes — not on
status flips. Remove the `useConversations` import; add `conversationsResource`
/ `ConversationListPayload` from `@plugins/conversations/core` and `useCallback`.

## Why this is correct (re-render narrowing)

Each migrated component now subscribes (via `select` + `notifyOnChangeProps:
["data","error"]` + structural sharing, engaged automatically) only to its
derived slice: a boolean (drop/push-and-exit), the `active` array (dependencies),
or the slug→title map (op-status). A `conversations` push whose change doesn't
alter that slice produces a deeply-equal selected value, so the observer is not
notified — no re-render. This removes these components from the per-push fan-out
without touching the shared WS subscription (still one refcounted sub).

## Files to modify

- `plugins/conversations/web/use-conversations.ts` — 3 new selector hooks +
  `isActiveStatus` import + `EMPTY_CONVERSATIONS` const.
- `plugins/conversations/plugins/conversation-view/plugins/drop-and-exit/web/components/drop-and-exit-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/dependencies/web/components/dependencies-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/op-status/web/components/op-status-banner.tsx`

No new barrel exports beyond the three hooks (added to `@plugins/conversations/web`
via `web/index.ts` re-export of `use-conversations`); `./equin build`
regenerates the plugin docs so the `plugins-doc-in-sync` check passes.

## Verification

1. `./equin build` (deploys to `http://<worktree>.localhost:9000`).
2. **Functional correctness** — on a live conversation page, confirm each
   migrated control still reflects live state:
   - Push & Exit button label flips correctly between Push & Exit / Exit /
     Drop & Exit as siblings/pushes change.
   - Exit-menu "Drop & Exit" vs "Exit" label reflects whether the task has other
     active conversations.
   - Dependencies button popovers still list cross-task candidate conversations.
   - Op-status banner expanded rows still show conversation titles (not bare
     slugs) for in-flight builds/pushes.
   Use a scripted Playwright run:
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/a/<attempt-id> --out /tmp/conv
   ```
3. **Re-render reduction** is correct by construction (RQ `select` + structural
   sharing + `notifyOnChangeProps`). Spot-check Debug → live-state health: the
   `conversations` sub still shows one shared sub; observe/unobserve trace volume
   on a busy conversation page drops. Keep the trace always-on.
4. `./equin check` (eslint, boundaries, plugins-doc-in-sync, type-check).
```

