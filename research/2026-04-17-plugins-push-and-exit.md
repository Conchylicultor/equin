# Push & Exit button

## Context

Today, finishing a conversation is a two-step chore: the user has to tell Claude
to push, wait, read Claude's summary, then manually kill the tmux session. We
want a single toolbar button on the conversation view that asks the running
Claude to push the branch, waits for an explicit outcome, and closes the
conversation automatically on success — while surfacing any caveats Claude
raised, even when the push itself succeeded.

The interesting open questions were:

1. **How does the UI push a prompt into a running tmux-hosted Claude?**
   Answer: extend `ConversationRuntime` with `send(id, text)`; tmux impl uses
   `load-buffer` + `paste-buffer` + `send-keys Enter` so multi-line/special
   chars survive intact. The api runtime stub matches the interface.

2. **How do we read Claude's output?**
   Answer: Claude Code already writes a per-session JSONL to
   `~/.claude/projects/<slug>/<sessionId>.jsonl`, and we already resolve &
   store `claudeSessionId` (see
   `plugins/conversations/plugins/runtime-tmux/server/internal/claude-session.ts`).
   We tail that file for the final assistant turn. No heuristics: we tell
   Claude in the injected prompt to terminate with one of two explicit
   sentinel tokens (`PUSH_RESULT_OK` / `PUSH_RESULT_FAIL`). We trust the token,
   not sentiment analysis.

---

## User flow

1. User clicks **Push & Exit** on the conversation toolbar.
2. Button flips to a spinner ("Asking Claude to push…"). It stays in that
   state while Claude works.
3. Server injects a prompt into the conversation's tmux pane (see prompt text
   below) and records a pending push-exit attempt for this conversation.
4. Claude runs `./equin push -m "…"` and emits a final assistant turn
   starting with `PUSH_RESULT_OK` or `PUSH_RESULT_FAIL`.
5. Server watcher detects the sentinel in the JSONL transcript and resolves
   the attempt with `{ ok, message }`.
6. UI shows a modal with Claude's full final message:
   - `ok: true` → buttons `[Close conversation]` (primary) and `[Keep open]`.
   - `ok: false` → only `[Keep open]`; the button re-enables for retry.
7. On `Close conversation`, UI calls `DELETE /api/conversations?name=<id>`
   and navigates to `/`.

Timeout: if no sentinel appears within, say, 10 min, surface a
`[Check conversation]` action that just dismisses the dialog and leaves the
pane alone.

---

## The injected prompt

```
Please commit any outstanding work and push this branch to main by running
`./equin push -m "<concise commit message you choose>"`.

When you are finished, your FINAL assistant message MUST begin with exactly
one of these tokens on the first line, with nothing before it:

  PUSH_RESULT_OK    — the push completed successfully.
  PUSH_RESULT_FAIL  — the push did not complete (any reason).

After the token, on subsequent lines, briefly summarize what was done and
flag anything the user should know (skipped files, failing checks you
worked around, follow-up work, etc.). On failure, explain why clearly.

Do not wrap the token in code fences or quotes.
```

