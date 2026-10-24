# Miller layout hooks → `useSyncExternalStore`

## Context

Three Miller-columns layout hooks each subscribe to a module-level store via a
hand-rolled force-rerender:

- `plugins/layouts/plugins/miller/web/hooks/use-column-widths.ts`
- `plugins/layouts/plugins/miller/web/hooks/use-column-maximize.ts`
- `plugins/layouts/plugins/miller/web/hooks/use-column-collapse.ts`

Each copy-pastes the same pattern:

```ts
const [, force] = useState(0);
useEffect(() => {
  const fn = () => force((n) => n + 1);
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}, []);
```

The integer state is never rendered — it exists solely to trigger a re-read of
the module store. This is a hand-rolled reimplementation of React's
external-store subscription, duplicated three times. It was surfaced by an audit
of "React state not used as view data."

React ships `useSyncExternalStore` for exactly this, and the codebase already
uses it as the standard pattern for module-level stores:

- `plugins/reorder/web/internal/edit-mode-store.ts` — global store precedent.
- `plugins/conversations/.../notes/web/internal/notes-visibility-store.ts` — keyed store precedent.
- Also: `plugins/apps/web/internal/use-active-app.ts`,
  `plugins/apps/.../sonata/.../engine/web/audio-store.ts`.

**Decision (confirmed with user):** inline `useSyncExternalStore` directly in
each hook, mirroring the existing inline precedent byte-for-byte. No shared
helper abstraction — that would deviate from the established inline-per-store
pattern used everywhere else in the repo.

**Scope guard:** swap only the React subscription mechanism. Keep each hook's
existing store topology (single module-level `subscribers` set, global
broadcast) and its setter / persistence logic unchanged. The snapshot getters
return primitives (number / boolean), which are referentially stable, so there
is no tearing or infinite-loop risk.

## Changes

### 1. `use-column-maximize.ts` (global store — mirror `edit-mode-store.ts`)

- Drop the `useEffect, useState` import; import `useSyncExternalStore` from `react`.
- Keep `maximizedId`, `subscribers`, `notify`, `getMaximizedId`, `clearMaximize` as-is.
- Replace the hook body's force-rerender wiring with:

```ts
export function useColumnMaximize(paneId: string): [isMaximized: boolean, toggle: () => void] {
  const isMaximized = useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => maximizedId === paneId,
    () => false,
  );
  const toggle = () => {
    maximizedId = isMaximized ? null : paneId;
    notify();
  };
  return [isMaximized, toggle];
}
```

### 2. `use-column-collapse.ts` (keyed boolean + sessionStorage)

- Drop `useEffect, useState`; import `useSyncExternalStore`.
- Keep `read(paneId)` (it already seeds `collapseState` and handles the
  `window === "undefined"` case) and `toggle`'s persistence logic unchanged.
- Hook body:

```ts
export function useColumnCollapse(paneId: string): [boolean, () => void] {
  const collapsed = useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => read(paneId),
    () => false,
  );
  const toggle = () => { /* unchanged */ };
  return [collapsed, toggle];
}
```

`read(paneId)` returns the cached boolean from `collapseState` after the first
call, so the snapshot is referentially stable across renders.

### 3. `use-column-widths.ts` (keyed number + localStorage)

- Drop `useEffect, useState`; import `useSyncExternalStore`.
- Extract the existing in-render lazy-seed into a small pure getter so the
  snapshot stays stable (replaces the `if (!widthState.has(...))` block that
  currently runs in the render body):

```ts
function getWidth(paneId: string, defaultWidth: number): number {
  if (!widthState.has(paneId)) {
    widthState.set(paneId, readStored(paneId) ?? defaultWidth);
  }
  return widthState.get(paneId)!;
}
```

- Hook body:

```ts
export function useColumnWidth(
  paneId: string,
  defaultWidth: number,
): [number, (next: WidthUpdater) => void] {
  const width = useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => getWidth(paneId, defaultWidth),
    () => defaultWidth,
  );
  const setWidth = (next: WidthUpdater) => { /* unchanged */ };
  return [width, setWidth];
}
```

`getWidth` seeds the map once then returns the cached number, so repeated
`getSnapshot` calls within a render are stable. `hasStoredWidth`, `readStored`,
`persistWidth`, `notify` are untouched.

## Critical files

- `plugins/layouts/plugins/miller/web/hooks/use-column-widths.ts` — edit
- `plugins/layouts/plugins/miller/web/hooks/use-column-maximize.ts` — edit
- `plugins/layouts/plugins/miller/web/hooks/use-column-collapse.ts` — edit

Reference precedents (do not edit):
- `plugins/reorder/web/internal/edit-mode-store.ts`
- `plugins/conversations/plugins/conversation-view/plugins/notes/web/internal/notes-visibility-store.ts`

No barrel, registry, schema, or doc changes — these are internal plugin hooks
with unchanged signatures and exports.

## Verification

1. `./equin build` — frontend + server build clean.
2. `./equin check type-check` — TypeScript + lint pass; confirm the
   "React state not used as view data" audit finding no longer fires for these
   three files.
3. Manual e2e against a multi-column Miller app (e.g. the agent manager at
   `http://<worktree>.localhost:9000/agents`), using `e2e/screenshot.mjs`
   (before/after) or a scripted Playwright run, to confirm each store still
   drives re-renders:
   - **Resize** — drag a column divider; width updates live and persists across
     in-session navigation (`use-column-widths`).
   - **Collapse** — click a column's chevron; it collapses to the 32px bar and
     re-expands; survives navigation within the tab (`use-column-collapse`).
   - **Maximize** — toggle a column's maximize; switching maximize between two
     columns updates both (the global-broadcast topology is preserved)
     (`use-column-maximize`).
