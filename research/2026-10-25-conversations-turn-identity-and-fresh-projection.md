# Conversation state integrity: turn identity end to end, and no stale projection read as fact

## Context

Incident `conv-1792928993-rqsi2p` (2026-10-25): main's sdk event consumer did nothing for one
conversation for the whole backend lifetime (`conversations_ext_sdk_agent.cursor_seq = 0` while
the agent wrote 870+ events; no report, no log). After main restarted, the boot catch-up read all
1186 events at once, so the file and the reducer were fine. Something in that process's per-conversation
in-memory state was wedged. The most likely cause is a `catchUp` run that never settles, which pins
the keyed coalescer slot so every later trigger folds in behind it. Because of the stall:

- the launch turn stayed `typed`, so the user saw their message twice: once in the transcript and
  once as an echo reading "Waiting for the agent to take it…";
- status stayed `waiting` while the agent ran a build;
- the launch took 60 s: `waitForHello` only re-checks hello after the projection advances, so it
  ran out `READY_TIMEOUT_MS`, and `awaitStart` treats that timeout as success.

Two structural defects made this silent instead of loud:

- **(A) Turns are matched by text, not identity.** The agent protocol already echoes a `turnId` in
  `turn_started` and gives each prompt a `promptUuid`, which is the transcript line's uuid. But the
  backend sends `turnId: null`, so the ledger matches by text (equal / contains / merged /
  withdrawn-exact), and the web echo retires on a timestamp guess (`transcriptShows`). This design
  was proposed once before (`conv-1792358855-tkczpg`, 2026-10-20) and dropped without a plan. Text
  matching was a tmux-era necessity: under the sdk-only runtime nobody types into the CLI, so every
  prompt the agent takes is one we sent, with our id.
- **(B) Every reader trusts the projection.** Status (`liveStatusFor`), the ledger confirmation, the
  question relay and `agent_pid` all come from one push-maintained projection that can stop
  advancing without anyone noticing. The agent already reports its own head (`hello.seq`) and
  nobody reads it.

Goal: a turn is one identity from the browser to the transcript line, and no decision or display
uses a projection that hasn't been checked against the agent's own head. When it can't be checked,
that is a visible state ("Unknown") and a report, never a confident `waiting`.

## Part B — a projection is read at the log's head, or not at all

### B1. `awaitStart`: wait on the right thing, and give each outcome a type
`plugins/conversations/plugins/runtime-sdk/machine/internal/sdk-runtime.ts` (`waitForHello`, `awaitStart`)

- Fix the loop bug: hello is re-checked only when the projection advances, so a stalled consumer
  makes a ready agent look 60 s slow. Wait for the consumer to apply the agent's `started` event
  (projection `agentPid !== null`), with the deadline. The `started` event is the push.
