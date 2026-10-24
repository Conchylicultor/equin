# Unified Dependencies Button

## Context

The conversation prompt bar has two nearly identical buttons for managing task dependencies — "blocked by" (upstream) and "blocking" (downstream). Both use similar chain-link icons (`Link2` vs `Link`), same outline style, no color distinction. The only differentiator is a native tooltip you have to hover to discover.

The goal: merge them into a single `1 ← ⛓ → 1` element that is visually one button but functionally two click targets. Left half opens the blocked-by editor, right half opens the blocking editor. Hover shows a read-only peek of both directions. This preserves the current one-click-to-add UX while halving toolbar clutter and making directionality self-documenting.

## Plan

### 1. Create the `dependencies` plugin

Create `plugins/conversations/plugins/conversation-view/plugins/dependencies/` with:

- `package.json` — standard plugin package
- `CLAUDE.md` — autogen placeholder
- `web/index.ts` — single `Conversation.PromptBar` contribution at section `"Deps"`, `sectionOrder: 0`
- `web/components/dependencies-button.tsx` — the unified component
- `web/components/dep-popover-content.tsx` — extracted popover panel (search + list + add/remove), reused for both directions

### 2. Component design: `DependenciesButton`

**Data layer** — computed once, shared by both panels:
- `task` via `useTask(conversation.taskId)` 
- `allTasks` via `useResource(tasksResource)`
- `active` via `useConversations().active`
- `convByTaskId` — `Map<taskId, conv>` excluding self (same as existing)
- `depTaskIds` = `new Set(task?.dependencies ?? [])` — blocked-by direction
- `blockedTaskIds` = reverse scan `allTasks.filter(t => t.dependencies.includes(myId))` — blocking direction
- Derived: `blockerConvs`, `blockedConvs`, `orphanDepIds`, `orphanBlockedIds`

**Visual structure:**

```
<WithTooltip content={peekContent} side="top">
  <div className="...outline button styling, p-0, overflow-hidden...">
    
    ┌─ Left half (InlinePopover trigger) ─┐  ⛓  ┌─ Right half (InlinePopover trigger) ─┐
    │  {count} ←                          │ icon │  → {count}                            │
    └─────────────────────────────────────┘      └──────────────────────────────────────┘
    
  </div>
</WithTooltip>
```

- The outer `<div>` is styled like a button via `buttonVariants({ variant: "outline" })` but is not a `<button>` (avoids nested interactive element violation).
- Each half is a `<button>` wrapped in `InlinePopover` — click opens the editable popover for that direction.
- The center `<Link2>` icon is a non-interactive visual separator.
- `WithTooltip` on the outer div provides the hover peek (auto-dismisses on click per base-ui behavior).

**Adaptive display:**

| State | Visual |
|---|---|
| Both 0 | `⛓` (icon-sm size) |
| Only blocked-by | `{N} ← ⛓` |
| Only blocking | `⛓ → {N}` |
| Both nonzero | `{N} ← ⛓ → {M}` |

Arrows and counts only render when > 0. Each half button always exists (for click target) but may have no visible content — the hover bg highlight on each half reveals clickability.

**Hover peek tooltip** — read-only, shows both directions:
```
BLOCKED BY
  Fix auth timeout
BLOCKING
  Deploy v2 release
```

When both are empty, shows "No dependencies". Just names, no edit controls — keeps it lightweight.

**Click popover** — identical to current behavior per direction. Each `InlinePopover` contains:
- Section label ("Blocked by" or "Blocking")
- Current deps list with ✕ remove buttons (ConversationItem + orphan fallback)
- SearchInput + candidate list to add new deps

### 3. Extract `DepPopoverContent`

Both popover panels share the same structure (label → current list → search → candidates). Extract into a shared component:

```tsx
interface DepPopoverContentProps {
  label: string;
  currentConvs: ConversationRecord[];
  orphanIds: string[];
  allTasks: Task[];
  candidates: ConversationRecord[];
  busy: string | null;
  onAdd: (conv: ConversationRecord) => void;
  onRemove: (taskId: string) => void;
}
```

This avoids duplicating the popover panel JSX. The `DependenciesButton` calls it twice with direction-specific data and callbacks.

### 4. Delete old plugins

Remove entirely:
- `plugins/conversations/plugins/conversation-view/plugins/blocked-by/`
- `plugins/conversations/plugins/conversation-view/plugins/blocking/`

### 5. Build and regenerate

`./equin build` will:
- Regenerate `web/src/plugins.generated.ts` — removes `blocked-by` and `blocking`, adds `dependencies`
- Regenerate CLAUDE.md autogen blocks

### Key files

| File | Action |
|---|---|
| `plugins/.../conversation-view/plugins/dependencies/web/index.ts` | Create |
| `plugins/.../conversation-view/plugins/dependencies/web/components/dependencies-button.tsx` | Create |
| `plugins/.../conversation-view/plugins/dependencies/web/components/dep-popover-content.tsx` | Create |
| `plugins/.../conversation-view/plugins/dependencies/package.json` | Create |
| `plugins/.../conversation-view/plugins/dependencies/CLAUDE.md` | Create |
| `plugins/.../conversation-view/plugins/blocked-by/` | Delete |
| `plugins/.../conversation-view/plugins/blocking/` | Delete |

### Verification

1. `./equin build` succeeds
2. Open conversation with a task that has deps in both directions
3. Verify `{N} ← ⛓ → {M}` renders with correct counts
4. Hover — peek tooltip shows both directions
5. Click left half — blocked-by popover opens, can add/remove
6. Click right half — blocking popover opens, can add/remove
7. With 0 deps — shows just `⛓`, both halves still clickable
8. `./equin check` passes
