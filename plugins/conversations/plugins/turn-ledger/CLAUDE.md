# turn-ledger

One server-side row per turn sent to an agent, whose verdict comes from the CLI
itself. Design and the CLI experiments behind it:
[`research/2026-10-15-conversations-turn-ledger.md`](../../../../research/2026-10-15-conversations-turn-ledger.md).

It replaces a browser-side guess — "did the CLI accept these exact bytes?",
answered by matching transcript text, only while one view was mounted, against
a 90 s deadline — with facts: the runtime's verdict on the send, the agent's
own confirmation (the sdk runtime's `turn_started` event, which carries the
exact prompt it took), and Stop. Under the retired tmux runtime that
confirmation was the CLI's `UserPromptSubmit` hook; the ledger's `confirmed`
event is its successor.

## The row — `conversation_turns`

| column | meaning |
|---|---|
| `id` | `turn-<uuid>` (`turnIdKind`), minted by the client so a repeated POST finds the row the first one wrote; the server mints one when a sender has none |
| `kind` | `turn` (a user message), `answer` (an AskUserQuestion answer), `push-and-exit`, `launch` (the prompt the conversation was launched with) |
| `text` | what the user wrote, raw — the draft a returned turn goes back to; what `userTurnSent` carries |
| `typed_text` | exactly what reached the CLI: attachment refs resolved, or the whole launch prompt for a held turn that rode the launch. The confirmed prompt is compared with this |
| `state` | below |
| `submitted_text`, `extra_text` | `merged` only: the confirmed whole prompt, and the part that was not this turn |
| `submitted_at` | `accepted` / `merged`: when the agent took it — the event's own time, so a late replay still records the agent's moment |
| `error` | `failed` / `unverified`: why |

## States — one pure function

`transitionTurn(row, event)` (`server/internal/transition.ts`) is the whole
machine, and `applyTurnEvent` (`store.ts`) the only writer: lock the row, ask
the function, write its answer, announce it. `transition.test.ts` writes the
full state × event matrix out, plus the fixed point (an event applied twice
changes nothing) and order independence (the confirmation before or after `typed`).

```
held ─▶ typing ─▶ typed ─▶ accepted     confirmed prompt == typed text
  ▲       │         ├────▶ merged       confirmed prompt contains it plus other text
  └─hold──┤         └────▶ returned     Stop rewound it
          ├─▶ failed       never reached the agent — Retry
          └─▶ unverified   the runtime cannot tell whether it went in — Retry
failed / unverified ─withdraw─▶ withdrawn ─exact confirmation─▶ accepted
held ─Stop while starting─▶ returned
```

