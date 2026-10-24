# Replace `PaneDepthContext` with `PaneInstanceContext`

## Context

Toggling reorder edit-mode causes the terminal pane to reopen. The root cause: `useOpenPane()` produces an unstable function reference because it captures `callerInstanceId` in `useCallback([callerInstanceId])`, where `callerInstanceId` is derived at render time via `getChain()[depth]?.instanceId` — reading the module-level chain store directly. When any unrelated re-render cascade hits the component, `getChain()` may return a chain with different slot objects (new `instanceId`s from prior `setChain` calls), producing a new function reference. Downstream effects that list `openPane` in their deps (e.g. the terminal-pane auto-open `useEffect`) re-fire spuriously.

## Design

Replace `PaneDepthContext` (a positional index) with `PaneInstanceContext` (a stable identity). Panes should never know their depth — only their identity. Everything depth was used for is derivable from identity + the match chain:

- "Am I root?" → `chain[0]?.instanceId === mine`
- "What are my params?" → `chain.find(e => e.instanceId === mine)`
- "What's the next entry?" → `chain[myIndex + 1]` (Outlet, used by debug logs)

Since `instanceId` is stable for the lifetime of a column mount, `useCallback([instanceId])` produces a stable function reference. No external consumers import `PaneDepthContext` — it's fully internal to the pane/layout primitives.

Identity context is set in a single place: the MillerColumns provide loop. Column becomes a pure visual component. `PaneRouter` (zero consumers) is deleted; `Outlet`/`PaneLevel` stay (used by debug logs pane).

## Changes

### 1. Add `instanceId` to `MatchEntry`, populate in `resolveChain`

**`plugins/primitives/plugins/pane/web/pane.ts`**

`MatchEntry` (line 168) — add `instanceId: number`:
```ts
export interface MatchEntry {
  instanceId: number;
  pane: PaneInternal;
  params: Record<string, string>;
  fullParams: Record<string, string>;
}
```

`resolveChain` (line 377) — copy from slot:
```ts
entries.push({
  instanceId: slot.instanceId,
  pane,
  params: { ...slot.params },
  fullParams: { ...accumulated },
});
```

### 2. Replace `PaneDepthContext` with `PaneInstanceContext`

**`plugins/primitives/plugins/pane/web/pane.ts`** — replace line 489:
```ts
// Remove: export const PaneDepthContext = createContext<number>(-1);
export const PaneInstanceContext = createContext<number | undefined>(undefined);
```

### 3. Migrate all consumers from depth to instanceId

**`useOpenPane`** (pane.ts:956-959):
```ts
// Before:
const depth = useContext(PaneDepthContext);
const chain = getChain();
const callerInstanceId = depth >= 0 ? chain[depth]?.instanceId : undefined;

// After:
const callerInstanceId = useContext(PaneInstanceContext);
```

**`useCurrentPane`** (pane.ts:495-500):
```ts
// Before:
const match = useContext(PaneMatchContext);
const depth = useContext(PaneDepthContext);
if (!match || depth < 0) return null;
return match.chain[depth]?.pane ?? null;

// After:
const match = useContext(PaneMatchContext);
const instanceId = useContext(PaneInstanceContext);
if (!match || instanceId === undefined) return null;
return match.chain.find(e => e.instanceId === instanceId)?.pane ?? null;
```

**`useParams`** (pane.ts:626-645) — instanceId replaces depth for disambiguation of repeated pane IDs:
```ts
// Before:
const depth = useContext(PaneDepthContext);
if (depth >= 0 && match.chain[depth]?.pane === internal) {
  return match.chain[depth]!.params;
}
const entry = match.chain.find((e) => e.pane === internal);

// After:
const instanceId = useContext(PaneInstanceContext);
if (instanceId !== undefined) {
  const entry = match.chain.find(e => e.instanceId === instanceId);
  if (entry?.pane === internal) return entry.params;
}
const entry = match.chain.find((e) => e.pane === internal);
```
The fallback (`find` by pane identity) handles cross-pane `useParams()` calls (child calling `parentPane.useParams()`).

