# Push & Exit button — v2

## What changed from v1

- Sentinel is no longer binary success/failure. The distinction is "smooth,
  nothing to tell you" vs "flag something for the user" — which can apply even
  to a successful push (caveats, follow-ups, partial outcomes). Tokens:
  `PUSH_EXIT_CLEAN` / `PUSH_EXIT_FLAG`.
- Token goes at the **end** of Claude's final message, not the start.
- Prompt uses bullet points, doesn't hardcode `./equin push -m "…"`,
  and doesn't talk about commits. "Push to main using the CLI" is enough.
- "Close conversation" kills the tmux pane **only**. No DB row deletion. The
  existing poller will mark the conversation `gone`.
- No server-side orchestrator, no polling tick, no timeout. The
  conversation's existing `working → waiting` status transition is already
  the completion signal; the button watches it via the
  already-subscribed `conversationsResource`.
- The server endpoints are generic conversation primitives, not
  push-and-exit-specific: `POST /api/conversations/:id/turn` posts a user
  turn (any text) to the running runtime; `GET /api/conversations/:id/turns`
  lists transcript turns from the Claude Code JSONL. Push-and-exit is a
  pure client-side composition over those primitives.

## Context

Finishing a conversation today is a two-step chore: tell Claude to push,
wait, read its summary, then kill the tmux session by hand. We want a single
toolbar button that asks the running Claude to push and exit, reads an
explicit signal from Claude's final message, and either closes the pane
silently or surfaces whatever Claude flagged.

Claude already writes a per-session JSONL to
`~/.claude/projects/<slug>/<sessionId>.jsonl`, and we already resolve and
store `claudeSessionId` per conversation (see
`plugins/conversations/plugins/runtime-tmux/server/internal/claude-session.ts`).
That's how we read Claude's output.

---

## User flow

1. User clicks **Push & Exit** on the conversation toolbar.
2. Button disables, shows a spinner. Records the click timestamp locally.
3. Client posts the prompt as a user turn via
   `POST /api/conversations/:id/turn`. The server pastes it into the
   conversation's tmux pane and presses Enter. HTTP response returns
   immediately.
4. The existing poller detects Claude working and flips
   `conversation.status` from `waiting` → `working`. The UI, subscribed to
   `conversationsResource`, sees this and enters the "running" phase.
5. When Claude finishes, status flips back to `working` → `waiting`. UI
   fetches transcript turns via `GET /api/conversations/:id/turns?since=<triggeredAt>`
   and picks the last assistant turn with `stop_reason === "end_turn"`.
6. UI inspects the tail of that message:
   - Ends with `PUSH_EXIT_CLEAN` → close the pane silently (POST
     `.../close`), show a success toast, navigate to `/`.
   - Ends with `PUSH_EXIT_FLAG` → show a modal with the message (sans the
     token on the last line), plus two buttons: **Close conversation** and
     **Keep open**.
   - Neither token → fall back to the flag modal, prefixed with a short
     warning that the sentinel was missing.

No timeout. If Claude gets stuck (e.g. permission prompt), the user sees the
tmux state through the rest of the UI and can handle it directly.

---

## The injected prompt

One file, one string. Bullet-point style, no hardcoded command, no "commit"
vocabulary:

```
Please wrap up this conversation:

1. Push this branch to main using the CLI.
2. End your FINAL message with one of these tokens on its own line, as the
   very last line — nothing may follow it:
   - `PUSH_EXIT_CLEAN` — everything went smoothly, nothing I need to know.
   - `PUSH_EXIT_FLAG` — something needs my attention (caveats, partial
     outcomes, follow-ups, skipped work, or the push didn't land). Above
     the token, list what I should know as short bullets.
```

Stored in
`plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/prompt.ts`
and sent as the POST body. Keeping it in the plugin (not the server) makes
iteration cheap — tune the wording, rebuild the frontend, done.

---

## Server changes

### 1. Extend the Runtime interface

`plugins/conversations/server/api.ts`: add to `ConversationRuntime`

```ts
send(conversationId: string, text: string): Promise<void>;
```

### 2. Implement `send` in the tmux runtime

`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`:

