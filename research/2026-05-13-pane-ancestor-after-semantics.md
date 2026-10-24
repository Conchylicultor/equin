# Pane `after`: direct-predecessor → ancestor semantics

## Context

The pane `after` field currently means "my immediate left neighbor must be one of these panes." This is fragile: adding an intermediate pane (e.g. `conv-tasks` between `conversation` and `conv-side`) silently breaks all downstream panes that don't list the new intermediate in their `after`. The navigation becomes a no-op — `validateChain` strips the target pane, no error is thrown.

The fix: change `after` to mean "I need one of these panes somewhere **above** me in the chain" (ancestor semantics). A pane declaring `after: [conversationPane]` can appear anywhere in a chain that contains `conversationPane`, regardless of how many intermediates sit between them.

## Scope

All changes are in one file: `plugins/primitives/plugins/pane/web/pane.ts`. Three functions change. Then revert the point fix from `side-conversation/web/panes.tsx` and `tasks-panel/web/index.ts`.

## Changes

### 1. `parseUrl` (lines 226–272)

Replace single `predecessorId` tracker with an accumulating `Set<string>` of ancestor IDs.

```ts
// Before:
let predecessorId: string | null = null;
// ...
if (predecessorId === null && !pane.after.has(null)) continue;
if (predecessorId !== null && !pane.after.has(predecessorId)) continue;
// ...
predecessorId = bestMatch.pane.id;

// After:
const ancestorIds = new Set<string>();
// ...
if (chain.length === 0) {
  if (!pane.after.has(null)) continue;
} else {
  let ok = false;
  for (const a of pane.after) {
    if (a !== null && ancestorIds.has(a)) { ok = true; break; }
  }
  if (!ok) continue;
}
// ...
ancestorIds.add(bestMatch.pane.id);
```

Root URL fallback (lines 260–269) is unchanged — it only checks `pane.after.has(null)`.

### 2. `validateChain` (lines 436–449)

Track accumulated ancestor IDs instead of checking only `result[i-1]`.

```ts
function validateChain(chain: PaneSlot[]): PaneSlot[] {
  const result: PaneSlot[] = [];
  const ancestorIds = new Set<string>();
  for (let i = 0; i < chain.length; i++) {
    const pane = registry.get(chain[i]!.paneId);
    if (!pane) break;
    if (i === 0) {
      if (!pane.after.has(null)) break;
    } else {
      let ok = false;
      for (const a of pane.after) {
        if (a !== null && ancestorIds.has(a)) { ok = true; break; }
      }
      if (!ok) break;
    }
    result.push(chain[i]!);
    ancestorIds.add(pane.id);
  }
  return result;
}
```

### 3. `findValidPositions` (lines 417–434)

`leftOk` checks the ancestor set. `rightOk` simplifies: inserting a pane only adds to the ancestor set, so existing successors stay valid — except when inserting at position 0 (a previously-root pane loses its root status and needs the target as an ancestor).

```ts
function findValidPositions(
  target: PaneInternal,
  chain: PaneSlot[],
): number[] {
  const positions: number[] = [];
  for (let i = 0; i <= chain.length; i++) {
    const leftOk =
      i === 0
        ? target.after.has(null)
        : chain.slice(0, i).some((s) => target.after.has(s.paneId));
    const rightOk =
      i === chain.length
        ? true
        : i > 0
          ? true  // inserting only adds ancestors; existing successors stay valid
          : (registry.get(chain[i]!.paneId)?.after.has(target.id) ?? false);
    if (leftOk && rightOk) positions.push(i);
  }
  return positions;
}
```

### 4. Revert point fix

**`plugins/conversations/plugins/conversation-view/plugins/side-conversation/web/panes.tsx`** — remove `convTasksPane` from `after` and its import. Revert to `after: [conversationPane]` only. The ancestor semantics now handle the intermediate case.

**`plugins/conversations/plugins/conversation-view/plugins/tasks-panel/web/index.ts`** — remove the `export { convTasksPane }` barrel re-export added for the point fix.

### 5. Update pane CLAUDE.md

In `plugins/primitives/plugins/pane/CLAUDE.md`, update the `after` documentation to reflect ancestor semantics: "I need this pane somewhere above me in the chain" rather than "my direct predecessor."

## What doesn't change

- `useOpenPane` "wrap left" check (`callerPane?.after.has(targetInternal.id)`) — this is a UX heuristic for when to insert left vs right, not a validation check. Keeping it strict is fine.
- `buildFreshChain` — already walks `after` one step at a time upward; unaffected.
- `null` semantics — still means "can be root (position 0)." Unchanged.
- All 52 existing pane definitions — every current `after` entry is either the direct predecessor (subset of ancestor) or `null`. No behavioral change for any existing chain.

## Verification

1. `./equin build` — build succeeds
2. Navigate to `http://<worktree>.localhost:9000/c/<conv-id>/tasks` — click a task's conversation → should open as a third miller column (`conv0 > tasks > conv1`)
3. Navigate to `http://<worktree>.localhost:9000/c/<conv-id>` — click side-conversation chip → should still open as second column (`conv0 > conv1`)
4. Verify `filePeekPane` works from all its contexts: conversation, task-detail, task-side, conv-side, plugin-conv-side
5. `./equin check` — passes
