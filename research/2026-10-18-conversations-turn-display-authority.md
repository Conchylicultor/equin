# Turn display: one authority per fact

## Context

Two user-visible bugs, one cause: four trackers each hold their own "where is
this turn", and the browser stitches them together by timing, not identity.

| tracker | fact | channel |
|---|---|---|
| tab store (`pending-turn/web/internal/send.ts`) | POST open / done / failed | memory |
| turn ledger (`conversation_turns`) | held → typing → typed → accepted | change feed |
| transcript (`jsonl-events`) | the turn is in the conversation | file watcher, re-ships the whole array |
| `conversations.status` | working / waiting | reconciler (CLI session file) |

1. **Echo vanishes for seconds.** `CARD_OF.typed = null` hides the echo the
   moment the ledger says `typed` (~1 s after send). The transcript shows the
   message only when the jsonl-events push lands — two independent channels; under
   load (`transcript-watcher:reconcile` 135 s/window) that is seconds.
2. **Stuck "Working".** `conv-1792338322-m400l5`, 15:53: turn sent, ran 13 s,
   interrupted, *Rewind to here*. The reconciler never saw the turn run (host
   overloaded), so `updatedAt` stayed 15:51:00; the rewind never told the ledger;
   the mailbox drained the hook 100 s late → row `accepted`. 
   `useOptimisticConversationStatus` (`turn.createdAt > conversation.updatedAt`)
   is then true forever. Sidebar and header feed it different rows → disagree.

Outcome: the echo is retired by the thing it stands in for (the transcript); the
status has one writer (the reconciler) whose inputs include the CLI's submit
hook; a rewind tells the ledger what it removed.

## 1. The transcript retires the echo

The transcript has no id shared with the ledger for every case (a busy agent's
queued turn is a `queue-operation` enqueue with no uuid, and the hook's
`prompt_id` is the *running* turn's — research/2026-10-15 E3). So the join is
**causal + ordinal**, done in the browser over the events it already holds:

- A ledger turn's transcript entry is a *human prompt event* — `user-text` with a
  `uuid`, a `queue-operation` `enqueue` with plain content, or a `queued_command`
  attachment with `commandMode: "prompt"` (the enqueue and attachment of one
  queued turn count once: take the enqueue, fall back to the attachment).
- It cannot predate the turn's ledger row (`createdAt`, server clock, same host as
  the CLI's timestamps): the server received the POST before it typed it.
- Sends are serialized per conversation, so the k-th still-unseen hooked turn
  (oldest first) is the k-th prompt event at/after the oldest one's `createdAt`.
- A turn older than one that is already matched is in too (its entry came first).

New pure function `turnsInTranscript(rows, events): Set<turnId>` in
`pending-turn/web/internal/pending.ts`, tested on fixtures.

`CARD_OF` stays the state → card Record; the echo rule becomes: states
`typing` / `typed` / `accepted` draw the echo **until the turn is in the
transcript**; `typed` with `hookless` keeps today's "nothing" (slash commands
render as other event kinds; nothing will refine them). `held` and `sending`
unchanged. `merged` keeps its warning.

`usePendingTurns(conversationId)` → `usePendingTurns(conversationId, events)`:
its one caller, `jsonl-pane.tsx`, already holds both results side by side. The
echo and the message now come from the same render, so there is no frame where
neither shows. A row that never reaches the transcript is retired by step 3
(`returned`) or by a later matched turn — never by a timer.

## 2. The reconciler is the one writer of `working`; the hook is one of its inputs

- Ledger row gains `submitted_at` (timestamptz, null until a hook matches): the
  mailbox file's `mtimeMs` — when the CLI submitted, even if the drain is late.
  Threaded `drainMailbox` → `resolvePromptSubmit(conversationId, prompt, at)` →
  the `hook` event → `TurnPatch.submittedAt` (set on `accepted` / `merged`,
  added to the `deriveUpdatedAt` touchedBy map like the other hook columns).
- The CLI session file already carries `statusUpdatedAt` (ms). Surface it in
  `SessionState` (`runtime-tmux/.../claude-session.ts`) and `RuntimeInfo`.
- `plan-update.ts`: `liveStatusFor(info, lastSubmitAt)` = `info.working ||
  (lastSubmitAt != null && info.statusUpdatedAt != null && lastSubmitAt >
  info.statusUpdatedAt)`. An idle written *before* the submit is stale
  evidence; one written after it (turn finished, interrupted) is current. Pure,
  unit-tested in `plan-update.test.ts`. In the 15:53 incident: submit 15:53:10,
  idle 15:53:22 → `waiting`, even though the hook drained at 15:54:48.
- The reconciler reads `lastSubmitAt` per conversation from the ledger (new
  `latestSubmitAt(conversationIds)` in turn-ledger server; conversations already
  imports turn-ledger, no cycle).
- Wake-up: turn-ledger exposes `onTurnSubmitted(listener)` (in-process, same
  shape as transcript-watcher's `onSessionTranscriptWritten`), fired after a hook
  match commits; the reconciler adds it to its signal set. Push, no polling.
- Browser: `useOptimisticConversationStatus` shrinks to the window before the
  server could know — this tab's sends without a row, and rows in `typing` /
  `typed` (hooked). From `accepted` on, the server's status stands.
  `latestLiveSendAt` is deleted. `createdAt > updatedAt` stays only as a bound
  (a typed row whose hook never comes stops overriding once the server's status
  moved), and the shared all-conversations ledger subscription stays (a sidebar
  row needs its `typed` rows).

Residual: between the ledger's `accepted` push and the status push (one
reconcile) the chip can read `waiting`. Same-host, event-driven — normally
milliseconds. Accepted rather than re-introducing a timestamp override.

## 3. Rewind tells the ledger

`rewindConversationAt` (conversations `lifecycle.ts`) cuts the transcript and
restarts the CLI, but leaves every cut turn `accepted`. After the cut is written,
return them: new turn-ledger `returnTurnsSince(conversationId, at)` — rows in
`typed` / `accepted` / `merged` whose `createdAt` ≥ the cut message's time — plus
`returnTurnByText(rewindText)` for the cut message itself (its row predates its
own transcript line). Both go through `applyTurnEvent({ kind: "returned" })`
(already a legal transition from those states). `stopTurn` already returns by
text; unchanged.

## Files

- `plugins/conversations/plugins/conversation-view/plugins/pending-turn/web/internal/pending.ts`
  (+ `__tests__/pending-turns.test.tsx`, `CLAUDE.md`)
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx`
- `plugins/conversations/plugins/turn-ledger/server/internal/{tables,transition,store,mailbox}.ts`
  (+ tests, `CLAUDE.md`), `server/index.ts` (export `onTurnSubmitted`,
  `latestSubmitAt`, `returnTurnsSince`)
- `plugins/conversations/plugins/runtime-tmux/server/internal/{claude-session,pane-status,tmux-runtime}.ts`
- `plugins/conversations/server/internal/{plan-update,status-reconciler,lifecycle,runtime}.ts`
  (+ `plan-update.test.ts`)
- Migration generated by `./singularity build`.

## Verification

- `./singularity test` on pending-turn, turn-ledger, conversations server
  (plan-update), runtime-tmux.
- Build, then in the worktree app: send a turn to an idle agent and one to a busy
  agent; the echo must stay until the transcript row appears, with no gap
  (screenshot sequence via `browser_*`). Rewind a turn: header chip and sidebar dot
  both `waiting`, ledger row `returned` (`query_db`).

## Out of scope

Transcript channel cost (whole-array re-ship) — filed as its own task.
