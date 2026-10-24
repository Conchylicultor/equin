# Resume Button for Gone Conversations

## Context

When a Claude conversation's underlying process exits (status `gone`), the user has no way to continue it from the UI — they have to start a brand-new conversation. The Claude CLI already supports continuing a previous session via `claude --resume <session-id>`, and Singularity already persists each conversation's `claudeSessionId` on the conversation row (populated by the poller from `~/.claude/sessions/<pid>.json`). We want a "Resume" button in the conversation's prompt bar that re-spawns the runtime with `--resume`, so the conversation flips from `gone` back to live **in the same row** (same task, same attempt, same worktree, same conversation list entry).

Per the user's choice:

- **Same conversation row reused** (status flips `gone → starting → working` in place).
- **Button lives in `Conversation.PromptBar`**, always visible, **greyed out unless `status === "gone"`**.

The poller already handles "resurrection": when a `gone` row becomes live again, it clears `endedAt` and updates the status (see `plugins/conversations/server/internal/poller.ts:104-110`). So once we re-spawn the tmux pane, the rest is automatic.

## Implementation

### 1. Extend the runtime API to accept a resume session id

**`plugins/conversations/server/internal/runtime.ts`** — add `resumeSessionId?: string` to `ConversationRuntime.create()`'s opts:

```ts
create(
  conversationId: string,
  worktreePath: string,
  opts?: {
    prompt?: string;
    model?: ConversationModel;
    spawnedBy?: string | null;
    resumeSessionId?: string;
  },
): Promise<void>;
```

**`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`** — when `opts.resumeSessionId` is set, build the claude command as:

```ts
const claudeBase = opts?.model ? `${CLAUDE} --model ${opts.model}` : CLAUDE;
const claudeCmd = opts?.resumeSessionId
  ? `${claudeBase} --resume ${opts.resumeSessionId}`
  : hasPrompt
    ? `${claudeBase} "$SINGULARITY_PROMPT"`
    : claudeBase;
```

Resume and `prompt` are mutually exclusive — resume continues an existing transcript, no fresh prompt is supplied. (The CLI/MCP plumbing — `SINGULARITY_CONVERSATION_ID`, `SINGULARITY_PARENT_HOST` — is unchanged.)

### 2. Add `resumeConversation` to lifecycle

**`plugins/conversations/server/internal/lifecycle.ts`** — new export:

```ts
export async function resumeConversation(id: string): Promise<Conversation> {
  const row = await getConversation(id);
  if (!row) throw new Error(`Conversation ${id} not found`);
  if (row.status !== "gone") throw new Error(`Conversation ${id} is not gone (status: ${row.status})`);
  if (!row.claudeSessionId) throw new Error(`Conversation ${id} has no saved Claude session`);

  const attempt = await getAttempt(row.attemptId);
  if (!attempt) throw new Error(`Attempt ${row.attemptId} not found`);

  const runtime = Runtime.get(row.runtime);
  // tmux refuses `new-session -s <name>` if a (dead) session by that name still exists.
  // Kill any stale pane first.
  await runtime.delete(id);

  await runtime.create(id, attempt.worktreePath, {
    resumeSessionId: row.claudeSessionId,
    model: row.model,
    spawnedBy: row.spawnedBy,
  });

  return (await getConversation(id)) as Conversation;
}
```

The poller will observe the new live pane on its next tick and flip the row's status (and clear `endedAt`) via the existing `resurrecting` branch.

**`plugins/conversations/server/index.ts`** — re-export `resumeConversation` so plugins can import it.

> Note: `getConversation` from `tasks-core` already returns `claudeSessionId`, `attemptId`, `runtime`, `model`, `spawnedBy`, and `status`. No new query is needed.

### 3. New `resume` plugin

Folder: **`plugins/conversations/plugins/conversation-view/plugins/resume/`** (mirror `drop-and-exit/`).

**`package.json`**

```json
{ "name": "@singularity/plugin-resume-conversation", "private": true, "version": "0.0.1" }
```

**`web/index.ts`**

```ts
import type { PluginDefinition } from "@core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/web";
import { ResumeButton } from "./components/resume-button";

export default {
  id: "conversation-resume",
  name: "Conversation: Resume",
  description: "Toolbar button that resumes a gone conversation via `claude --resume <id>`.",
  contributions: [
    Conversation.PromptBar({ component: ResumeButton, section: "Exit", sectionOrder: 1 }),
  ],
} satisfies PluginDefinition;
```

(Same `section: "Exit"` as the other lifecycle buttons so it sits with them; `sectionOrder: 1` puts it before push/hold/drop, where the user already looks for lifecycle controls.)

