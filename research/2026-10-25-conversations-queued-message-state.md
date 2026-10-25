# Queued messages: the CLI's own queue lifecycle drives the Queued state

## Context

A message sent while the agent works renders three ways today: an echo with
"Sending…" that vanishes almost at once, a tool-style `QueuedPromptCard` (raw
text, caption size — `<go>` blocks shown as tags), and a "Removed from queue"
one-liner repeating the text. The user asked for a queued message that looks
like a regular message, stays last in the transcript until the agent receives
it (new tool calls land above it), with its status and **Send now** under it —
prototype `proto-1792940305-6qqhd5`.

The echo already does the first two (it is the host's own user row, mounted
after the transcript). It vanishes too early because the ledger confirms a turn
on `turn_started`, which `runtime-sdk/bin/agent.ts` emits when the SDK *pulls*
the message from its input generator — immediately, while the message still
sits in the CLI's command queue.

## Live findings (SDK 0.3.303, CLI 2.1.308, haiku, 3 × `sleep 6` turn)

- The SDK stream carries an (untyped) `command_lifecycle` message per user
  message: `{command_uuid, state: queued | started | completed | cancelled}`,
  `command_uuid` = the `SDKUserMessage.uuid` we mint. A message sent mid-turn
  went `queued` at once and `started` at the **next tool boundary** (folded into
  the running turn), `completed` with the turn.
- Transcript side of the same fold: `queue-operation enqueue` → … →
  `attachment queued_command` (its `timestamp` is the *enqueue* time,
  `source_uuid` = our uuid) → `queue-operation remove` (`reason:
  absorbed_mid_turn`). **"remove" means delivered (folded in), not discarded.**
  No `user` line is written for a folded prompt.
- `priority: 'now'`: the running turn is aborted at once (`result`, its command
  `cancelled`) and the new message starts a fresh turn. `'later'`: not folded
  mid-turn; waits for the turn to end.
- Cancelling a queued message (`cancel_async_message`) exists in the CLI
  protocol but is not exposed by the SDK's `Query` — out of scope (no Edit /
  Remove).

## Design

1. **Confirmation = the CLI started it** (`runtime-sdk/bin/agent.ts`). Yielded
   turns wait in a uuid map; `turn_started` is emitted on the matching
   `command_lifecycle` `started` (or `completed` if no `started` came — a
   command the CLI ran without a model turn). A CLI that emits no lifecycle at
   all (detected at its first `system/init` with nothing seen) falls back to
   confirming at yield, logged. The event shape is unchanged, so backend,
   reducer and ledger keep their contract; only its moment becomes true.
2. **A turn the agent never took fails loudly.** The reducer's `exited` effect
   `turns-dropped` makes every `typed` row created before the exit `failed`
   ("The agent stopped before taking this message") — Retry / Copy to draft —
   via a new ledger event `dropped` (typed → failed). A late confirmation still
   wins (failed is confirmable).
3. **Echo retirement by identity.** The confirmation carries `promptUuid`,
   stored on the ledger row (`prompt_uuid`, exposed on `LedgerTurn`). The echo
   retires when the transcript holds a `user-text` event with that uuid, or (as
   today) reaches `submittedAt`. Fixes the fold case, whose message row carries
   the enqueue time.
4. **Transcript.** The parser turns a plain-prompt `queued_command` attachment
   into a `user-text` event (uuid = `source_uuid`, `at` = the delivery moment),
   so a folded message renders exactly as a user message; human-prompt
   `queue-operation` lines are dropped (the echo is the queued state, the
   user-text row the delivery). The `queue-operation` event kind, its renderer
   and `QueuedPromptCard` are deleted; a non-prompt queued command that does
   not parse falls back to a card inside the queued-command attachment view.
5. **Pending card.** An echo whose turn is `typed` while a turn runs reads
   `Queued` (clock, no shimmer) with a **Send now** button: `POST
   /api/conversations/:id/interrupt` → `interruptConversation` (plain
   interrupt — queued messages survive it and run next, verified behaviour of
   the interrupt receipt). Otherwise captions are unchanged.

## Files

- `runtime-sdk/bin/agent.ts`, `runtime-sdk/core/protocol.ts` (turn_started doc),
  `runtime-sdk/server/internal/reducer.ts` (+ `turns-dropped`, promptUuid on
  `prompt-submitted`), `runtime-sdk/machine/internal/consumer.ts`.
- `turn-ledger`: `transition.ts` (`dropped`, `confirmed.promptUuid`),
  `store.ts` (`resolvePromptSubmit(…, promptUuid)`, `dropTypedTurns`),
  `tables.ts` + `core/entity.ts` (`promptUuid`), tests, CLAUDE.md.
- `transcript-source`: `parse-jsonl.ts`, `core/protocol.ts`, tests.
- `conversation-view/pending-turn`: `landed.ts`, `pending.ts`,
  `pending-turn-card.tsx`; `jsonl-viewer/web/components/jsonl-pane.tsx`.
- `conversations/core/endpoints.ts` + `machine/` (interrupt endpoint).
- Delete `jsonl-viewer/plugins/queue-operation`, `jsonl-viewer/plugins/queued-prompt-card`.

## Verification

- `./equin test` on turn-ledger, transcript-source, pending-turn.
- `./equin build`; in my build, launch a conversation, send a message while it
  runs a long Bash: the echo stays last reading `Queued · Send now` while
  tool calls land above it, then becomes the user row when folded in; Send now
  interrupts and the message starts next.