```ts
async send(id: string, text: string): Promise<void> {
  const buf = `singularity-pe-${crypto.randomUUID()}`;
  const load = Bun.spawn([TMUX, "load-buffer", "-b", buf, "-"], { stdin: "pipe" });
  load.stdin.write(text);
  await load.stdin.end();
  await load.exited;
  await Bun.spawn([TMUX, "paste-buffer", "-t", id, "-b", buf, "-d"]).exited; // -d drops the buffer
  await Bun.spawn([TMUX, "send-keys", "-t", id, "Enter"]).exited;
}
```

`load-buffer`/`paste-buffer` instead of inline `send-keys` so multi-line
prompts and special characters survive verbatim.

### 3. Stub `send` in the api runtime

`plugins/conversations/plugins/runtime-api/server/index.ts`: throw
`"api runtime: send() not implemented"` to satisfy the interface.

### 4. JSONL transcript reader (new)

New file `plugins/conversations/server/internal/claude-transcript.ts`:

- `findTranscriptPath(sessionId: string): Promise<string | null>` — scans
  `~/.claude/projects/*/<sessionId>.jsonl`. Cached per sessionId.
- `readTurns(path: string, sinceIso?: string): Promise<Turn[]>` — streams
  the file and returns one `Turn` per JSONL line with `timestamp >= sinceIso`
  (or all lines if `since` is omitted). Shape:
  ```ts
  type Turn = {
    at: string;                       // line's ISO timestamp
    role: "user" | "assistant" | "tool_use" | "tool_result" | "system" | string;
    text: string;                     // concatenated .message.content[*].text (best-effort)
    stopReason?: string;              // .message.stop_reason when present
  };
  ```
  Lines that can't be parsed are skipped, not fatal.

### 5. Three generic conversation endpoints

In `plugins/conversations/server/index.ts` add:

```
POST /api/conversations/:id/turn              body: { text: string }
GET  /api/conversations/:id/turns?since=<iso>
POST /api/conversations/:id/close
```

Handlers (each in its own `internal/handle-*.ts`):

- **POST /turn** (`handle-post-turn.ts`): read `text` from the body, look up
  the conversation and its runtime, call
  `Runtime.get(runtimeId).send(id, text)`. Return `{ ok: true }`. This is a
  generic "send a user turn to this conversation" primitive — push-and-exit
  is just one caller.
- **GET /turns** (`handle-list-turns.ts`): read `claudeSessionId` from the
  row, resolve the JSONL path, call `readTurns(path, since)`, return
  `{ turns: Turn[] }`. Returns `{ turns: [] }` (not 404) when the JSONL
  file isn't on disk yet. Also generic — any future feature that wants to
  show transcript history reuses this.
- **POST /close** (`handle-close.ts`): call `deleteConversation(id)` from
  `internal/lifecycle.ts` — which only kills the tmux session — **without**
  the `db.delete(_conversations)` that `handleDelete` runs. The poller will
  set status to `gone` on its next tick and notify
  `conversationsResource`.

No new resource, no new schema, no new watcher, no push-and-exit-specific
server code. The whole server delta is one interface method, one tmux impl,
one JSONL reader, and three generic handlers.

---

## Frontend: new plugin `push-and-exit`

Folder:
`plugins/conversations/plugins/conversation-view/plugins/push-and-exit/`

Files:

- `package.json`
- `web/index.ts` — exports `PluginDefinition` with
  `Conversation.Toolbar({ component: PushAndExitButton })`.
- `web/prompt.ts` — the injected prompt string.
- `web/components/push-and-exit-button.tsx`
- `web/components/push-and-exit-dialog.tsx`

### Button logic (client-orchestrated)

State machine, driven off the existing `conversationsResource` subscription:

```
idle
  └─click──▶ armed (triggeredAt set, POST /turn fired with the prompt)
                 │
                 │ status transitions to "working"
                 ▼
             running
                 │
                 │ status leaves "working"
                 ▼
             fetching (GET /turns?since=triggeredAt,
                       pick last assistant turn with stop_reason="end_turn")
                 │
                 │ response
                 ▼
            interpret
             /      \
         CLEAN       FLAG / missing
           │               │
        POST /close     open dialog
        + toast
        + navigate("/")
```

- `armed → running` transition: guarded so that if status was already
  "working" when armed (edge case: user clicked while Claude was already
  busy — we should have disabled the button, see below), we don't
  skip ahead.
