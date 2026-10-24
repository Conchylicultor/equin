# AskUserQuestion: render & answer in the web UI via on-demand cancel-to-flush

> **Superseded as the primary path (2026-10-06):** questions are now answered through a PreToolUse hook relay (`research/2026-10-06-conversations-askuserquestion-hook-relay.md`, plugin `conversations/question-relay`). The flush path below remains the fallback for sessions without the hook and for questions released to the terminal.

## Context

When an agent calls the built-in `AskUserQuestion` tool inside its tmux Claude CLI
session, the CLI **buffers the assistant message** — the `tool_use` block carrying
the questions/options is not written to the JSONL transcript until the tool result
returns (i.e. after the user answers in the terminal). So the web JSONL viewer has
no event to render: it only shows a static *"Content pending in terminal — waiting
for your input"* indicator (`jsonl-pane.tsx:76-84,233`). The interactive answer form
already exists (`answer-form.tsx`) but its gate requires the tool-call event to be in
the JSONL, which it isn't — so it never appears.

**Confirmed mechanism:** sending `Escape` to the pane cancels the AskUserQuestion tool
call *and* forces the CLI to flush the buffered assistant message (the `tool_use`)
to the JSONL. After cancel, the tool gets a synthetic interrupt result
(`[Request interrupted by user]` / `this query was stopped by the user`), and the
real answer — when given — arrives as a *separate* user turn.

**Goal:** let the user answer the question from the web UI, with clean abstractions
rather than the obvious hacks (auto-Escape mixed into the poller; interrupt strings
matched in many places; the form gated on the volatile `waitingFor`; the answer
located by blind positional scanning).

**Chosen approach** (confirmed with the user):
- **On-demand flush** — the pending indicator becomes an *"Answer here"* button; the
  flush only happens when a web user opts in, leaving terminal-answering undisturbed.
  No poller/event/job changes.
- **In-renderer answer correlation** — the renderer links the question tool-call to
  the follow-up `Answering your questions:` turn (marker-matched, windowed) and renders
  it inside the card; a predicate contribution hides the raw duplicate row. No new
  schema/DB/slot-primitive.

**Key correction baked in:** in this flow the AskUserQuestion `result` is the *interrupt
sentinel*, **not** the answer. The existing `parseAnswerMap(result.content)` path no
longer carries the answer for new questions — the answer is in the follow-up turn.

## Design

### A. Single-source interrupt classifier (generic infra)
One shared `isInterruptContent(text): boolean` (prefix-matched sentinel set) replaces
ad-hoc interrupt-string matching. Lives in `transcript-watcher/core` so both server
and web consume it.

### B. On-demand flush (runtime method + endpoint + button)
- Extend the `ConversationRuntime` interface with `flushInteractivePrompt(id)` — the
  *Escape-until-the-menu-clears* loop only, no paste. Implement in the tmux runtime by
  extracting the existing self-healing Escape loop from `answerPrompt`
  (`tmux-runtime.ts:552-579`) into a shared helper, reused by both.
- A new `POST /api/conversations/:id/flush-question` endpoint calls it, then clears
  `waitingFor` (`updateConversation(id, {waitingFor: null})` + `notifyConversationsChanged()`)
  so the indicator disappears immediately.