- **A confirmation always wins** — over `typing` (it can land inside the
  runtime's own send), `typed`, `unverified`, `failed` and (exactly) a
  `withdrawn` turn.
- **Never revert.** Once accepted or merged, the send path's own verdicts change
  nothing; only `returned` moves a settled row (the CLI really gave it back).
- **No timer anywhere.** A `typed` row waits for its confirmation. Every turn
  gets one — a slash command or a `!` line included: the agent confirms
  whatever it takes off its input queue.
- `withdraw` (failed / unverified → `withdrawn`): the card's Copy to draft —
  the user takes the text back instead of retrying; the error stays, for
  history. Without it a failed row would hold its card until it left the
  window. A late confirmation matching it EXACTLY still makes it `accepted`
  (an unverified turn may have landed after all — the truth wins), tried after
  every turn still on its way. Stop's `returned` ignores confirmations: one of
  that text belongs to whatever turn carries it next. `CONFIRM_ROLE` (a Record
  over every state) says what a confirmation may do in each.
- `returned` from `held`: Stop while the conversation is `starting`
  (`returnHeldTurns`, conversations `stopTurn`) takes every held turn back into
  the draft at once — none reached the agent. Conditional on `held` like the
  `deliver` claim, so a turn the launch is claiming at that moment is either
  taken back whole or delivered whole (then stopped as a running turn).
- `hold` (typing → held): a hibernated conversation the send resumed is
  `starting` again; the turn waits for its input box like any held turn.
  `release` (typing → held): the launch that was to carry it threw.

## Matching the confirmation

`resolvePromptSubmit(conversationId, prompt)` takes the rows a confirmation may still
resolve, oldest first, and tries `promptCandidates`: every **equal** match
first, then every row the prompt **contains** — never a `failed` one, which
never reached the box to be merged. Equality is byte-exact save for edge
whitespace (the launch message reaches the CLI with a space before a leading
`/`). `prompt_id` is no turn id: a busy agent's queued turn carries the running
turn's. Sends are serialized per conversation, so the candidates are few and in
order. A prompt matching nothing — typed in the terminal — is not ours and is
dropped.

## Where the confirmation comes from

The sdk runtime's event consumer calls `resolvePromptSubmit(conversationId,
prompt, at)` for each `turn_started` its agent writes — replayed from its event
cursor after a backend restart, so a confirmation is never lost while the
backend is down.

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
resolved confirmation signals `onTurnSubmitted`, which the reconciler subscribes
to, so the status follows the confirmation's arrival. The browser's optimistic status stops at
`accepted` — the server is the one writer of `working` from there.

## Rewind

A rewind cuts turns out of the transcript; `returnTurnsSince(conversationId,
cutMessageAt)` plus `returnTurnByText` for the cut message itself make them
`returned` (conversations `rewindConversationAt`). Without it a cut turn stayed
`accepted` — the agent's newest turn, as far as the ledger knew.

## Events and reports

- `conversation.userTurnSent` (owned here, read by task-title) is emitted when a
  `turn` row is accepted or merged — the moment the agent got it.
- `turn-merged` (with the extra text) and `turn-unverified` are filed where the
  fact is learned: the merge by the confirmation, the unverified verdict by the
  transition write. They replace the browser's `turn-unconfirmed`. The store
  announces both on `turnVerdictSink` (`server/internal/verdict-sink.ts`), and
  `machine/` maps it to `recordReport`: the reports engine is not portable, and
  the server half runs on every host (it is `portable: true`, so the demo's
  browser worker serves `turn-ledger.turns` over PGlite).

## Reading it from the web

`conversationTurns` (`turn-ledger.turns`, core): a window collection filterable
by `conversationId`, newest first (default 20, max 100). Retry is
`retryConversationTurn` (`POST /api/conversations/:id/turns/:turnId/retry`, in
conversations core) for `failed` / `unverified` rows, and Copy to draft is
`withdrawConversationTurn` (`…/withdraw`, → `withdrawn`). The browser's half — the send, the
echo and the cards — is `conversation-view/pending-turn`. A 7-day retention sweep
(`machine/`, desktop only) removes settled rows (accepted, merged, returned,
withdrawn).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Registers the turn id kind (turn) with the web id registry — the server barrel registers the same kind. The turn ledger's backend: the conversation_turns table (one row per turn sent to an agent, its state moved only by applyTurnEvent's pure transition), the accept that holds a turn while its conversation starts, resolvePromptSubmit (the agent's confirmation that it took a turn, matched to the oldest unconfirmed one), the turn-ledger.turns live collection, the conversation.userTurnSent event (emitted once the agent confirmed a user's turn) and turnVerdictSink (a merged or unverified turn, filed as a report by machine/).
- Web:
  - Contributes: `IdKinds.Kind` "turn"
  - Uses: `ids.IdKinds`
- Server:
  - Contributes:
    - `ids.kind` "turn"
    - `resource.declare` "turn-ledger.turns"
    - `resource.declare` "turn-ledger.turns:groups"
    - `resource.declare` "turn-ledger.turns:rows"
    - `report-kind` "turn-merged"
    - `report-kind` "turn-unverified"
  - Uses:
    - `database.db`
    - `ids.IdKinds`
    - `infra/entities.defineEntity`
    - `infra/entities.sqlDefault`
    - `infra/events.defineTriggerEvent`
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
    - `getTurn`
    - `hasHeldTurns`
    - `hasTurnInFlight`
    - `holdIfStarting`
    - `latestSubmitAt`
    - `listHeldTurns`
    - `onTurnSubmitted`
    - `resolvePromptSubmit`
    - `returnHeldTurns`
    - `returnTurnByText`
    - `returnTurnsSince`
    - `userTurnSent`
  - Register: `defineTriggerEvent('conversation.userTurnSent')`
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
    - `RETRYABLE_TURN_STATES`
    - `SETTLED_TURN_STATES`
    - `turnIdKind`
    - `TurnKindSchema`
    - `TurnStateSchema`
- Cross-plugin:
  - Imported by: `conversations`
- Exemptions:
  - Exempts itself from: `ids:pk-declared` — `server/internal/tables-user-turn-sent-event.ts` (debt)
- Machine:
  - Register: `defineJob('retention.conversation_turns')`

<!-- AUTOGENERATED:END -->
