# turn-ledger

One server-side row per turn sent to an agent, whose verdict comes from the CLI
itself. Design and the CLI experiments behind it:
[`research/2026-10-15-conversations-turn-ledger.md`](../../../../research/2026-10-15-conversations-turn-ledger.md).

It replaces a browser-side guess — "did the CLI accept these exact bytes?",
answered by matching transcript text, only while one view was mounted, against
a 90 s deadline — with facts: the runtime's verdict on the send, the agent's
own confirmation (the sdk runtime's `turn_started` event, which echoes the
turn's ledger id and names the transcript line it became), and Stop. Under the retired tmux runtime that
confirmation was the CLI's `UserPromptSubmit` hook; the ledger's `confirmed`
event is its successor.

## The row — `conversation_turns`

| column | meaning |
|---|---|
| `id` | `turn-<uuid>` (`turnIdKind`), minted by the client so a repeated POST finds the row the first one wrote; the server mints one when a sender has none |
| `kind` | `turn` (a user message), `answer` (an AskUserQuestion answer), `push-and-exit`, `launch` (the prompt the conversation was launched with) |
| `text` | what the user wrote, raw — the draft a returned turn goes back to; what `userTurnSent` carries |
| `typed_text` | exactly what reached the agent: attachment refs resolved, or the whole launch prompt for a held turn that rode the launch |
| `state` | below |
| `submitted_at` | `accepted`: when the agent took it — the event's own time, so a late replay still records the agent's moment |
| `prompt_uuid` | set with `submitted_at`: the uuid of the transcript line the turn became (the SDK user message the agent queued it as) — the turn's identity in the transcript: Stop and rewind return the row by it, and the web's echo retires on it |
| `error` | `failed` (kept by `withdrawn`): why |

## States — one pure function

`transitionTurn(row, event)` (`server/internal/transition.ts`) is the whole
machine, and `applyTurnEvent` (`store.ts`) the only writer: lock the row, ask
the function, write its answer, announce it. `transition.test.ts` writes the
full state × event matrix out, plus the fixed point (an event applied twice
changes nothing) and order independence (the confirmation before or after `typed`).

```
held ─▶ typing ─▶ typed ─▶ accepted ─▶ returned   the agent confirmed THIS row (by id);
  ▲       │         │                              Stop / a rewind took it back
  └─hold──┤         └────▶ returned               a rewind cut it before its confirmation
          └─▶ failed       never reached the agent — Retry
typed ─dropped─▶ failed    the agent went away with it still in its CLI's queue — Retry
failed ─withdraw─▶ withdrawn ─confirmation─▶ accepted
held ─Stop while starting─▶ returned
```

There is no `merged` (a turn is its own SDK user message, so nothing can
submit two as one) and no `unverified` (a verdict only the retired tmux
runtime's input-box check produced). The data migration
`retire_text_matched_turns` moved old rows to `accepted` / `failed`.

- **A confirmation always wins** — over `typing` (it can land inside the
  runtime's own send), `typed`, `failed`, `withdrawn` and `held` (a launch
  that threw after its agent took the prompt put it back; accepting it keeps
  the flush from sending it twice). A settled row (`accepted`, `returned`) is
  a fixed point: a replayed line changes nothing. `CONFIRMABLE` (a Record
  over every state) says which.
- **Never revert.** Once accepted, the send path's own verdicts change nothing;
  only `returned` moves a settled row (the agent really gave it back).
- **No timer anywhere.** A `typed` row waits for its confirmation, or for its
  agent's exit (`dropped`). Every turn gets one — a slash command or a `!`
  line included: the agent confirms whatever its CLI starts.
- `withdraw` (failed → `withdrawn`): the card's Copy to draft — the user takes
  the text back instead of retrying; the error stays, for history. Without it
  a failed row would hold its card until it left the window. A late
  confirmation of it still makes it `accepted` (the truth wins). Stop's
  `returned` ignores confirmations: the agent handed that turn back.
- `returned` from `held`: Stop while the conversation is `starting`
  (`returnHeldTurns`, conversations `stopTurn`) takes every held turn back into
  the draft at once — none reached the agent. Conditional on `held` like the
  `deliver` claim, so a turn the launch is claiming at that moment is either
  taken back whole or delivered whole (then stopped as a running turn).
- `hold` (typing → held): a hibernated conversation the send resumed is
  `starting` again; the turn waits for its input box like any held turn.
  `release` (typing → held): the launch that was to carry it threw.

## Matching the confirmation: by identity

Every turn is sent with its row's id (`ConversationRuntime.send(id, { turnId,
text })`, the launch prompt in the agent's options file likewise), and the agent
echoes it in the `turn_started` it writes when its CLI starts the turn (see
below), with the transcript line's uuid (`promptUuid`).
`confirmTurn(conversationId, turnId, promptUuid, at)` applies the `confirmed`
event to THAT row — no text is compared, so two turns with the same text, a
slash command, a `!` line are all just rows. It returns what it found:
`confirmed`, `settled` (unchanged), `unknown-turn` or `other-conversation` —
the last two the consumer files as a `turn-unknown-id` report; the ledger
never guesses which row was meant.

**Temporary legacy fallback — delete once no agent started before turn ids
runs** (no live `conversations_ext_sdk_agent` row with `turn_ids` false; step A3
of [`research/2026-10-25-conversations-turn-identity-and-fresh-projection.md`](../../../../research/2026-10-25-conversations-turn-identity-and-fresh-projection.md)).
An agent started before turn ids put none on its launch prompt (its options
file held a bare string). Its `turn_started` with `turnId: null` goes to
`resolvePromptSubmit(conversationId, prompt, promptUuid, at)` (the
`confirmed-by-text` event): the oldest unsettled row whose typed text IS the
prompt (`promptIs` — equality, edge whitespace aside; nothing is matched by
containment). The fallback is gated on the agent, not guessed: the sdk
projection's `turnIds` is set by each process's `started` line, so an id-less
turn from an agent that does put ids on its turns is a `turn-without-id`
report, never a text match.

## Where the confirmation comes from

The sdk runtime's event consumer calls `confirmTurn` for each `turn_started`
its agent writes — replayed from its event cursor after a backend restart, so
a confirmation is never lost while the backend is down.

`turn_started` is the CLI **starting** the turn, not the turn being handed to
it: a busy CLI parks a message in its command queue and starts it at the next
tool boundary (folded into the running turn) or the turn's end. The agent
follows that queue through the CLI's `command_lifecycle` messages, keyed by the
SDK user message's uuid (`runtime-sdk/bin/agent.ts`), and only then writes
`turn_started` carrying the row's id and that uuid — so `typed` is exactly
"queued in the agent" (the web's Queued echo), and one identity runs from the
ledger row through the agent's message to the transcript line (`prompt_uuid`).
A CLI reporting no lifecycle confirms at hand-off. When the agent exits — or a new process starts in its
place, which also covers an agent that died without writing `exited` — every
`typed` row sent before is `dropped` (→ `failed`, Retry): its CLI's queue died
with it. Findings:
[`research/2026-10-25-conversations-queued-message-state.md`](../../../../research/2026-10-25-conversations-queued-message-state.md).

## The transcript line a turn becomes

`prompt_uuid` is the uuid the agent gave the SDK user message; what Claude
Code writes under it (measured over 1,141 sdk turns, 2026-10-25):

- a user line with `uuid` = `prompt_uuid` — a slash command included:
  `/compact` writes `<command-name>/compact</command-name>…` under it, then its
  `<local-command-stdout>` line. No `!` turn occurs in the sample (bash mode
  is the interactive REPL's; the agent sends a `!` line as an ordinary SDK user
  message) — unobserved; one that wrote no line would keep its echo (visible,
  never hidden) until the window moved past it;
- for a turn sent while the agent was busy and **folded into the running
  turn** at a tool boundary (`queue-operation remove` — 39 of 1,141), no user
  line at all: a `queued_command` attachment whose `source_uuid` is
  `prompt_uuid`. The transcript parser (`transcript-source`) turns it into the
  user's own message under that uuid;
- for sends queued together and **dequeued as one line** (CLI 2.1.310: two
  `event` turns sent 2 ms apart), one user line under the FIRST send's uuid,
  holding every send's text, with the others' `prompt_uuid`s in its
  `mergedSendUuids` — those sends have no line of their own. The parser
  carries the list on the event (`mergedSendUuids`), and a rewind cutting at
  the line returns every send it holds.

So "the transcript shows this turn" is one uuid lookup over the parsed user
messages — the web's echo retirement (`pending-turn`'s `transcriptShows`).

## Who writes rows

Every sender goes through `submitTurn` (conversations server, `turns.ts`), so
there is no typed turn without a row: the prompt input (`POST …/turn`), Push &
Exit, AskUserQuestion answers, the held-turn flush and the spawn's launch
message. The launch's own prompt is a `launch` row, accepted on the
transaction that commits the conversation (conversations `commitConversation`),
so it is `held` — and echoed — from the moment the conversation exists, and
rides the launch message as the oldest held turn. `acceptTurn` holds a turn while its conversation is `starting` under
the conversation ROW lock — every flip out of `starting` is an UPDATE of that
row, so a turn is held before the flip (and the flush the reconciler enqueues
after its write sees it) or the accept sees the new status. Delivery claims a
held row with the conditional `deliver` transition, so exactly one claimant
wins.

## Status: the confirmed submit is the reconciler's evidence

The status reconciler (conversations server) reads `latestSubmitAt` per
conversation and counts the agent `working` when it confirmed a turn after the
runtime's last status write (`liveStatusFor`): an idle written before the submit
is stale, one written after it (the turn ended, or was interrupted) stands. A
resolved confirmation signals `onStatusEvidence`, which the reconciler subscribes
to, so the status follows the confirmation's arrival. The browser's optimistic status stops at
`accepted` — the server is the one writer of `working` from there.

A **pending** turn is evidence too (`pendingTurnsSince`: a row
`typing` or `typed` — one the agent will start with nobody doing anything
more — with when the oldest entered that state): a live agent holding one is
`working`, never `waiting`. Without it the
status read idle for the seconds a fresh agent's CLI boots with its launch
prompt on its way, and at a turn's end with another queued behind it — and
every reader (a watch going quiet, list_agents) took the agent to be at rest
(research/2026-10-30-conversations-false-idle-at-turn-boundaries.md). A row
entering or leaving those states signals `onStatusEvidence` too. Not `held`:
it waits for a flush that may never come (`held-turn-undelivered`). Each
pending state leaves only by an event, so a dead turn cannot keep an agent
`working`: a new agent process fails every `typed` row of its predecessors
(runtime-sdk's `started` → `turns-dropped`, also when the old one died without
`exited`), and a backend boot fails every `typing` row its previous process
was still sending (`failOrphanedTypingTurns`, the
`turn-ledger.orphaned-typing` warm-up).

A live agent that never starts a turn it holds has no such event: its Claude
Code wedged while alive, and nothing exits or restarts. So the pending turn is
evidence of work only for a bound (`STUCK_TURN_MS`, 5 min, in conversations'
`plan-update.ts`): an agent the runtime says is at rest (no turn, no background
work) that has rested that long holding one is **stuck** — `waiting` with
`waitingFor: "stuck-turn"` (`STUCK_TURN_WAITING_FOR`), so it is not busy (a
watch goes quiet, an automatic turn holds), `list_agents` and the header chip
say Stuck, and a `conversation-stuck-turn` report asks why. The ledger row is
untouched (still no timer here): the turn starting, failing or being dropped
ends it through the same evidence signal.

## Stop and rewind: the turn taken back, by its transcript line

- **Stop** (conversations `stopTurn`): `ConversationRuntime.stop` answers the
  transcript uuid of the turn it took back out of the session (the sdk
  runtime's `lastPromptUuid`), or null when the turn stays (it had a reply).
  `returnTurnByPromptUuid` makes THAT row `returned`, and the draft gets the
  row's own `text` — never text read back from the agent. A uuid no row was
  confirmed as is a ledger hole and throws.
- **Rewind** (conversations `rewindConversationAt`): `returnTurnsSince(
  conversationId, cutMessageAt)` returns every turn sent from the cut on, and
  `returnTurnByPromptUuid` the cut message itself, by the cut line's uuid (its
  row predates its own line, so the time cut alone misses it). A cut at an
  AskUserQuestion answer names a tool result, which no row is. Without it a cut
  turn stayed `accepted` — the agent's newest turn, as far as the ledger knew.

## Events and reports

- `conversation.userTurnSent` (owned here, read by task-title) is emitted when a
  `turn` row is accepted — the moment the agent got it.
- `turn-without-id` / `turn-unknown-id` (runtime-sdk's machine half, which
  learns them): a confirmation that names no row of this conversation.
- `turn-unverified` is **retired** (`machine/internal/report-kinds.ts`):
  nothing files it, it stays registered while old rows remain. The server half
  is `portable: true` (the demo's browser worker serves `turn-ledger.turns`
  over PGlite), so it files no report itself.

## Reading it from the web

`conversationTurns` (`turn-ledger.turns`, core): a window collection filterable
by `conversationId`, newest first (default 20, max 100), carrying
`promptUuid`. Retry is
`retryConversationTurn` (`POST /api/conversations/:id/turns/:turnId/retry`, in
conversations core) for `failed` rows, and Copy to draft is
`withdrawConversationTurn` (`…/withdraw`, → `withdrawn`). The browser's half — the send, the
echo and the cards — is `conversation-view/pending-turn`; its echo retires on
the transcript line named by `promptUuid` (see its CLAUDE.md for which line a
slash command and a turn absorbed by a busy agent become). A 7-day retention
sweep (`server/`, every host) removes settled rows (accepted, returned,
withdrawn).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Registers the turn id kind (turn) with the web id registry — the server barrel registers the same kind. The turn ledger's backend: the conversation_turns table (one row per turn sent to an agent, its state moved only by applyTurnEvent's pure transition), the accept that holds a turn while its conversation starts, confirmTurn (the agent's confirmation that it took a turn, applied to that row by the turn id it echoed, with the transcript line's uuid; resolvePromptSubmit is its temporary equality-matched fallback for an agent started before turn ids), Stop's and rewind's returnTurnByPromptUuid (the turn taken back, by its transcript line), the turn-ledger.turns live collection, the conversation.userTurnSent event (emitted once the agent confirmed a user's turn) and the 7-day retention sweep of settled rows.
- Web:
  - Contributes: `IdKinds.Kind` "turn"
  - Uses: `ids.IdKinds`
- Server:
  - Contributes:
    - `ids.kind` "turn"
    - `resource.declare` "turn-ledger.turns"
    - `resource.declare` "turn-ledger.turns:groups"
    - `resource.declare` "turn-ledger.turns:rows"
    - `report-kind` "turn-unverified"
  - Uses:
    - `database.db`
    - `ids.IdKinds`
    - `infra/entities.defineEntity`
    - `infra/entities.sqlDefault`
    - `infra/events.defineTriggerEvent`
    - `infra/retention.defineRetention`
    - `infra/warmup.defineWarmup`
    - `network/live.serveCollection`
    - `tasks/tasks-core._conversations`
    - `tasks/tasks-core.getConversation`
  - DB schema:
    - `plugins/conversations/plugins/turn-ledger/server/internal/tables-user-turn-sent-event.ts`
    - `plugins/conversations/plugins/turn-ledger/server/internal/tables.ts`
  - Exports (types):
    - `AcceptOutcome`
    - `NewTurn`
    - `TurnEvent`
    - `TurnRow`
    - `UserTurnSentPayload`
  - Exports (values):
    - `acceptTurn`
    - `applyTurnEvent`
    - `confirmTurn`
    - `dropTypedTurns`
    - `getTurn`
    - `hasHeldTurns`
    - `hasTurnInFlight`
    - `holdIfStarting`
    - `latestSubmitAt`
    - `listHeldTurns`
    - `onStatusEvidence`
    - `pendingTurnsSince`
    - `resolvePromptSubmit`
    - `returnHeldTurns`
    - `returnTurnByPromptUuid`
    - `returnTurnsSince`
    - `userTurnSent`
  - Register:
    - `defineTriggerEvent('conversation.userTurnSent')`
    - `defineJob('retention.conversation_turns')`
    - `defineWarmup('turn-ledger.orphaned-typing')`
  - Resources:
    - `turn-ledger.turns` (keyed, window)
    - `turn-ledger.turns:groups` (push)
    - `turn-ledger.turns:rows` (keyed, point)
- Core:
  - Uses:
    - `fields.FieldsRecord`
    - `fields.fieldsToZodObject`
    - `fields.nullable`
    - `fields/date/config.dateField`
    - `fields/text/config.parsedTextField`
    - `fields/text/config.textField`
    - `ids.defineIdKind`
    - `ids.idKindField`
    - `ids.IdOf`
    - `infra/entities.entityRef`
    - `network/live.liveCollection`
  - Exports (types):
    - `LedgerTurn`
    - `TurnId`
    - `TurnKind`
    - `TurnState`
  - Exports (values):
    - `conversationTurns`
    - `LedgerTurnSchema`
    - `ledgerTurnsEntityRef`
    - `RETRYABLE_TURN_STATES`
    - `SETTLED_TURN_STATES`
    - `turnIdKind`
    - `TurnKindSchema`
    - `TurnStateSchema`
    - `typedTextOf`
    - `unwrapEventTurn`
- Cross-plugin:
  - Imported by:
    - `conversations`
    - `conversations/transcript-source`
- Exemptions:
  - Exempts itself from: `ids:pk-declared` — `server/internal/tables-user-turn-sent-event.ts` (debt)

<!-- AUTOGENERATED:END -->