- At the deadline, ask `helloAgent` once and return a discriminated outcome:
  - `ready`;
  - `slow`: no hello yet. This keeps today's documented behaviour ("a slow start is not a
    failure"), left to the readiness waiters.
  - `consumer-behind`: hello answers with `seq > row.cursorSeq`. Record a report (new kind
    `sdk-consumer-stalled`, with the conversation, the cursor and the agent's seq). Do **not**
    throw: the agent is up and has taken the launch prompt. Throwing would `release` the turn back
    to `held`, and the flush would send it a second time.
- `exited` still throws `AgentStartError`.

### B2. Catch-up is bounded and observable
`runtime-sdk/machine/internal/consumer.ts`

- Run `catchUp` under `runTracked("runtime-sdk:catch-up")` with a deadline, implemented as a
  per-key watchdog over the coalescer's in-flight run. Past the deadline (e.g. 30 s), record a
  `sdk-catch-up-overdue` report naming the step it is parked in. Track the step with a `stage`
  variable set before each await (`read-row`, `effect:<kind>`, `write-projection`). This is how we
  find what wedged the incident. Only the report is new; there is no cancellation, since the work
  cannot be safely aborted mid-effect.
- `catchUp`'s silent `if (!row) return`: keep it only for "`create` has not prepared a row
  yet" (no row *and* no events file). An events file without a row is reported.
- `isOurs` negative cache: drop the cache for `false` answers. It is one indexed lookup per
  watched event batch, and a cached `false` is a silent forever-skip of the same kind as this
  incident.
- Hoist a shared `withDeadline` into `plugins/packages` (today it is local to
  `safe-fetch/browser-fetch`) and use it for the watchdog and for B3.

### B3. The reconciler never plans from an unchecked projection
`runtime-sdk/machine/internal/sdk-runtime.ts` (`inspectAgents`),
`conversations/server/internal/{runtime,status-reconciler,plan-update}.ts`

- `inspectAgents` already calls hello for every id. Keep the reply (`HelloReplySchema.seq`) instead
  of discarding it (`answersHello` becomes `helloOf`, returning the reply or `not-running`).
- When `row.cursorSeq < hello.seq`, run `catchUpNow(id)` under `withDeadline` (e.g. 5 s), then
  re-read the row. If it is still behind, that id's liveness is **`unknown`** (per conversation).
  Today only a whole-runtime failure is `unknown`.
- `ConversationRuntime.inspect` returns `Map<id, RuntimeInfo | { kind: "unverified"; reason }>`
  (a tsc change at the one runtime and the one consumer). `livenessOf` maps it to `unknown`.
- `planConversationUpdate` on `unknown` writes `statusUnverifiedSince = now` if not already set,
  and leaves `status` untouched. On `live`, it clears it.
- The per-minute `conversations.status-sweep` already calls `reconcileAll`, so the B3 check
  runs at least once a minute for every live agent. That is the backstop the incident lacked.

### B4. "Unverified" is rendered, not hidden
- New nullable column `conversations.status_unverified_since` (in `tasks-core`'s conversation
  fields), carried on the wire.
- `conversation-view/plugins/status` (`status-badge.tsx`) and `conv-status-dot.ts` render an
  "Unknown" chip / dot while it is set. The tooltip says since when and why.
- The transcript foot's activity line (`jsonl-pane.tsx`) does not claim "waiting" while it is set.

## Part A — one turn identity, browser to transcript line

### A1. Pass the ledger id to the agent
- `ConversationRuntime.send(id, turn: { turnId, text })` and `answerPrompt(id, turn)`; `create`'s
  `opts.prompt` becomes `{ turnId, text }`. tsc lists every call site:
  - `turns.ts`: `typeInto`, `launchWithHeldTurn`;
  - `lifecycle.ts:570`;
  - `spawn-job.ts:100`.
- `sdk-runtime.ts` `sendTurn` sends the real `turnId`. `AgentLaunchOptionsSchema.prompt` becomes
  `{ turnId, text } | null`, and `bin/agent.ts:658` calls `pushInput(prompt.text, prompt.turnId)`.
  Bump `PROTOCOL_VERSION`. Running agents launched under the old protocol already sent
  `turnId: null`; handle them in A2.
- `turnId` stays `string | null` on the protocol only for the agent's own internal turns, if any.
  The backend never sends `null`.

### A2. Confirm by id; record the transcript uuid
- Reducer `prompt-submitted` effect carries `{ turnId, promptUuid, at }`, dropping the text
  (`runtime-sdk/server/internal/reducer.ts:204-215`). The consumer calls
  `confirmTurn(conversationId, turnId, promptUuid, at)`, replacing `resolvePromptSubmit`.
- Ledger: new column `prompt_uuid` (set on confirmation). The `confirmed` event becomes
  `{ promptUuid, at }`, applied to **that row by id**: `typing | typed | unverified | failed |
  withdrawn → accepted`. A row already settled is a no-op (fixed point kept).
- `turnId: null` in an event is reported (`turn-without-id`), not matched, with one exception.
  The exception, for the transition only: an agent started before the protocol bump falls back
  to the old text path. Delete that fallback once no pre-bump agent is alive. Gate it on the
  agent's `PROTOCOL_VERSION` from `hello`, so it cannot outlive them silently.

### A3. Delete text matching
`turn-ledger/server/internal/{transition,store}.ts`, `turn-ledger/core`, `machine/internal/report-kinds.ts`, pending-turn web

- Delete `matchPrompt`, `promptCandidates`, `CONFIRM_ROLE`'s text roles, the `merged` state and
  its `submitted_text` / `extra_text` columns, the `turn-merged` report kind, `turnVerdictSink`'s
  merged arm, and the web merged card (`pending.ts`, `pending-turn-card.tsx:168-176`).
  A merge cannot happen: each turn is its own SDK user message.
- Data migration: existing `merged` rows → `accepted`. Drop the columns.
- `transition.test.ts` matrix shrinks accordingly. Keep the fixed-point and order-independence
  tests: a confirmation before or after `typed` still lands.
- Stop: `runtime.stop` returns the stopped prompt's `promptUuid` (it already has
  `settled.lastPromptUuid`), not its text. `returnTurnByText` becomes `returnTurnByPromptUuid`.
  The draft text comes from the row.
- Rewind: `returnCutTurns` already has the cut user line's uuid (`locateTranscriptCut`). Return
  that row by `prompt_uuid`; `returnTurnsSince` stays for the rows after it.
- Stale comments go: "typed in the terminal is not ours" (`store.ts`), and "`prompt_id` is no
  turn id" (`transition.ts`).

**Done (2026-10-25).** Also deleted: the `unverified` state. The sdk runtime's `send` never
produced it (its `SubmitVerdict` was always `submitted`), so `SubmitVerdict` / `TypedTurn` went
(`send` / `answerPrompt` return `void`), with the card's "Not confirmed" arm and
`turnVerdictSink`. The data migration `retire_text_matched_turns` moves `merged` → `accepted`
and `unverified` → `failed` (keeps its error and Retry). The `turn-unverified` report kind
stays registered as retired while main still has rows of it (the `turn-unconfirmed`
precedent); `turn-merged` had none and is gone. The projection's `last_prompt_text` column went
with Stop's text. The legacy id-less path is equality only, for a pre-turn-id agent's launch
prompt; it goes once no live `conversations_ext_sdk_agent` row has `turn_ids = false`.