**`PaneChrome`** (pane-chrome.tsx:54-58) — already imports `PaneMatchContext`:
```ts
// Before:
const depth = useContext(PaneDepthContext);
const showClose = chrome.close && depth > 0;
const showPromote = chrome.promote && depth > 0;

// After:
const match = useContext(PaneMatchContext);
const instanceId = useContext(PaneInstanceContext);
const isRoot = instanceId !== undefined && match?.chain[0]?.instanceId === instanceId;
const showClose = chrome.close && !isRoot;
const showPromote = chrome.promote && !isRoot;
```

### 4. Single provider site in MillerColumns

**`miller-columns.tsx`** — the provide loop already wraps ancestor `Provide` components. Extend it to always wrap at `j === i` (the column's own position), even when the pane has no `provide` component. This makes Column a pure visual component:

```tsx
for (let j = i; j >= 0; j--) {
  const chainEntry = match.chain[j]!;
  const Provide = chainEntry.pane.provide;
  if (Provide || j === i) {
    column = (
      <PaneInstanceContext.Provider value={chainEntry.instanceId}>
        {Provide ? <Provide>{column}</Provide> : column}
      </PaneInstanceContext.Provider>
    );
  }
}
```

**`column.tsx`** — remove `depth` prop and all context provider wrapping. Column becomes a pure visual container (collapse, resize, maximize).

### 5. Outlet/PaneLevel — migrate to instanceId

`Outlet` is used by the debug logs pane (`plugins/debug/plugins/logs/web/panes.tsx`). Migrate from depth to instanceId:

**`outlet.tsx`**:
```tsx
export function Outlet() {
  const match = useContext(PaneMatchContext);
  const instanceId = useContext(PaneInstanceContext);
  if (!match || instanceId === undefined) return null;
  const myIndex = match.chain.findIndex(e => e.instanceId === instanceId);
  const nextEntry = match.chain[myIndex + 1];
  if (!nextEntry) return null;
  return <PaneLevel match={match} instanceId={nextEntry.instanceId} />;
}

export function PaneLevel({
  match,
  instanceId,
}: {
  match: PaneMatch;
  instanceId: number;
}) {
  const entry = match.chain.find(e => e.instanceId === instanceId);
  if (!entry) return null;
  const Component = entry.pane.component;
  return (
    <PaneInstanceContext.Provider value={instanceId}>
      <Component />
    </PaneInstanceContext.Provider>
  );
}
```

### 6. Delete PaneRouter (zero consumers)

Delete `plugins/primitives/plugins/pane/web/components/pane-router.tsx`. Remove its barrel export from `index.ts`.

### 7. Update barrel exports

**`plugins/primitives/plugins/pane/web/index.ts`**:
- Add `PaneInstanceContext` to value exports
- Remove `PaneDepthContext` from value exports
- Remove `PaneRouter` export line

## Files

| File | Change |
|---|---|
| `pane.ts` | `MatchEntry` + `instanceId`, replace `PaneDepthContext` → `PaneInstanceContext`, update `useOpenPane`, `useCurrentPane`, `useParams` |
| `pane-chrome.tsx` | `depth > 0` → `!isRoot` via instanceId |
| `outlet.tsx` | `PaneLevel` takes `instanceId` instead of `depth` |
| `miller-columns.tsx` | Single provider: always wrap at `j === i`, provide `PaneInstanceContext` |
| `column.tsx` | Remove `depth` prop and context providers — pure visual component |
| `index.ts` | Export `PaneInstanceContext`, remove `PaneDepthContext` and `PaneRouter` |
| `pane-router.tsx` | Delete |

## Verification

1. `./equin build` — TypeScript compiles, app runs
2. Toggle reorder edit-mode on/off — terminal pane should NOT reopen
3. Navigate multi-column pane chains — verify open/close/swap all work
4. PaneChrome close/promote buttons: visible on non-root panes, hidden on root
5. Cross-pane `useParams()` calls (e.g. child reading parent params) still resolve
6. Debug logs pane: navigate to /debug/logs, select a channel — Outlet still renders the child
