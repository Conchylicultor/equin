# Pane `after` overhaul: ancestor semantics + optional + conversation unification

## Context

The pane `after` field is fragile and generates duplication. It means "my immediate left neighbor must be one of these panes," so:
- Adding an intermediate pane silently breaks downstream panes (no error, just a no-op navigation)
- The same UI (e.g. a conversation viewer) needs 6 separate pane definitions just because each one lives in a different `after` context

This overhaul makes three changes: (1) ancestor semantics, (2) optional `after`, (3) collapse the 6 duplicated conversation panes into one.

## Part 1: Ancestor semantics + optional `after`

**File:** `plugins/primitives/plugins/pane/web/pane.ts`

### New `after` semantics

| `after` value | Position 0 (root) | Position 1+ |
|---|---|---|
| omitted | valid | valid (any ancestor) |
| `[null]` | valid | NOT valid |
| `[paneA]` | NOT valid | valid if `paneA` is an ancestor |
| `[null, paneA]` | valid | valid if `paneA` is an ancestor |

"Ancestor" = any pane earlier in the chain (positions 0..i-1), not just the direct predecessor.

### `parseUrl` (lines 226–272)

Replace single `predecessorId` with an accumulating `Set<string>` of ancestor IDs. When `after` is omitted (empty `afterSet` without `null`), any non-root position matches.

```ts
export function parseUrl(pathname: string): PaneSlot[] | null {
  const normalized =
    pathname === "/" ? "" : pathname.replace(/^\/+|\/+$/g, "");
  const urlSegments = normalized ? normalized.split("/") : [];

  let cursor = 0;
  const ancestorIds = new Set<string>();
  const chain: PaneSlot[] = [];

  while (cursor < urlSegments.length) {
    let bestMatch: {
      pane: PaneInternal;
      params: Record<string, string>;
      consumed: number;
    } | null = null;

    for (const pane of registry.values()) {
      if (!isAfterSatisfied(pane, chain.length === 0, ancestorIds)) continue;

      const result = matchSegmentParts(pane.segment, urlSegments, cursor);
      if (!result) continue;
      if (!bestMatch || result.consumed > bestMatch.consumed) {
        bestMatch = { pane, params: result.params, consumed: result.consumed };
      }
    }

    if (!bestMatch) return null;

    chain.push(createSlot(bestMatch.pane.id, bestMatch.params));
    cursor += bestMatch.consumed;
    ancestorIds.add(bestMatch.pane.id);
  }

  // Root URL ("/") — find panes with empty/root segment that can be root.
  if (chain.length === 0) {
    for (const pane of registry.values()) {
      if (!pane.after.has(null)) continue;
      if (!pane.segment || pane.segment === "/" || pane.segment === "") {
        chain.push(createSlot(pane.id, {}));
        break;
      }
    }
  }

  return chain.length > 0 ? chain : null;
}
```

### `validateChain` (lines 436–449)

```ts
function validateChain(chain: PaneSlot[]): PaneSlot[] {
  const result: PaneSlot[] = [];
  const ancestorIds = new Set<string>();
  for (let i = 0; i < chain.length; i++) {
    const pane = registry.get(chain[i]!.paneId);
    if (!pane) break;
    if (!isAfterSatisfied(pane, i === 0, ancestorIds)) break;
    result.push(chain[i]!);
    ancestorIds.add(pane.id);
  }
  return result;
}
```

### `findValidPositions` (lines 417–434)

```ts
function findValidPositions(
  target: PaneInternal,
  chain: PaneSlot[],
): number[] {
  const positions: number[] = [];
  for (let i = 0; i <= chain.length; i++) {
    const ancestorIds = new Set(chain.slice(0, i).map((s) => s.paneId));
    const leftOk = isAfterSatisfied(target, i === 0, ancestorIds);
    // Inserting a pane only adds to the ancestor set, so successors stay valid.
    // Exception: inserting at position 0 makes the previous root non-root.
    const rightOk =
      i === chain.length
        ? true
        : i > 0
          ? true
          : (() => {
              const rightPane = registry.get(chain[0]!.paneId);
              if (!rightPane) return false;
              return isAfterSatisfied(rightPane, false, new Set([target.id]));
            })();
    if (leftOk && rightOk) positions.push(i);
  }
  return positions;
}
```

### Shared helper: `isAfterSatisfied`

```ts
function isAfterSatisfied(
  pane: PaneInternal,
  isRoot: boolean,
  ancestorIds: Set<string>,
): boolean {
  // after omitted (empty set without null) → valid everywhere
  if (pane.after.size === 0) return true;
  if (isRoot) return pane.after.has(null);
  // Non-root: check if any non-null entry matches an ancestor
  for (const a of pane.after) {
    if (a !== null && ancestorIds.has(a)) return true;
  }
  return false;
}
```

### `Pane.define` — handle omitted `after`

Change the default from `new Set([null])` to `new Set()` (empty = valid everywhere):

```ts
// Before:
const afterSet: Set<string | null> = args.after
  ? new Set(args.after.map(...))
  : new Set<string | null>([null]);   // default: root-only

// After:
const afterSet: Set<string | null> = args.after
  ? new Set(args.after.map(...))
  : new Set<string | null>();         // default: valid everywhere
```

**IMPORTANT**: This changes the default for all 22 root panes that currently omit `after` (they all become "valid everywhere" instead of "root only"). None of them currently cause collisions because their static segments are unique. But if a root pane should ONLY be root (not appear inside other chains), add explicit `after: [null]`.

Audit: all 22 root panes have unique static segments (`"tasks"`, `"agents"`, `"stats"`, etc.). Since URL parsing is greedy left-to-right and static segments are matched first, a root pane won't accidentally match inside another chain where the same static segment doesn't appear. However, for explicitness and self-documentation, root-only panes SHOULD still declare `after: [null]`. Leaving the default to "valid everywhere" means panes that genuinely should work at any position (like `conversationPane`) can simply omit `after`.