### A4. The echo retires on its own transcript line
`conversation-view/plugins/pending-turn/web/internal/{landed,pending}.ts`, `turn-ledger/core/resources.ts`

- `LedgerTurn` gains `promptUuid`. `transcriptShows` becomes: the row is `accepted` **and**
  either the loaded transcript holds a user event with `uuid === promptUuid`, or the loaded window
  begins after the row's `submittedAt`. The second case means the line is above the window, so
  the echo is not on screen anyway. No "newest event is later" guess.
- Open item, to be verified in the first implementation step: does a slash command or `!` line
  taken through the SDK write a user line with our uuid? Today `isSlashCommand` special-cases
  them. If they write none, keep the special case keyed on the row's kind/text prefix and say why.
- `useTurnsInFlight` / `markerAnswerInFlight` (question card) keep reading `confirmed` from the
  state. Nothing text-based changes there.

**Finding (2026-10-25, implementation).** Checked over every sdk agent's `events.jsonl` on this
machine (1,141 `turn_started` lines) against the Claude Code transcripts:

- A slash command writes a user line with our uuid: `/compact` →
  `<command-name>/compact</command-name>…` under the turn's `promptUuid`, then its
  `<local-command-stdout>` line. The parser emits it as a `user-text` event with that `uuid`
  (pinned in `transcript-source`'s `parse-jsonl.test.ts`). So `isSlashCommand` is deleted, not
  kept. No `!` turn occurs in the sample; the agent sends one as an ordinary SDK user message.
- The case the plan did not foresee: a turn sent while the agent is busy can be **absorbed into
  the running turn** (`queue-operation remove, reason: absorbed_mid_turn`). Then there is no
  user line at all — only a `queued_command` attachment whose `source_uuid` is our uuid
  (39 of 1,141 turns). The echo therefore retires on either shape (`landed.ts`).
- Rows accepted before `prompt_uuid` existed have none; they keep the old newest-event rule,
  marked temporary — retention sweeps settled rows after 7 days, so it can go a week after the
  column reached main.
- Residual: a busy agent's queued turn is confirmed when the agent queues it (`submittedAt`),
  before its line is written. If the tail window slides past `submittedAt` before the turn is
  absorbed or dequeued, the window-start rule retires its echo early (the `queue-operation`
  enqueue card, written at queue time, is then above the window too).

## Order of work (each step ships green on its own)

1. **B1**: `awaitStart` outcomes, plus the `sdk-consumer-stalled` report (small, independent).
2. **B2**: catch-up watchdog report and the `isOurs` / `!row` silences; `withDeadline` in packages.
3. **B3 + B4**: per-conversation `unknown`, `status_unverified_since`, the "Unknown" chip.
4. **A1 + A2**: id plumbing, protocol bump, confirm by id with the gated legacy fallback.
5. **A4**: echo by transcript uuid (after the slash-command check).
6. **A3**: delete text matching, `merged`, the columns; then remove the legacy fallback once no
   pre-bump agent runs.

## Critical files

- `plugins/conversations/plugins/runtime-sdk/machine/internal/{sdk-runtime,consumer,socket-client}.ts`
- `plugins/conversations/plugins/runtime-sdk/{bin/agent.ts,core/protocol.ts,server/internal/reducer.ts}`
- `plugins/conversations/plugins/turn-ledger/{server/internal/{store,transition}.ts,core/*,machine/internal/report-kinds.ts}`
- `plugins/conversations/server/internal/{turns,runtime,status-reconciler,plan-update,lifecycle,spawn-job}.ts`
- `plugins/conversations/plugins/conversation-view/plugins/{pending-turn,status}/web/…`
- `plugins/tasks/plugins/tasks-core/core/…` (conversation fields: `status_unverified_since`)
- Docs: `turn-ledger/CLAUDE.md` (states, matching section → identity), `runtime-sdk/CLAUDE.md`.

## Verification

- Unit tests:
  - `transition.test.ts`: the new matrix, confirmation by id before and after `typed`, a no-op
    on settled rows.
  - `plan-update.test.ts`: `unknown` sets `statusUnverifiedSince`, `live` clears it, and `status`
    is untouched on `unknown`.
  - Reducer test: `prompt-submitted` carries `turnId` / `promptUuid`.
  - `landed` test: retires by uuid and by window-start, not by newest-event time.
- Fault injection in my own build: make `catchUp` hang for one conversation (an env-gated
  `await new Promise(() => {})` in a scratch commit). Expect:
  - launch completes in seconds with an `sdk-consumer-stalled` report;
  - a `sdk-catch-up-overdue` report naming the stage;
  - within one minute, an "Unknown" chip.
  Remove the hang and confirm the chip clears.
- End to end, `plugins/conversations/plugins/turn-ledger/e2e/send-flow.ts` against my build:
  - a launch prompt plus two turns sent while busy each become `accepted` with distinct
    `prompt_uuid`s;
  - their echoes retire exactly when their own lines appear;
  - Stop returns the right turn to the draft.
- `query_db`: no `conversation_turns` row left `typed` for a conversation whose agent has
  confirmed it (`prompt_uuid` set ⇔ `accepted`).