- A `JsonlViewer.PendingPrompt` dispatch slot (keyed on `conversation.waitingFor`,
  fallback = today's static indicator) lets the ask-user-question plugin contribute the
  `"question"` variant: an *"Answer here"* button that hits the flush endpoint. This is
  a small, well-scoped abstraction and seeds the future generic "pending interactive
  prompt" surface (kinds: question, permission, plan-approval — sibling to `allow-monitor`).

### C. Question state derived from JSONL, not `waitingFor`
The renderer computes state from the event stream alone (drop the
`conversation?.waitingFor === "question"` coupling in `ask-user-question-tool-view.tsx:249-253`):
- **answered (legacy):** `result` present, not an interrupt → `parseAnswerMap(result.content)` (unchanged path for old transcripts).
- **answered (new):** a follow-up answer turn is found → render parsed selections from it.
- **awaiting:** `result` is the interrupt sentinel **and** this is the last tool-call **and** no answer turn follows → show `<AnswerForm>`.
- otherwise render the question read-only (historical/edge).

### D. In-renderer answer correlation + suppression
- Move `ANSWER_MARKER = "Answering your questions:"` (today inline in `answer-form.tsx:29`)
  into the plugin's `shared/` as the single source for serialize + parse.
- The renderer finds the answer turn: first `user-text` after this tool-call's index
  whose text starts with `ANSWER_MARKER`, bounded by the next tool-call (a windowed,
  marker-keyed lookup — not a blind "next message" scan). Parse its `- <header>: <value>`
  lines into a header→value map and feed the **existing** `parseSelectedLabels`
  (`ask-user-question-tool-view.tsx:137-165`) per question to drive the existing
  answered-view rendering (lines 294-362).
- Suppress the raw duplicate row with a predicate-match `JsonlViewer.EventRenderer`
  contribution: `match: (p) => p.event.kind === "user-text" && p.event.text.startsWith(ANSWER_MARKER)`
  → renders nothing. Uses the existing `defineDispatchSlot` predicate support — zero new infra.

### E. Submit path — unchanged
The form keeps POSTing to the existing answer endpoint → `answerPrompt`. Because the
menu was already dismissed by the flush, `answerPrompt`'s Escape loop clears on the
first (uncached) probe and proceeds straight to paste. The submitted turn (with the
marker) lands in the JSONL, the correlation finds it, and the card flips from form to
answered.

## Files to create / modify (ordered)

1. **`plugins/conversations/plugins/transcript-watcher/core/interrupt.ts`** (new) —
   `isInterruptContent(text)` with the known sentinel prefixes.
2. **`plugins/conversations/plugins/transcript-watcher/core/index.ts`** (modify) —
   re-export `isInterruptContent`.
3. **`plugins/conversations/server`** (modify — `ConversationRuntime` interface + public
   wrapper, alongside `interruptConversation`/`answerPrompt`) — add
   `flushInteractivePrompt(conversationId)`.
4. **`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`**
   (modify) — extract the Escape-until-clear loop (`answerPrompt` lines 552-579) into a
   helper; implement `flushInteractivePrompt` (loop only, no paste); reuse helper in `answerPrompt`.
5. **`.../tool-call/plugins/ask-user-question/shared/`** (modify) — export `ANSWER_MARKER`;
   add `flushQuestion` endpoint definition (`POST /api/conversations/:id/flush-question`).
6. **`.../ask-user-question/server/`** (modify) — implement the flush handler:
   `flushInteractivePrompt(id)` then clear `waitingFor` + notify.
7. **`.../jsonl-viewer/web/slots.ts`** (modify) — define `JsonlViewer.PendingPrompt`
   dispatch slot keyed on `waitingFor`, fallback = current static indicator.
8. **`.../jsonl-viewer/web/components/jsonl-pane.tsx`** (modify) — render
   `PendingPrompt.Dispatch` instead of the static indicator; suppress it when an awaiting
   AUQ already exists in the events (`hasAwaitingAuq`) to avoid button+form overlap.
9. **`.../ask-user-question/web/`** (modify) — `AnswerHereButton` contributed to
   `JsonlViewer.PendingPrompt` (`match: "question"`); calls the flush endpoint.
10. **`.../ask-user-question/web/components/ask-user-question-tool-view.tsx`** (modify) —
    replace `isLive` with the JSONL-derived state (B/C); add `parseMarkerAnswer`; render
    the answered card from the correlated turn (new flow) or `result.content` (legacy).
11. **`.../ask-user-question/web/index.ts`** (modify) — add the predicate-match
    `JsonlViewer.EventRenderer` contribution that suppresses the raw marker turn.
12. **`.../ask-user-question/web/components/answer-form.tsx`** (modify) — import
    `ANSWER_MARKER` from `shared/` instead of the inline string.

No DB migration, no schema change, no poller/job/event changes.

## Edge cases

- **Answered in the terminal (free text, no marker):** no marker turn is found and the
  raw turn isn't suppressed; once the agent's normal result arrives the card renders via
  the legacy path. No regression.
- **Multiple AUQ calls:** the `lastToolCall.toolUseId === event.toolUseId` guard keeps
  only the most recent question's form live; older ones render read-only.
- **Button/form overlap window:** the flush handler clears `waitingFor` synchronously,
  and the pane also suppresses the button when an awaiting AUQ is already in the JSONL.
- **Flush fails (dropped Escape):** `flushInteractivePrompt` is self-healing (retries
  Escape until the probe clears, bounded) exactly like `answerPrompt` today; on hard
  failure the conversation stays in the pending state and the button remains.
- **Submit races the flush:** `answerPrompt` re-runs the (uncached) Escape loop, so it is
  correct whether or not the flush already dismissed the menu.

## Verification (end-to-end)

1. `./equin build`, open `http://<worktree>.localhost:9000`.
2. Launch a conversation and get the agent to call `AskUserQuestion`. Confirm the web
   pane shows the *"Answer here"* button (and `query_db`: `waiting_for = 'question'`).
3. Click *Answer here*. Confirm: the tmux menu is dismissed; the AUQ `tool_use` +
   interrupt result now appear in the JSONL (`~/.claude/projects/.../*.jsonl`); the button
   disappears and the answer form renders inside the question card.
4. Submit via the form. Confirm: the card flips to the answered view with selections
   highlighted; the raw `Answering your questions:` turn is **not** shown as a separate row;
   the agent continues with the answer.
5. Regression: answer a fresh AUQ directly in the terminal — confirm the card renders
   correctly with no stray form and no suppressed-row glitch.
6. History: a prior conversation with an older answered AUQ still renders correctly
   (legacy `result.content` path).

Use `e2e/screenshot.mjs --click "Answer here"` to capture before/after and confirm the
button → form transition in one run.
