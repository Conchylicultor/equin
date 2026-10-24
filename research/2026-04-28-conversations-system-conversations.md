---
title: System conversations — same list, visible status, shared worktree
date: 2026-04-28
category: conversations
---

# Context

System conversations (today: only conversation summaries via the `summary` plugin) currently render in a separate, collapsible "System" section in the sidebar with a robot icon (`MdSmartToy`) replacing the normal status dot. This has three problems:

1. **Status invisible** — the icon hides the colored status dot, so you can't tell at a glance whether a system conversation is `working`, `waiting`, `gone`, etc.
2. **Separate list** — system rows are isolated from the rest, even though they're often spawned from a specific user conversation and benefit from sitting next to it.
3. **Wrong worktree** — when "Summarise" is clicked, `handle-generate.ts` calls `createConversation({ kind: "system" })` with no `attemptId`. The lifecycle code at `plugins/conversations/server/internal/lifecycle.ts:96-111` then creates a fresh attempt + a fresh worktree (`setupWorktree(newAttemptId, ...)`). Summaries should reuse the parent conversation's worktree — they're context *about* that worktree, not work happening in a fresh one.

User-decided design (from clarifying questions):

- Visual: status dot + small `sys` chip next to title + subtle row background tint.
- Toggle: eye icon in the conversations sidebar header. Persists to `localStorage`.
- Default: hidden.
- Worktree: summaries share the parent conversation's worktree (same `attemptId`).

# Plan

## 1. Share parent worktree on summarise

**File:** `plugins/conversations/plugins/summary/server/internal/handle-generate.ts`

Look up the parent conversation and pass its `attemptId` to `createConversation`. The `lifecycle.ts:88-92` branch reuses the existing attempt's `worktreePath` when `attemptId` is given — no other changes needed.

```ts
import { getConversation } from "@plugins/tasks-core/server";
// ...
const parent = await getConversation(conversationId);
if (!parent) return Response.json({ error: "Parent conversation not found" }, { status: 404 });

const conv = await createConversation({
  prompt: payload.prompt,
  model: "sonnet",
  kind: "system",
  spawnedBy: "conversation-summary",
  attemptId: parent.attemptId,           // ← share the worktree
});
```

Side effects to check:
- The new conversation is parented under the parent's task (not `SYSTEM_META_TASK_ID`). That's fine: `kind: "system"` is what classifies it as system; the `notSystem` filter at `tasks-core/server/internal/queries/conversations.ts:13` keeps it out of regular task/conversation lists.
- `listConversationSummariesByAttempt` (line 92-105 of the same file) already filters `notSystem`, so attempt-view's left rail won't show summaries.
- Cleanup at line 45-50 still works — `deleteConversation(conv.id)` is conversation-scoped, it doesn't touch the worktree.

## 2. Merge system rows into the main sidebar list

**File:** `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`

Remove the dedicated "System" header and the separate `renderSystemItem` rendering path. Replace with:

- **Header eye toggle** at the top of the list (above `LaunchButtons`). Uses `MdVisibility` / `MdVisibilityOff` from `react-icons/md`. State lives in `localStorage` under the key `conversations-view:show-system` (rename from the existing `conversations-view:system-expanded`). Default: `false` (hidden).
- When `showSystem` is `true`, merge `system` into `active` before computing `attemptGroups` (line 156). Because summaries now share the parent's `attemptId`, they naturally land as forks under the parent in the attempt grouping at lines 269-309 — no extra logic needed.
- When `showSystem` is `false`, the merged list is just `active` (current behavior, minus the now-removed system section).

Render once via `renderItem` (delete `renderSystemItem`). Distinguishing system rows is handled in the next step.

## 3. New visual treatment for system rows

**Files:**
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`
- (no schema changes — `kind` is already on `ConversationEntry`)

In `ConversationContent` (line 56), when `conv.kind === "system"`:
- Keep the existing `statusDotClass` dot (so working/waiting/gone is visible).
- Append a small chip after the title: `<span className="rounded-sm bg-muted px-1 text-[9px] uppercase tracking-wide text-muted-foreground/80">sys</span>`.

In `renderItem` and the attempt-group wrapper (lines 224-240, 273-307), pass `conv.kind` down so the row chrome (`SidebarMenuButton` / `SidebarMenuSubButton`) can apply a subtle tint when system: `cn(..., conv.kind === "system" && "bg-muted/30")`.

Drop the `MdSmartToy` import if no longer used elsewhere.

## Critical files

- `plugins/conversations/plugins/summary/server/internal/handle-generate.ts` — pass `attemptId` from parent.
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` — toggle UI, merged rendering, system chip + tint.

Functions reused:
- `getConversation` (`@plugins/tasks-core/server`) — parent lookup.
- `createConversation` (`@plugins/conversations/server`) — already supports `attemptId` shared-worktree branch.
- `statusDotClass` (line 43-54) — preserved for system rows.
- `useConversations` (`plugins/conversations/web/use-conversations.ts`) — already returns `system` separately.

# Verification

1. `./equin build` and open `http://<worktree>.localhost:9000`.
2. Open any user conversation, click **Summarise**.
   - Toggle the eye icon on in the sidebar header → the new system conversation appears as a fork under the parent in the attempt group, with a status dot, a `sys` chip, and a tinted row.
   - The summary's terminal pane (`open-app` or terminal-pane plugin) should show the parent's worktree path. Verify by opening the terminal pane on the summary conversation and running `pwd`.
3. Toggle the eye icon off → only non-system rows remain. Reload the page → toggle state persists.
4. Verify status colors update on system rows when the summary moves through `working` → `waiting` → `gone`.
5. Verify the regular conversation flow (Sonnet/Opus launch, fork-session, attempt grouping) is unaffected.
