# AskUserQuestion answered from the web through a PreToolUse hook (question relay)

## Context

Today a question asked with `AskUserQuestion` reaches the web only by **cancelling** it in the
terminal (`research/2026-06-02-conversations-askuserquestion-web-flush.md`):

1. The CLI withholds the `tool_use` from the transcript until the tool resolves.
2. The app sends Escape to the pane (auto-open config, or "Answer here"). That forces the write
   with an interrupt result.
3. The answer is then pasted as a separate `Answering your questions:` user turn.

Consequences:

- The agent sees "user doesn't want to proceed" followed by a pasted turn, not a real answer.
- The renderer has to correlate the cancelled call with that later turn, and hides two event kinds
  to do it.
- An Escape that races a lagging capture-pane risks a double Escape, which opens the rewind menu.
- The question shows on the web only 0.7–5.5 s after it was asked, and is detected by scraping the
  screen.

The push-status work (`research/2026-10-02-conversations-poller-push-status.md`, now implemented)
already launches every agent with a `PreToolUse` hook on `AskUserQuestion`
(`runtime-tmux/server/internal/launch-settings.ts`). Today it only `touch`es a signal file.

**Decision (user, 2026-10-06): the web is the primary answer surface, and the hook never gives up
on a timer.**

- The hook holds the tool call while the web shows the question.
- The web's answer goes back as `updatedInput.answers`, which the CLI turns into a **real tool
  result**.
- The terminal menu appears only when the hook releases. That happens when the user clicks *Answer
  in terminal*, or when the backend stays unreachable.

## What the CLI does (2.1.291, installed; static read of the binary plus docs)

- **A hook can answer the question.** `AskUserQuestion.checkPermissions` returns `behavior:"ask"`,
  and `call(input)` reads `input.answers`, `input.annotations` and `input.response`. The menu is
  simply the permission component that fills in `answers`. In the PreToolUse `allow` path, a tool
  with `requiresUserInteraction()` is let through only when the hook supplied `updatedInput`. The
  binary's own log line is `Hook satisfied user interaction for ${tool} via updatedInput`. Without
  `updatedInput`, the hook's allow falls back to the ask (the menu).
- **The answer shape is the tool's own schema.**
  - `answers`: question text → answer string. Multi-select values are comma-joined, or an array of
    labels.
  - `annotations`: question text → `{notes, preview}`.
  - `response`: optional free text in place of the answers.
  - `questions` must be passed back unchanged.
  - The tool result reads `Your questions have been answered: "q"="a", …`. That is exactly what the
    existing `parseAnswerMap` (`ask-user-question/web/components/answer-model.ts`) already parses
    for answers given in the terminal.
- **Hook timeouts.** The default timeout for command hooks is 600 s and is set per hook. A hook
  that times out or exits 0 with no output does not block: the call continues to the normal
  permission flow, which here means the menu is drawn. That is the release path. The maximum
  `timeout` is not documented.
- **Transcript timing.** Per the docs, the transcript is written asynchronously, so the relay takes
  the question from the hook's `tool_input` and `tool_use_id`, never from the transcript. Whether
  2.1.291 still withholds the `tool_use` no longer matters on this path: the tool resolves as soon
  as the answer arrives, and only then is the `tool_use` and its real result written.
- **Still unconfirmed**, so Phase 0 verifies each one:
  - The TUI actually skips the menu when the hook allows with `updatedInput`.
  - The largest `timeout` the CLI accepts.
  - What Escape does in the terminal while a hook is running: whether it kills the hook, and what
    result it writes.
  - Whether `statusMessage` is shown.

## Phase 0 findings (2026-10-06, CLI 2.1.291, interactive TUI in tmux)

1. **A hook can answer: confirmed.**
   - When the hook allows with `updatedInput:{questions, answers}`, no menu is drawn.
   - The transcript gets the real result, the same text the native menu writes:
     `Your questions have been answered: "q"="Blue". You can now continue…`, with `is_error` null.
   - PostToolUse fires.
   - The pane shows `⏺ User answered Claude's questions: · q → Blue`.