### No changes to `useOpenPane`

The "wrap left" check (`callerPane?.after.has(targetInternal.id)`) stays as-is — it's a UX heuristic, not a validation check. `buildFreshChain` also stays unchanged.

## Part 2: Static prefix enforcement

Add a new check: `plugins/primitives/plugins/pane/check/index.ts`

The check walks all `Pane.define` calls (via `Pane.Register` contributions) and flags any pane whose segment is a bare `:param` (no static prefix). Examples:
- `:taskId` → error: "Pane segments with parameters must have a static prefix (e.g. `t/:taskId`)"
- `c/:convId` → ok (has `c/` prefix)
- `tasks` → ok (fully static)

### Fix 6 bare `:param` segments

| Pane | Current segment | New segment | URL change |
|---|---|---|---|
| `taskDetailPane` | `:taskId` | `t/:taskId` | `/tasks/123` → `/tasks/t/123` |
| `agentDetailPane` | `:id` | `a/:id` | `/agents/123` → `/agents/a/123` |
| `serverDetailPane` | `:serverId` | `s/:serverId` | `/deploy/123` → `/deploy/s/123` |
| `logChannelPane` | `:channel` | `ch/:channel` | `/logs/stdout` → `/logs/ch/stdout` |
| `pluginViewPane` | `:pluginId` | `p/:pluginId` | `/publish/foo` → `/publish/p/foo` |
| `convCommitDiffPane` | `:sha` | `d/:sha` | `/c/.../commits/abc` → `/c/.../commits/d/abc` |

These panes still declare `after` for structural clarity, but it's no longer required for URL parsing since their prefixes are unique.

## Part 3: Collapse conversation panes

### Delete 5 duplicate conversation panes

All render the same UI — they existed only because `after` required separate definitions per context.

| Pane to delete | Plugin to clean up |
|---|---|
| `taskConversationPane` | `plugins/tasks/plugins/task-detail/` |
| `attemptConversationPane` | `plugins/attempt-view/` |
| `agentConversationPane` | `plugins/agents/` |
| `convSidePane` | `plugins/conversations/.../side-conversation/` |
| `costConvSidePane` | `plugins/stats/plugins/cost/` |

### Update `conversationPane`

Remove explicit `after` (omitted = valid everywhere):

```ts
// Before:
export const conversationPane = Pane.define({
  id: "conversation",
  after: [null, "attempt", "task-detail"],
  segment: "c/:convId",
  ...
});

// After:
export const conversationPane = Pane.define({
  id: "conversation",
  segment: "c/:convId",
  ...
});
```

### Update all callers

~20 files import the deleted panes. Each needs to switch to `conversationPane`:

**`task-events.tsx`** (the original bug):
```ts
// Before:
openPane(convSidePane, { sideConvId: c.id });
openPane(taskConversationPane, { taskId, convId: c.id });

// After:
openPane(conversationPane, { convId: c.id });  // works everywhere
```

**`attempt-pane.tsx`**:
```ts
// Before:
openPane(attemptConversationPane, { convId: c.id });

// After:
openPane(conversationPane, { convId: c.id });
```

**Similar changes** in `agent-detail.tsx`, `agent-launches.tsx`, `conv-chip.tsx`, `top-conversations-table.tsx`.

**`filePeekPane`** — simplify `after` to just `[conversationPane, taskDetailPane]` (or omit entirely):
```ts
// Before:
after: [conversationPane, taskDetailPane, "task-side", "conv-side", "plugin-conv-side"]

// After (omit — valid everywhere):
// no after field
```

### Delete plugins

The `side-conversation` plugin can be fully deleted (pane + component + index + CLAUDE.md). Its `Pane.Register` contribution is removed.

The `cost` plugin keeps its stats panel but deletes `costConvSidePane` and `CostConvSideBody`.

The wrapper components (`TaskConversationBody`, `AttemptConversationBody`, `AgentConversationBody`) are deleted — `conversationPane` already has its own `provide` that loads the conversation data.

### Plugin registration cleanup

Remove `Pane.Register` entries for deleted panes from:
- `plugins/tasks/plugins/task-detail/web/index.ts`
- `plugins/attempt-view/web/index.ts`
- `plugins/agents/web/index.ts`
- `plugins/conversations/.../side-conversation/web/index.ts`
- `plugins/stats/plugins/cost/web/index.ts`

## Part 4: Revert point fix

- `side-conversation/web/panes.tsx` — entire plugin being deleted, so moot
- `tasks-panel/web/index.ts` — remove the `export { convTasksPane }` barrel re-export

## Part 5: Update docs

- `plugins/primitives/plugins/pane/CLAUDE.md` — document new `after` semantics (ancestor, optional)
- Note: `plugins-compact.md` and `plugins-details.md` are auto-generated by `./equin build`

## Verification

1. `./equin build` — succeeds
2. `./equin check` — passes (including new static-prefix check)
3. **Original bug**: Navigate to `/c/<conv>/tasks`, click task conversation → opens as third miller column
4. **Root conversation**: Navigate to `/c/<conv>` — works as before
5. **Task → conversation**: Navigate to `/tasks/t/<task>/c/<conv>` — renders full conversation
6. **Attempt → conversation**: Navigate to `/a/<attempt>/c/<conv>` — renders full conversation
7. **Stats → conversation**: Click conversation in cost table → opens full conversation pane
8. **File peek**: Open file peek from conversation, task-detail, plugin views — all work
9. **Self-chaining**: Plugin view `/publish/p/123/p/456` still works