The exact text lives in a single module so it can be tuned without chasing it
across the codebase.

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
  await Bun.spawn([TMUX, "paste-buffer", "-t", id, "-b", buf, "-d"]).exited; // -d deletes buffer
  await Bun.spawn([TMUX, "send-keys", "-t", id, "Enter"]).exited;
}
```

`-d` on paste-buffer drops the buffer automatically. Uses the same tmux
binary (`TMUX` constant) already in that file.

### 3. Stub `send` in the api runtime

`plugins/conversations/plugins/runtime-api/server/index.ts`: throw
`"api runtime: send() not implemented"` to satisfy the interface.

### 4. JSONL transcript reader (new)

New file
`plugins/conversations/server/internal/claude-transcript.ts`:

- `findTranscriptPath(sessionId: string): Promise<string | null>` — scans
  `~/.claude/projects/*/<sessionId>.jsonl`. Cached per sessionId.
- `readFinalAssistantTurn(path, sinceIso): Promise<{ text: string; at: string } | null>`
  — streams the file, collects `type === "assistant"` lines with
  `timestamp > sinceIso`, returns the last one whose
  `message.stop_reason === "end_turn"`. Concatenates `message.content[*].text`.

No dependency on tmux; lives under `conversations/server/` because it's about
Claude Code sessions generally.

### 5. Push-exit orchestrator (new)

New file
`plugins/conversations/server/internal/push-and-exit.ts`:

- In-memory map `pending: Map<conversationId, Attempt>` where
  `Attempt = { triggeredAt: string; status: "pending" | "ok" | "fail"; message?: string }`.
- `trigger(conversationId, prompt)`: looks up runtime + session, calls
  `Runtime.get(runtimeId).send(id, prompt)`, stores `Attempt`.
- A single background tick on an interval (e.g. 1500 ms) iterates pending
  attempts, reads the JSONL with `readFinalAssistantTurn`, checks the first
  non-empty line for the sentinel, and transitions status. Attempts older
  than the timeout are marked `fail` with a timeout message.
- Exposes a `pushAndExitResource` (mode `"push"`, params `{ conversationId }`)
  returning the current `Attempt`, and calls `.notify({ conversationId })`
  on transitions. Frontends subscribe via the standard `useResource` path
  (see `plugin-core/use-resource.ts` and the conversations/tasks resources
  for the pattern).

### 6. HTTP route

In `plugins/conversations/server/index.ts` add:

```
POST /api/conversations/:id/push-and-exit
```

Handler (`internal/handle-push-and-exit.ts`):

- Loads the conversation; bails with 4xx if status is not suitable
  (`gone`, `starting`).
- Builds the prompt from the static template.
- Calls `orchestrator.trigger(id, prompt)`.
- Returns `{ ok: true }`.

No new DB table. The pending map is deliberately in-memory; if the server
restarts mid-push, the client falls back to the existing conversation +
pushes resources and can re-open the conversation. Worth noting in code
comments but not worth designing around for v1.

---

## Frontend: new plugin `push-and-exit`

Folder:
`plugins/conversations/plugins/conversation-view/plugins/push-and-exit/`

Files:

- `package.json` — mirrors any sibling plugin's shape.
- `web/index.ts` — default-exports the `PluginDefinition`, contributing
  `Conversation.Toolbar({ component: PushAndExitButton })`.
- `web/components/push-and-exit-button.tsx` — the toolbar button.
- `web/components/push-and-exit-dialog.tsx` — the result modal.

Button behavior:

- Uses `useResource(pushAndExitResource, { conversationId: conversation.id })`
  for live state.
- Disabled when `conversation.status === "gone"`, or while the pending
  attempt is `"pending"`.
- On click: `POST /api/conversations/:id/push-and-exit`. No optimistic UI
  change needed; the resource flips to `"pending"` on the server side.
- When the resource reaches `"ok"` or `"fail"`, opens the dialog.

Dialog:

- Renders Claude's message verbatim (markdown OK).
- On success → `[Close conversation]` (calls
  `DELETE /api/conversations?name=<id>`, then `navigate("/")`) and
  `[Keep open]`.
- On failure → `[Keep open]` only.

Registration: add the plugin import to `web/src/plugins.ts` (alongside
existing conversation-view children).

---

## Files to touch

**New:**
- `plugins/conversations/server/internal/claude-transcript.ts`
- `plugins/conversations/server/internal/push-and-exit.ts`
- `plugins/conversations/server/internal/handle-push-and-exit.ts`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/package.json`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/index.ts`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-button.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-dialog.tsx`

**Modified:**
- `plugins/conversations/server/api.ts` — add `send` to `ConversationRuntime`,
  export `pushAndExitResource`.
- `plugins/conversations/server/index.ts` — register new route; wire
  orchestrator startup (register its interval tick).
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`
  — implement `send`.
- `plugins/conversations/plugins/runtime-api/server/index.ts` — stub `send`.
- `web/src/plugins.ts` — register the new plugin.
- `docs/plugins.md` — add the new plugin entry (project convention).

---

## Reuse notes

- Runtime registry: `Runtime.get(runtimeId)` in
  `plugins/conversations/server/api.ts` — same pattern used by
  `deleteConversation` in `internal/lifecycle.ts`.
- Resource definition (`defineResource`, mode `"push"`): see
  `plugins/tasks/server/internal/resources.ts` (`pushesResource`) as a close
  template.
- Client subscription: `useResource` from `plugin-core`, as used in existing
  toolbar components.
- Toast on error paths: `Shell.Toast({ description, variant: "error" })`
  from `plugins/shell/web/commands.ts`.
- Session-id resolution for the JSONL lookup already exists at
  `plugins/conversations/plugins/runtime-tmux/server/internal/claude-session.ts`
  and populates `_conversations.claudeSessionId`; the orchestrator reads that
  column.

---

## Verification

1. `./equin build` to deploy this worktree.
2. Open `http://<this-worktree>.localhost:9000/c/<some-conversation>` where
   the conversation has pending uncommitted edits.
3. Click **Push & Exit**. Observe:
   - The tmux pane shows the injected prompt being typed and submitted.
   - Toolbar button flips to pending spinner.
4. Wait for Claude to finish. The modal should appear with Claude's full
   final message.
5. Verify the commit lands on `main` (`git log main -1` shows the
   `Singularity-Push` trailer) and a new row appears in the `pushes` table
   for this `conversationId`.
6. Click **Close conversation** → tmux session disappears (`tmux ls`),
   conversation status becomes `gone`, UI navigates to `/`.
7. Repeat with a conversation that cannot push (e.g. failing check) and
   confirm the modal shows `PUSH_RESULT_FAIL` + reason and only the
   `[Keep open]` button.
8. Playwright smoke (optional): reuse `e2e/screenshot.mjs` to click the
   button and capture before/after — the result modal should be screenshot
   evidence that the sentinel flow works end-to-end.

---

## Out of scope (explicitly)

- Hooks-based notification (`Stop` hook posting to the server). More
  reliable than polling JSONL, but adds per-install setup. Revisit if
  JSONL tailing proves flaky.
- Persisting push-exit attempts across server restarts. v1 accepts that a
  restart mid-push loses the pending state; the user can re-open the
  conversation.
- Auto-commit-message selection outside of Claude. Claude composes its own
  message from the diff — that's the whole point of routing the push
  through it.