2. **A hook that exits 0 with no output draws the normal menu.** A `Notification` hook fires when the
   menu shows. It does not fire on turns the hook answered.
3. **There is no timeout clamp.**
   - The schema is `timeout: positive()`, and the value goes straight into a `setTimeout`.
   - A hook with `timeout: 86400` slept 720 s untouched, and the menu followed.
   - Use `timeout: 2_000_000` s. That is about 23 days, under `setTimeout`'s 24.8-day limit.
4. **Escape while the hook waits.**
   - The hook gets **SIGTERM**. A hook that ignores it is SIGKILLed about 8 s later.
   - The transcript gets an `is_error` "doesn't want to proceed" result, then
     `[Request interrupted by user for tool use]`.
   - **No PostToolUse, PostToolUseFailure, UserPromptSubmit or Stop hook fires.** So the relay
     **traps SIGTERM** and POSTs `abandon` before it exits.
   - `relay_pid` liveness, checked on any later reconcile or the sweep, is the backstop.
   - The transcript result for the `tool_use_id` stays the authority on the web.
5. **`statusMessage` is shown as the spinner text.**
6. **The hook's stdin carries everything the relay needs:** `tool_use_id`, the full
   `tool_input.questions`, `session_id` and `transcript_path`.

Answer shapes:

- Every value is a **string**.
  - Multi-select is **joined with `", "`**. An array is accepted but degrades: the model sees
    `Leek,Corn` and the pane draws no answer block.
- Free text that matches no label is accepted. The result is then worded `The user answered: …`.
- `annotations: {q: {notes}}` appends `notes: …`.
- A top-level `response` gives `The user responded: …`.
- Several questions in one call work.

## Design

### Phase 0 — spike (done; findings above)

The spike is a throwaway script under the scratchpad that launches `claude` in tmux with a
`--settings` hook, then asks a question. It must establish the following; each finding is recorded
in this doc.

1. A hook that prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{questions, answers}}}`
   means no menu is drawn, the transcript gets the `tool_use` plus the real `Your questions have been
   answered` result, and the agent continues. Test single-select, multi-select, free text in
   `answers`, `annotations.notes`, and `response`.
2. A hook that exits 0 silently means the normal menu is drawn.
3. Set `timeout` to 86400 and find out whether the CLI clamps it.
   - If the clamp is ≤ 600 s, "never give up" cannot be literal. The fallback is that the relay
     releases just before the clamp. That surfaces the menu, and today's Escape path still answers
     it from the web. Stop and report to the user before going further.
4. Press Escape in the terminal while the hook is waiting. Record whether the hook process is
   signalled (and with what signal), what tool result is written, and which of `PostToolUseFailure`
   and `UserPromptSubmit` fire.
5. Check that `statusMessage` shows as the spinner text.

### 1. New plugin `conversations/plugins/question-relay`

It owns the pending question from the hook to the answer. It has `core`, `server`, `web` and `bin`.

- **Table `pending_questions`.**
  - Columns: `conversation_id` (FK, cascade), `tool_use_id` (PK), `questions` jsonb (zod-decoded via
    `parsedJson`), `relay_pid` int, `state` (`open | answered | released | abandoned`), `answer`
    jsonb (`{answers, annotations?, response?}`), `created_at`, `resolved_at`.
  - A `defineRetention` sweep removes rows 7 days after they resolve.
- **Live collection** `pendingQuestions`: `liveCollection` + `serveCollection`, lookup by
  conversation, `where state = 'open'`, a small `limit`.
- **Endpoints** (`core`):
  - `POST /api/conversations/:id/questions`. The relay registers with `{toolUseId, questions, pid}`.
    It is an idempotent upsert on `toolUseId`, so a relay that reconnects after a backend restart
    re-registers harmlessly.
  - `GET /api/conversations/:id/questions/:toolUseId/await`. A long-poll held for at most 45 s,
    under Bun's `idleTimeout: 60` in `server-core/bin/index.ts`. It returns `{state, answer?}`. It
    is woken by an in-process waiter map keyed by `toolUseId`, which the answer and release writes
    resolve. No timer loop: a held request either returns on the push or at its cap.
  - `POST …/:toolUseId/answer {answers, annotations?, response?}`. Validates the input against the
    stored questions: every key is a question text, and every non-free-text value is one of its
    labels. Then `state=answered`, and the waiter is woken.
  - `POST …/:toolUseId/release`. Sets `state=released` and wakes the waiter. This is *Answer in
    terminal*.
- **Relay script** `bin/ask-relay.ts`. Plain `bun`, no npm imports, like the guard hooks.
  1. Read the hook's stdin JSON, then register.
  2. Loop on `/await`. A connection error or a 5xx means the backend is restarting or a build is
     running: retry with doubling backoff, capped at 5 s. This is a reconnect, not a poll.
  3. On `answered`: print the PreToolUse allow with `updatedInput: {questions: tool_input.questions,
     ...answer}`, then exit 0.
  4. On `released`, or when the backend has been unreachable for 5 consecutive minutes: exit 0 with
     no output, so the menu is drawn.
  5. On SIGTERM (Escape in the terminal): POST `…/:toolUseId/abandon`, with a 2 s bound, then exit.
  6. It never exits on a wall-clock timer otherwise (the user's decision).
  - The base URL is `http://$SINGULARITY_PARENT_HOST.localhost:9000`, the same route `.mcp.json`
    uses. Both variables are already on the pane's env allowlist (`agent-session-env.ts`).