- Button is disabled when `conversation.status === "gone"` or when the
  local phase is anything other than `idle`.
- If the tab is closed and reopened, local state resets to `idle`. That's
  fine — if Claude is mid-push, the pane status is `working` and the
  button stays disabled; once it's back to `waiting`, the user can
  re-trigger or manually inspect.

### Dialog

- Renders the assistant message as markdown, with the trailing sentinel
  line stripped.
- `[Close conversation]` → POST `.../close`, navigate to `/`.
- `[Keep open]` → dismiss, button returns to `idle`.
- If the sentinel was missing, render a small "(Claude didn't emit a
  sentinel — showing raw output)" banner above the message.

### Registration

Add the plugin import to `web/src/plugins.ts`.

---

## Files to touch

**New:**
- `plugins/conversations/server/internal/claude-transcript.ts`
- `plugins/conversations/server/internal/handle-post-turn.ts`
- `plugins/conversations/server/internal/handle-list-turns.ts`
- `plugins/conversations/server/internal/handle-close.ts`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/package.json`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/index.ts`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/prompt.ts`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-dialog.tsx`

**Modified:**
- `plugins/conversations/server/api.ts` — add `send` to `ConversationRuntime`.
- `plugins/conversations/server/index.ts` — register three new routes.
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`
  — implement `send`.
- `plugins/conversations/plugins/runtime-api/server/index.ts` — stub `send`.
- `web/src/plugins.ts` — register the new plugin.
- `docs/plugins.md` — add the new plugin entry.

---

## Reuse notes

- `deleteConversation(id)` in
  `plugins/conversations/server/internal/lifecycle.ts` already does "kill the
  runtime without deleting the DB row" — exactly what the close handler
  needs. The existing `handleDelete` is the full destroy path (tmux + DB);
  we just skip the DB step.
- `resolveClaudeSessionId` / `_conversations.claudeSessionId` already give
  us the session id used to find the JSONL file.
- `Conversation.Toolbar({ component })` pattern — see
  `plugins/conversations/plugins/conversation-view/plugins/tasks-panel/`
  for a near-identical shape.
- `useResource(conversationsResource)` — subscription is already live
  everywhere this button renders.
- `Shell.Toast({ description, variant: "success" })` — from
  `plugins/shell/web/commands.ts`.

---

## Verification

1. `./equin build` to deploy.
2. Open `http://<worktree>.localhost:9000/c/<conversation>` where the
   conversation has pending uncommitted edits.
3. Click **Push & Exit**. Observe the injected prompt pasted into the pane
   and the spinner start.
4. Happy path: Claude pushes cleanly, ends with `PUSH_EXIT_CLEAN`. UI
   auto-closes the pane (poller shortly reports `gone`), success toast
   fires, router lands on `/`. Confirm the commit is on `main` with the
   `Singularity-Push` trailer, and the `pushes` row exists.
5. Flag path: repeat with a conversation that needs to flag something
   (e.g., manually leave a stray untracked file Claude can't explain).
   Claude ends with `PUSH_EXIT_FLAG`. UI opens the modal with the bulleted
   flags. Click **Close conversation** — verify the DB row is still there
   (`select * from conversations where id = '...'`) and status becomes
   `gone`, while the tmux session is killed (`tmux ls` does not list it).
6. Missing-sentinel path: run once with Claude told to emit no sentinel
   (local prompt edit). UI falls through to the flag modal with the "no
   sentinel" banner — confirms the fallback.
7. Optional playwright: reuse `e2e/screenshot.mjs` to click the button and
   capture before/after. Any deviation in the dialog screenshot between
   CLEAN (shouldn't open) and FLAG (opens) is evidence.

---

## Out of scope (explicitly)

- Server-side orchestrator / file watcher / polling tick — dropped; the
  existing status transitions from the poller are the signal.
- Claude Code `Stop` hooks — more reliable than JSONL tailing, but adds
  per-install setup. Revisit only if the JSONL path proves flaky.
- Timeouts — not needed; if Claude hangs, the pane state reflects it and
  the rest of the UI is enough.
- Auto-commit-message selection outside of Claude — Claude composes
  whatever it wants; the prompt doesn't care.
- Deleting the conversation DB row — v2 explicitly does not.
