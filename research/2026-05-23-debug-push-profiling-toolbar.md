# Push Profiling in Conversation Toolbar

## Context

The debug profiling pane shows push/build activity across all worktrees over 24h. We want a conversation-scoped version: a toolbar button that opens a side pane showing the push Gantt filtered to the last hour, with the current conversation's worktree highlighted. This lets agents and users see recent push contention without leaving the conversation.

The push section (`push-section.tsx`, 265 lines) is a monolith — types, styles, hover state, navigation, and rendering are all inline. To reuse the rendering in a second context, we extract it into a reusable `<PushGantt>` sub-plugin.

## Plan

### Step 1 — Create `push-gantt` sub-plugin (reusable component)

**Location:** `plugins/debug/plugins/profiling/plugins/push/plugins/push-gantt/web/`

Extract all rendering logic from `push-section.tsx` into a high-level `<PushGantt>` component:

```ts
interface PushGanttProps {
  groups: WorktreeGroup[];
  totalMs: number;
  title?: string;               // defaults to "Push & Build"
  highlightWorktree?: string;   // visual highlight on this row
  onWorktreeClick?: (worktree: string, conversationId: string | null) => void;
}
```

**Encapsulates:** `GanttContainer` wrapping, hover state (local `useState`, no `ProfilingContext`), `PushAttemptRow` rendering, `OUTCOME_STYLES`, color constants. The `onWorktreeClick` callback receives `(worktree, singleConversationId | null)` — the component computes `uniqueConvIds` internally and passes the result.

**Highlight:** When `group.worktree === highlightWorktree`, add `ring-1 ring-primary/40 bg-primary/5` to the row div.

**Exports:** `PushGantt`, `PushGanttProps`, `WorktreeGroup`, `PushEntry`, `BuildEntry`, `PushData`.

**Imports from parent:** `GanttContainer`, `useGanttContainerContext`, `formatDuration`, `Span` from `@plugins/debug/plugins/profiling/web`.

No `export default` plugin definition needed — this is a library-only plugin (no slot contributions). Confirm the framework handles a missing default gracefully; if not, add a minimal `{ id, name, contributions: [] }`.

### Step 2 — Refactor debug `PushSection` to consume `PushGantt`

**File:** `plugins/debug/plugins/profiling/plugins/push/web/components/push-section.tsx`

Reduce to ~30 lines: fetch data (using `refreshKey` from `useProfilingContext()`), render `<PushGantt onWorktreeClick={...}>`. The click handler stays here — it imports `conversationPane`/`attemptPane`/`useOpenPane` and navigates.

### Step 3 — Add `?since` query param to server endpoint

**Files:**
- `plugins/debug/plugins/profiling/plugins/push/shared/endpoints.ts` — add `query: z.object({ since: z.coerce.number().optional() })`
- `plugins/debug/plugins/profiling/plugins/push/server/internal/handle-push-profiling.ts` — read `query.since`, default to `TWENTY_FOUR_HOURS`. Replace hardcoded cutoff with `Date.now() - sinceMs`.

No breaking change — omitting `since` preserves 24h behavior.

### Step 4 — Create `push-profiling` conversation-view sub-plugin

**Location:** `plugins/conversations/plugins/conversation-view/plugins/push-profiling/web/`

**Files:**
- `web/index.ts` — contributes `Conversation.ActionBar` button + `Pane.Register`
- `web/panes.tsx` — `convPushProfilingPane = Pane.define({ id: "conv-push-profiling", segment: "pp", input: type<{ convId: string }>(), width: 600 })`
- `web/components/push-profiling-button.tsx` — `Activity` icon button, `useToggle()`
- `web/components/push-profiling-pane.tsx` — fetches `GET /api/debug/profiling/push?since=3600000`, renders `<PushGantt highlightWorktree={attemptId}>`

**Worktree identity:** `useConversationById(convId)?.attemptId` — matches `group.worktree` directly.

**Empty state:** "No push activity in the last hour."

## File checklist

| Action | File |
|--------|------|
| CREATE | `plugins/debug/plugins/profiling/plugins/push/plugins/push-gantt/package.json` |
| CREATE | `plugins/debug/plugins/profiling/plugins/push/plugins/push-gantt/web/index.ts` |
| CREATE | `plugins/debug/plugins/profiling/plugins/push/plugins/push-gantt/web/components/push-gantt.tsx` |
| MODIFY | `plugins/debug/plugins/profiling/plugins/push/web/components/push-section.tsx` |
| MODIFY | `plugins/debug/plugins/profiling/plugins/push/shared/endpoints.ts` |
| MODIFY | `plugins/debug/plugins/profiling/plugins/push/server/internal/handle-push-profiling.ts` |
| CREATE | `plugins/conversations/plugins/conversation-view/plugins/push-profiling/package.json` |
| CREATE | `plugins/conversations/plugins/conversation-view/plugins/push-profiling/web/index.ts` |
| CREATE | `plugins/conversations/plugins/conversation-view/plugins/push-profiling/web/panes.tsx` |
| CREATE | `plugins/conversations/plugins/conversation-view/plugins/push-profiling/web/components/push-profiling-button.tsx` |
| CREATE | `plugins/conversations/plugins/conversation-view/plugins/push-profiling/web/components/push-profiling-pane.tsx` |

## Verification

1. `./equin build` compiles
2. Debug > Profiling push section renders identically
3. Conversation toolbar shows new Activity button
4. Button opens side pane with push Gantt filtered to last hour
5. Current worktree row is highlighted
6. Drag-to-zoom works in the pane
7. Row click navigates to conversation/attempt
8. Empty state shows when no recent activity