- **Hook fragment** (`core`): `questionRelayHook({ scriptPath })` returns one PreToolUse hook
  entry: `{type:"command", command:"bun '<abs path>'", timeout:<Phase 0 max>, statusMessage:"Waiting
  for your answer in equin…"}`.
  - `scriptPath` is resolved at launch from the launching backend's checkout (`getWorktreeRoot`).

### 2. Launch wiring (`runtime-tmux`)

- `signalHookSettings` → `launchHookSettings({ signalDir, relayScript })`. The existing `touch` and
  the relay both go under the `PreToolUse` `AskUserQuestion` matcher. Hooks on one matcher run in
  parallel, so the touch still wakes the reconciler immediately.
- `mergeLaunchSettings` is unchanged: one `hooks` fragment, still built in one place.
- Extend `launch-settings.test.ts`: the relay entry is present, the JSON contains no single quote,
  and the script path is absolute.

### 3. Status: an open relay question is "waiting on a question" (`conversations/server`)

While the relay holds the call, no menu is on screen, so `classifyPaneMenu` reads `idle`.

- `planConversationUpdate` (`plan-update.ts`) gets a new input, `relayQuestionOpen: boolean`, read
  by `reconcileIds` from `pending_questions` with one PK-indexed query per batch.
  - It maps to `working:false, waitingFor:"question"`, so the status dot and notifications behave as
    today.
- **Split the auto-open trigger from `waitingFor`.**
  - Today `questionOpened` is `waitingFor` turning `"question"` (`plan-update.ts:197`). That would
    make auto-open send Escape into a relay-held call and cancel it.
  - It becomes `menuOpened`: the **pane** verdict turning `question`. A relay-held question has no
    menu, so it can never trigger a flush.
  - This is a type-level split: two fields, `menuOpen` and `relayQuestionOpen`, never one ambiguous
    boolean.
- **Abandoned rows.** On every reconcile of a conversation with an open row, if `relay_pid` is not
  alive, set `state=abandoned`.
  - This covers Escape in the terminal killing the hook, the agent dying, and the pane closing.
  - The wake-ups already exist: `PostToolUseFailure`, `UserPromptSubmit`, the tmux hooks and the
    sweep job.
  - The web also treats a row as resolved as soon as the transcript holds a result for its
    `tool_use_id`. The transcript is the authority; the row is only the early copy.

### 4. Web (`question-relay/web`, `ask-user-question`)

- **Make `AnswerForm` presentational.** Today it builds the marker text and calls
  `sendConversationTurn`. Split it:
  - `AnswerForm({ questions, onSubmit(answer), draftKey })` produces the structured `{answers,
    annotations, response}`.
  - The legacy marker serializer moves into the legacy submit wrapper, so the old path behaves the
    same as today.
