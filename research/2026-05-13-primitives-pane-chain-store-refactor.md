# Pane chain store refactor: `useSyncExternalStore`

## Context

The miller-columns close button sometimes requires two clicks. The first
click reverts the pane to its previous state instead of closing it.

**Root cause:** The pane chain lives in a module-level mutable variable
(`let currentChain`) but React reads it through `usePathname()` — a
`useState` + `useEffect` hook that batches state updates. When `close()`
mutates `currentChain` and pushes the URL synchronously, React's pathname
state is still stale. An unrelated re-render (WebSocket notification,
TanStack Query refetch) calls `syncChainFromUrl(stalePathname)` during
render, which overwrites `currentChain` back to the old chain.

This is a structural problem: two unsynchronized sources of truth with
different timing guarantees. The fix is to make the chain a proper external
store consumed via `useSyncExternalStore`, eliminating `syncChainFromUrl`
from the render path entirely.

## Design

**Single source of truth:** `currentChain` + `chainListeners` become a
proper external store. `setChain()` notifies listeners after mutation.
React reads the chain via `useSyncExternalStore` — guaranteed tear-free.

**Two-way URL ↔ chain binding, cleanly separated:**
- **Chain → URL** (programmatic navigation): `setChain()` mutates the store,
  notifies React, then pushes the URL via `navigate()`. Already works today.
- **URL → chain** (browser back/forward, initial load): A module-level
  `popstate` listener calls `syncChainFromUrl()` imperatively — outside of
  React render. Replaces the current "sync during render" approach.

**`syncChainFromUrl` exits the render path.** It's only called from the
module-level popstate handler. `useMatchForPath` reads from the store
directly via `useChain()`.

## Changes

All changes are in **`plugins/primitives/plugins/pane/web/pane.ts`** unless
noted.

### 1. Wire `chainListeners` into `setChain`

`chainListeners` already exists (line 318) but nothing subscribes to it.
Add `notifyChainListeners()` to `setChain` before `navigate()` so the store
notifies React before URL events fire:

```ts
function setChain(chain: PaneSlot[], replace = false): void {
  currentChain = chain;
  notifyChainListeners();       // ← NEW
  const url = buildChainUrl(chain);
  navigate(url, replace);
}
```

### 2. Add `useChain()` — the `useSyncExternalStore` hook

Follow the `edit-mode-store.ts` pattern (module-level subscribe/snapshot):

```ts
function subscribeChain(cb: () => void): () => void {
  chainListeners.add(cb);
  return () => chainListeners.delete(cb);
}

function getChainSnapshot(): PaneSlot[] {
  return currentChain;
}

function useChain(): PaneSlot[] {
  return useSyncExternalStore(subscribeChain, getChainSnapshot, () => []);
}
```

### 3. Module-level popstate listener for URL → chain

Replace the "sync during render" approach with an imperative listener:

```ts
function handleLocationChange(): void {
  if (typeof window === "undefined") return;
  const pathname = stripBasePath(window.location.pathname, currentBasePath);
  syncChainFromUrl(pathname);
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", handleLocationChange);
  window.addEventListener("shell:navigate", handleLocationChange);
}
```

On initial page load, the chain starts empty (`[]`). The first render of
`MillerColumns` still calls `useMatchForPath()`, but the chain is now
hydrated by the initial `handleLocationChange` call (which fires from
`navigate()`'s dispatched events) or from the initial `syncChainFromUrl`
call if we add one at module load time. To handle this cleanly: call
`handleLocationChange()` once at module init (SSR-guarded).

### 4. Rewrite `useMatchForPath`

Remove `syncChainFromUrl` from render. Read chain from the store:

```ts
export function useMatchForPath(_pathname: string): PaneMatch | null {
  const chain = useChain();
  return useMemo(() => resolveChain(chain), [chain]);
}
```

Signature preserved (MillerColumns/PaneRouter still pass pathname).
Remove the `eslint-disable` comment — deps are now correct.

### 5. Rewrite `usePathname` to `useSyncExternalStore`

Match the pattern already in `apps-layout.tsx`:

```ts
export function usePathname(): string {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("popstate", cb);
      window.addEventListener("shell:navigate", cb);
      return () => {
        window.removeEventListener("popstate", cb);
        window.removeEventListener("shell:navigate", cb);
      };
    },
    () => window.location.pathname,
    () => "/",
  );
}
```

### 6. Remove stale-pathname guard from `syncChainFromUrl`

The guard (lines 355-358) defended against stale React state during render.
Since `syncChainFromUrl` is no longer called from render, the guard is dead
code. Remove it, keeping only the `chainsEqual` check:

```ts
export function syncChainFromUrl(pathname: string): void {
  const parsed = parseUrl(pathname);
  const newChain = parsed ?? [];
  if (chainsEqual(currentChain, newChain)) return;
  currentChain = newChain;
  notifyChainListeners();
}
```

### 7. Cleanup

- **Imports:** Add `useSyncExternalStore`, remove `useState` and `useEffect`
  (only used in old `usePathname`).
- **Barrel** (`index.ts`): Remove `syncChainFromUrl` from exports (0
  external consumers). Keep `getChain`, `parseUrl`, `buildChainUrl` in the
  barrel for now — they're harmless even if unused externally.

## Files

| File | Change |
|---|---|
| `plugins/primitives/plugins/pane/web/pane.ts` | All 7 steps above |
| `plugins/primitives/plugins/pane/web/index.ts` | Remove `syncChainFromUrl` export |

No changes to MillerColumns, PaneRouter, PaneChrome, or any of the 21+
`openPane` consumers.

## Why this fixes the bug

**Before:** `close()` → `setChain` → mutates `currentChain` → `navigate()`
→ dispatches popstate → React batches setState → stale re-render calls
`syncChainFromUrl(oldPathname)` during render → overwrites chain → pane
reappears.

**After:** `close()` → `setChain` → mutates `currentChain` →
`notifyChainListeners()` → `useSyncExternalStore` schedules re-render with
new snapshot → `navigate()` fires → any React render reads the fresh chain
from the store, never from a stale pathname. `syncChainFromUrl` is never
called during render.

## Verification

1. `./equin build` — must compile and deploy cleanly
2. Open the app, navigate to a conversation with nested panes (e.g.
   conversation → task detail → file pane)
3. Click the X close button on the rightmost pane — should close in one
   click, never revert
4. Browser back/forward must still navigate the pane chain correctly
5. Deep links (paste a URL with nested panes) must still work
6. Sidebar nav items (openPane consumers) must still open panes correctly
7. Take a screenshot and verify visually
