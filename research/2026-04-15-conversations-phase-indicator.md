---
name: Conversation phase indicator
description: Add a phase icon (Question / Design / Review / Completed) to each row in the conversation sidebar, derived from edited files and push events.
---

# Conversation phase indicator

## Context

The conversation list sidebar today shows only a runtime-status dot (working / needs_attention / idle). That tells you whether an agent is active, not **where the session is in its workflow**. We want a second signal that answers "what has this session actually produced so far?":

- **Question** — nothing done yet (no edits, no push)
- **Design** — only `research/**/*.md` has been edited (the `plan` skill writes here)
- **Review** — the worktree has edits outside `research/` (code changes ready to look at)
- **Completed** — there is at least one push on `main` for this conversation *and* no edits have happened since (latest-event wins, per user decision)

This makes the sidebar a scannable view of the portfolio: what needs prompting, what needs reviewing, what is done.

## Decisions (already aligned with user)

- **Visual**: keep the existing status dot, add a **separate phase icon** to the left of the title, next to the dot. Two orthogonal signals.
- **Push priority**: latest-event wins. A push → Completed, but later edits move it back to Design/Review.
- **Compute strategy**: a single **server-side periodic sweep** over active conversations (one process, N git diffs). An fs-watch based unification with `edited-files` polling is a worthwhile follow-up and will get its **own design doc** — not in this plan.

## Phase computation

Per conversation, evaluated in this order:

1. Let `editedFiles = getEditedFiles(worktreePath)` (reuses existing helper at `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/get-edited-files.ts`).
2. Let `hasPush = exists(SELECT 1 FROM pushes WHERE conversation_id = :id)`.
3. If `editedFiles.length === 0`:
   - `hasPush` → **completed**
   - else → **question**
4. Else (there are edits):
   - every path matches `^research/.*\.md$` → **design**
   - else → **review**

Note: the "latest-event wins" rule falls out naturally — if edits exist after a push, rule 4 fires before we check `hasPush`.

Only non-terminal conversations (`isActiveStatus(status) === true`) need a live sweep. For terminal conversations (`completed` / `gone` / `abandoned`), compute once at load and cache; they don't change.

## Server design

**New file:** `plugins/conversations/server/internal/phase-watcher.ts`

- Exports `startPhaseWatcher()`, called at server boot alongside `startPushWatcher()`.
- On a 2 s tick:
  1. Read active conversations from DB (`status NOT IN terminal`).
  2. For each, call `getEditedFiles(worktreePath)` and query `pushes` (one batched `SELECT conversation_id FROM pushes WHERE conversation_id IN (...)` — one round-trip).
  3. Compute phase; keep in-memory `Map<conversationId, Phase>`.
  4. If the map diff from last tick is non-empty, `conversationsResource.notify()` (resource already used by `push-watcher.ts`).
- Expose `getPhase(id)` for the conversations API layer.

**Conversation API augmentation** — extend the conversations API route (`plugins/conversations/server/internal/api.ts` — the handler feeding `GET /api/conversations` and the `conversations` push resource) to attach a `phase` field to each row before returning, by reading from the phase-watcher map. Mirror this on the Zod schema in `plugins/conversations/server/schema.ts` (add `phase: PhaseSchema` to the transformed type).

```ts
// plugins/conversations/shared/types.ts (or schema.ts)
export const PhaseSchema = z.enum(["question", "design", "review", "completed"]);
export type Phase = z.infer<typeof PhaseSchema>;
```

No new DB column — phase is derived state, held in memory. The `pushes` table already persists the completion signal durably, and edited files are recomputed from git on boot, so the map rebuilds cleanly after a restart.

## Client integration

**File:** `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`

- Read `conversation.phase` from the augmented conversation object (already pushed via the `conversations` resource — no new subscription).
- Add a small icon to the left of the title, next to the existing status dot:

```
[●] [icon] Title text
         12m ago
```

**Icon mapping** (react-icons/md, matching the existing icon library):

| Phase     | Icon                     | Color                   |
|-----------|--------------------------|-------------------------|
| question  | `MdHelpOutline`          | `text-muted-foreground` |
| design    | `MdEditNote`             | `text-sky-500`          |
| review    | `MdRateReview`           | `text-amber-500`        |
| completed | `MdCheckCircleOutline`   | `text-emerald-500`      |

Add a `title` tooltip on the icon (`"Question phase"`, etc.) so the meaning is discoverable.

## Files to modify / create

- **Create** `plugins/conversations/server/internal/phase-watcher.ts`
- **Edit** `plugins/conversations/server/internal/index.ts` (or wherever `startPushWatcher` is booted) — start the phase watcher
- **Edit** `plugins/conversations/server/schema.ts` — add `PhaseSchema`, extend transform to include `phase`
- **Edit** `plugins/conversations/server/internal/api.ts` (list + single handlers) — attach `phase` from the watcher map
- **Edit** `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` — render the phase icon

## Out of scope / follow-ups

- **fs-watch unification**: replacing the 1 s `edited-files` poll and this 2 s sweep with a single fs-watch per worktree (gitignore-aware, likely via `chokidar` or `bun`'s watcher with `.gitignore` parsing). Deserves its own design doc covering watcher lifecycle, gitignore handling, and coalescing strategy. **Not done here.**
- Showing the phase icon in the conversation pane toolbar (could be a follow-up).

## Verification

1. `./equin build` — applies schema changes and restarts the server.
2. Open `http://<worktree>.localhost:9000` sidebar and confirm each existing conversation row shows a phase icon.
3. Manually walk a fresh conversation through the phases:
   - Create a new conversation → **question** (help icon, grey).
   - Inside it, write a file under `research/` only → within ~2 s, icon flips to **design** (edit-note, blue).
   - Edit any file outside `research/` → flips to **review** (amber).
   - `./equin push -m "…"` from that worktree → `push-watcher` inserts a row → after reverting/removing the local edits on next sweep, icon shows **completed** (green check). With uncommitted edits still present, it stays in review (latest-event-wins).
4. Restart the server — phase map rebuilds correctly on boot (verify by refreshing the UI immediately after restart).
5. Sidebar should not flicker: phase only re-notifies when a conversation's phase actually changes (compare tick-over-tick in the watcher).