- **`RelayQuestionCard`**, contributed to `JsonlViewer.PendingPrompt` `"question"`.
  - It reads `pendingQuestions` for the conversation.
  - With an open row, it renders the question card and form at the bottom of the transcript, plus
    an *Answer in terminal* secondary action.
  - Submit calls `useEndpointMutation(answer)`. This is not a turn send, so there is no pending-turn
    record: the tool result is the confirmation.
  - With no open row, it renders today's `AnswerHereButton`. That keeps the flush path for hookless
    sessions (launched before the deploy, adopted, or manual) and for released questions.
  - Because two plugins compete for the `"question"` key, ask-user-question stops contributing
    `AnswerHereButton` directly. `question-relay/web` composes it as its fallback, importing it from
    `ask-user-question/web`'s barrel.
- Once the answer lands, the transcript gets the `tool_use` and its real result. The existing
  answered view (`parseAnswerMap`) renders it with no correlation and no hidden turns.
  - The marker and interrupt `EventFilter`s, `findAnswerTurn` and *Change answers* all stay, for
    legacy questions only.
  - *Change answers* on a relay-answered question is out of scope. That answer lives in a tool
    result, exactly like a terminal answer, so the existing "terminal answers cannot be changed"
    rule already covers it.

### 5. Documentation

- `runtime-tmux/CLAUDE.md`: the PreToolUse hook now also relays.
- `ask-user-question/CLAUDE.md`: there are two answer paths, and which one owns what.
- The new `question-relay/CLAUDE.md`: the lifecycle (open → answered | released | abandoned), what
  the relay does on a backend restart, and the never-time-out rule.
- In `research/2026-06-02-…`, add a pointer line saying the flush path is now the fallback.

## Critical files

- New: `plugins/conversations/plugins/question-relay/{core,server,web,bin}/…`, including
  `bin/ask-relay.ts`, `server/internal/{tables,await-waiters,handle-*}.ts`, and
  `web/components/relay-question-card.tsx`.
- `plugins/conversations/plugins/runtime-tmux/server/internal/{launch-settings.ts,launch-settings.test.ts,tmux-runtime.ts}`
- `plugins/conversations/server/internal/{plan-update.ts,plan-update.test.ts,status-reconciler.ts}`:
  the `menuOpen` / `relayQuestionOpen` split.
- `…/tool-call/plugins/ask-user-question/web/{index.ts,components/answer-form.tsx,components/answer-here-button.tsx}`

Reused:

- `defineEndpoint` / `useEndpointMutation`
- `liveCollection` / `serveCollection`
- `parsedJson`
- `defineRetention`
- `getWorktreeRoot`
- the existing signal-file wake-ups
- `parseAnswerMap`
- `flushInteractivePrompt` (fallback only)

## Verification

1. Phase 0 findings are written into this doc, and the user is consulted if the timeout clamp breaks
   "never".
2. Unit tests: `./equin test plugins/conversations`.
   - `plan-update` cases: a relay-open question → waiting/question with no flush; the menu opening →
     a flush only when auto-open is on.
   - Answer validation: an unknown question, an unknown label, free text, a multi-select array.
   - The relay script's output for `answered` and `released`, run against a stub server.
3. `./equin build`, then `./equin check`.
4. Live, from the worktree app (driven by `e2e/` script `question-relay/e2e/relay-verify.ts`):
   - Start an agent prompted to ask a 2-question AskUserQuestion. The card appears in under 1 s with
     no Escape sent. The pane shows the `statusMessage` spinner. `query_db` shows the row as `open`
     and the conversation with `waiting_for='question'`.
   - Answer on the web. The transcript gets the `tool_use` plus `Your questions have been answered`,
     not an interrupt. The card flips to answered, and the agent continues.
   - *Answer in terminal*: the menu is drawn and is answerable in tmux. "Answer here" still works
     after it.
   - Escape in tmux while the question is held: the row becomes `abandoned` and the card disappears.
   - Run `./equin build` while a question is held: the relay reconnects, the question
     survives, and answering it after the restart works.
   - A hookless session (launched with the old settings): the legacy flush path is unchanged.