**`web/components/resume-button.tsx`** — model after `drop-and-exit-button.tsx`:

- `const live = useConversation(conversation.id) ?? conversation;`
- `const canResume = live.status === "gone" && !!live.claudeSessionId;`
- `const disabled = busy || !canResume;`
- Tooltip:
  - if `live.status !== "gone"`: "Resume is available once the session has exited"
  - if `live.status === "gone" && !live.claudeSessionId`: "No saved Claude session to resume"
  - else: "Resume conversation"
- `onClick`: `POST /api/conversations/:id/resume`, then `Shell.Toast({ description: "Resuming conversation…", variant: "success" })`.
- Icon: `MdReplay` or `MdPlayArrow` from `react-icons/md`.

**`server/index.ts`**

```ts
import type { ServerPluginDefinition } from "../../../../../../../server/src/types";
import { resumeConversation, recentConversationsResource } from "@plugins/conversations/server";

export default {
  id: "resume",
  name: "Resume",
  httpRoutes: {
    "POST /api/conversations/:id/resume": async (_req, { id }) => {
      if (!id) return new Response("Missing id", { status: 400 });
      try {
        await resumeConversation(id);
        recentConversationsResource.notify();
        return Response.json({ ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(msg, { status: 409 });
      }
    },
  },
} satisfies ServerPluginDefinition;
```

### 4. Plugin docs

Add an entry for `resume` in **`docs/plugins.md`** under `conversation-view`'s nested plugins, in the same shape as `drop-and-exit` / `hold-and-exit`.

## Critical files

- `plugins/conversations/server/internal/runtime.ts` — interface change.
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts` — `create()` builds `--resume` cmd.
- `plugins/conversations/server/internal/lifecycle.ts` — new `resumeConversation()`.
- `plugins/conversations/server/index.ts` — re-export.
- `plugins/conversations/server/internal/poller.ts` — **read only** (already handles `gone → live` resurrection at lines 104–110, no change needed).
- `plugins/conversations/plugins/conversation-view/plugins/resume/**` — new plugin (3 files + package.json).
- `docs/plugins.md` — entry.

## Reused utilities

- `useConversation(id)` from `@plugins/conversations/web` — live conversation subscription (same hook used by `drop-and-exit-button.tsx:13`).
- `getConversation(id)`, `getAttempt(attemptId)` from `@plugins/tasks-core/server` — return everything the resume needs.
- `Runtime.get(runtimeId)` from `@plugins/conversations/server` — runtime registry.
- `recentConversationsResource.notify()` — push status update to clients.
- `Shell.Toast` from `@plugins/shell/web` — feedback.

## Verification

1. `./equin build` from the worktree — build succeeds, server restarts.
2. Open `http://<worktree>.localhost:9000`.
3. Start a conversation (any prompt) and let it produce one turn so `claudeSessionId` is persisted (poller picks it up after Claude writes `~/.claude/sessions/<pid>.json`).
4. Open the conversation's tmux pane and exit Claude (Ctrl-C twice or `/exit`). Within ~1s the status badge flips to **gone**.
5. The Resume button (previously greyed out) becomes enabled.
6. Click Resume. Within ~1s, status flips to **starting** then **working/waiting**; `endedAt` is cleared (status badge is no longer gone).
7. Confirm the same conversation history is loaded — open the tmux pane, scroll up, prior turns are present (Claude `--resume` reattached the transcript).
8. Edge cases:
   - Resume on a conversation that never had a `claudeSessionId` (e.g., killed before Claude could write its session file): button stays disabled, tooltip explains why.
   - Resume while status is `working`/`waiting`: button stays disabled, tooltip explains why.
   - Click Resume twice rapidly: server returns 409 on the second call (status is no longer `gone`), toast surfaces the error.

## Risks / Notes

- **Stale tmux pane.** When status is `gone`, the dead pane may still exist in tmux's session list. `tmux new-session -s <name>` would fail. The pre-`runtime.delete(id)` call clears it. (`runtime.delete` calls `tmux kill-session -t <id>`, which is a no-op if the session is already absent.)
- **Claude CLI compatibility.** Assumes the installed claude CLI supports `claude --resume <session-id>`. If not, the new pane exits immediately and the poller flips the row back to `gone`; the user sees no progress and can investigate logs. This is the same failure mode as a normal launch failure — no special handling required.
- **Out of scope.** No support for resuming inside a *new* conversation row (the "fork from a gone session" use case). User explicitly chose in-place resume.
