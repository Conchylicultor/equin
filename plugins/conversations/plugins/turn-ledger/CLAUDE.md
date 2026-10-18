# turn-ledger

One server-side row per turn sent to an agent, whose verdict comes from the CLI
itself. Design and the CLI experiments behind it:
[`research/2026-10-15-conversations-turn-ledger.md`](../../../../research/2026-10-15-conversations-turn-ledger.md).

It replaces a browser-side guess — "did the CLI accept these exact bytes?",
answered by matching transcript text, only while one view was mounted, against
a 90 s deadline — with facts: the runtime's own submit check, the CLI's
`UserPromptSubmit` hook (which carries the exact prompt it submitted, and fires
at Enter even while the agent is busy), and Stop.

## The row — `conversation_turns`

| column | meaning |
|---|---|
| `id` | `turn-<uuid>` (`turnIdKind`), minted by the client so a repeated POST finds the row the first one wrote; the server mints one when a sender has none |
| `kind` | `turn` (a user message), `answer` (an AskUserQuestion answer), `push-and-exit` |
| `text` | what the user wrote, raw — the draft a returned turn goes back to; what `userTurnSent` carries |
| `typed_text` | exactly what reached the CLI: attachment refs resolved, or the whole launch prompt for a held turn that rode the launch. The hook's prompt is compared with this |
| `state` | below |
| `hookless` | no hook will ever confirm it (see below) |
| `submitted_text`, `extra_text` | `merged` only: the hook's whole prompt, and the part that was not this turn |
| `submitted_at` | `accepted` / `merged`: when the CLI submitted it — the mailbox file's mtime, so a late drain still records the CLI's moment |
| `error` | `failed` / `unverified`: why |

## States — one pure function

`transitionTurn(row, event)` (`server/internal/transition.ts`) is the whole
machine, and `applyTurnEvent` (`store.ts`) the only writer: lock the row, ask
the function, write its answer, announce it. `transition.test.ts` writes the
full state × event matrix out, plus the fixed point (an event applied twice
changes nothing) and order independence (hook before or after `typed`).

```
held ─▶ typing ─▶ typed ─▶ accepted     hook prompt == typed text
  ▲       │         ├────▶ merged       hook prompt contains it plus other text
  └─hold──┤         └────▶ returned     Stop rewound it / found back in the box
          ├─▶ failed       never reached the box — Retry
          └─▶ unverified   typed, box never emptied after Enter — Retry
failed / unverified ─withdraw─▶ withdrawn ─exact hook─▶ accepted
```

- **A hook match always wins** — over `typing` (the hook fires inside the
  runtime's own submit wait), `typed`, `unverified`, `failed` and (exactly) a
  `withdrawn` turn.
- **Never revert.** Once accepted or merged, the send path's own verdicts change
  nothing; only `returned` moves a settled row (the CLI really gave it back).
- **No timer anywhere.** A `typed` row of a hooked session waits for its hook.
- `withdraw` (failed / unverified → `withdrawn`): the card's Copy to draft —
  the user takes the text back instead of retrying; the error stays, for
  history. Without it a failed row would hold its card until it left the
  window. A late hook matching it EXACTLY still makes it `accepted` (an
  unverified turn may have landed after all — the truth wins), tried after
  every turn still on its way. Stop's `returned` ignores hooks: a hook for
  that text belongs to whatever turn carries it next. `HOOK_ROLE` (a Record
  over every state) says what a hook may do in each.
- `hold` (typing → held): a hibernated conversation the send resumed is
  `starting` again; the turn waits for its input box like any held turn.
  `release` (typing → held): the launch that was to carry it threw.

### Hookless

A row is `hookless` when nothing will ever confirm it, and its `typed` is then
final and means delivered:

- the text starts with `/` or `!` — the CLI reports neither a slash command nor
  a shell line to `UserPromptSubmit` (finding E8);
- the session was launched without the ledger's hook. Every launch through
  runtime-tmux's `create()` (a resume included) records the conversation in
  `conversation_prompt_hooks`; a session from before the hook existed has no row
  until it is resumed.

## Matching the hook

`resolvePromptSubmit(conversationId, prompt)` takes the rows a hook may still
resolve, oldest first, and tries `promptCandidates`: every **equal** match
first, then every row the prompt **contains** — never a `failed` one, which
never reached the box to be merged. Equality is byte-exact save for edge
whitespace (the launch message reaches the CLI with a space before a leading
`/`). `prompt_id` is no turn id: a busy agent's queued turn carries the running
turn's. Sends are serialized per conversation, so the candidates are few and in
order. A prompt matching nothing — typed in the terminal, a launch's own task
prompt — is not ours and is dropped.

## The mailbox (hook → server, no network)

runtime-tmux merges `promptSubmitHookEntry()` into every launch's
`UserPromptSubmit` hooks. Its command writes the hook's stdin to
`~/.singularity/state/prompt-submits/<namespace>/<conversationId>.<epoch>.<pid>.json`
(through a `.tmp` + rename, so a reader never sees half a file), always exits 0
and prints nothing (a UserPromptSubmit hook's stdout becomes model context). The
namespace is `$SINGULARITY_PARENT_HOST`, the backend that launched the pane, so
each backend watches only its own folder: a worktree's DB fork holds a copy of
main's conversations and must never consume main's files.

`startPromptSubmitMailbox` (this plugin's `onReady`) drains whatever is already
there — files written while no backend ran — then the
`turn-ledger.prompt-submits` watcher drains on every change, one drain at a
time. Each file is matched and deleted; one that does not parse is reported and
deleted. A file whose backend is gone ages out with the data dir's 7-day TTL.

## Who writes rows

Every sender goes through `submitTurn` (conversations server, `turns.ts`), so
there is no typed turn without a row: the prompt input (`POST …/turn`), Push &
Exit, AskUserQuestion answers, the held-turn flush and the spawn's launch
message. `acceptTurn` holds a turn while its conversation is `starting` under
the conversation ROW lock — every flip out of `starting` is an UPDATE of that
row, so a turn is held before the flip (and the flush the reconciler enqueues
after its write sees it) or the accept sees the new status. Delivery claims a
held row with the conditional `deliver` transition, so exactly one claimant
wins.

## Status: the confirmed submit is the reconciler's evidence

The hook fires at Enter, before the CLI writes `busy` to its session file. The
status reconciler (conversations server) reads `latestSubmitAt` per
conversation and counts the agent `working` when the CLI confirmed a submit
after its last status write (`liveStatusFor`): an idle written before the submit
is stale, one written after it (the turn ended, or was interrupted) stands. A
resolved hook signals `onTurnSubmitted`, which the reconciler subscribes to, so
the status follows the hook's arrival. The browser's optimistic status stops at
`accepted` — the server is the one writer of `working` from there.

## Rewind

A rewind cuts turns out of the transcript; `returnTurnsSince(conversationId,
cutMessageAt)` plus `returnTurnByText` for the cut message itself make them
`returned` (conversations `rewindConversationAt`). Without it a cut turn stayed
`accepted` — the agent's newest turn, as far as the ledger knew.

## Events and reports

- `conversation.userTurnSent` (owned here, read by task-title) is emitted when a
  `turn` row is accepted or merged, or reaches `typed` while hookless — the
  moment the agent got it.
- `turn-merged` (with the extra text), `turn-unverified` and
  `turn-input-not-empty` are filed where the fact is learned: the merge by the
  mailbox, the unverified verdict by the transition write, the box that would
  not empty by the send path or Stop. They replace the browser's
  `turn-unconfirmed`.

## Reading it from the web

`conversationTurns` (`turn-ledger.turns`, core): a window collection filterable
by `conversationId`, newest first (default 20, max 100). Retry is
`retryConversationTurn` (`POST /api/conversations/:id/turns/:turnId/retry`, in
conversations core) for `failed` / `unverified` rows, and Copy to draft is
`withdrawConversationTurn` (`…/withdraw`, → `withdrawn`). The browser's half — the send, the
echo and the cards — is `conversation-view/pending-turn`. A 7-day retention sweep
removes settled rows (accepted, merged, returned, withdrawn).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Registers the turn id kind (turn) with the web id registry — the server barrel registers the same kind. The turn ledger's backend: the conversation_turns table (one row per turn sent to an agent, its state moved only by applyTurnEvent's pure transition), the accept that holds a turn while its conversation starts, the prompt-submit mailbox (each agent's UserPromptSubmit hook drops the submitted prompt in a file; a watcher matches it to the oldest unconfirmed turn and deletes it), the turn-ledger.turns live collection, the conversation.userTurnSent event (emitted once the CLI confirmed a user's turn), the turn-merged / turn-unverified / turn-input-not-empty report kinds and a 7-day retention sweep of settled rows.
- Web:
  - Contributes: `IdKinds.Kind` "turn"
  - Uses: `ids.IdKinds`
- Server:
  - Contributes:
    - `ids.kind` "turn"
    - `resource.declare` "turn-ledger.turns"
    - `resource.declare` "turn-ledger.turns:groups"
    - `resource.declare` "turn-ledger.turns:rows"
    - `report-kind` "turn-input-not-empty"
    - `report-kind` "turn-merged"
    - `report-kind` "turn-unverified"
  - Uses:
    - `database.db`
    - `ids.IdKinds`
    - `infra/entities.defineEntity`
    - `infra/entities.sqlDefault`
    - `infra/events.defineTriggerEvent`
    - `infra/file-watcher.defineFileWatcher`
    - `infra/file-watcher.FileWatcher`
    - `infra/retention.defineRetention`
    - `network/live.serveCollection`
    - `reports.recordReport`
    - `reports.ReportKind`
    - `reports.ReportRow`
    - `tasks/tasks-core._conversations`
    - `tasks/tasks-core.getConversation`
  - DB schema:
    - `plugins/conversations/plugins/turn-ledger/server/internal/tables-user-turn-sent-event.ts`
    - `plugins/conversations/plugins/turn-ledger/server/internal/tables.ts`
  - Exports (types):
    - `AcceptOutcome`
    - `NewTurn`
    - `PromptSubmitHookEntry`
    - `TurnEvent`
    - `TurnRow`
    - `UserTurnSentPayload`
  - Exports (values):
    - `acceptTurn`
    - `applyTurnEvent`
    - `getTurn`
    - `hasHeldTurns`
    - `hasPromptHook`
    - `holdIfStarting`
    - `latestSubmitAt`
    - `listHeldTurns`
    - `onTurnSubmitted`
    - `promptSubmitHookEntry`
    - `recordPromptHookLaunch`
    - `reportInputNotEmpty`
    - `returnTurnByText`
    - `returnTurnsSince`
    - `userTurnSent`
  - Register:
    - `defineFileWatcher('turn-ledger.prompt-submits')`
    - `defineJob('retention.conversation_turns')`
    - `defineTriggerEvent('conversation.userTurnSent')`
  - Resources:
    - `turn-ledger.turns` (keyed, window)
    - `turn-ledger.turns:groups` (push)
    - `turn-ledger.turns:rows` (keyed, point)
- Core:
  - Uses:
    - `fields.FieldsRecord`
    - `fields.fieldsToZodObject`
    - `fields.nullable`
    - `fields/bool/config.boolField`
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
  - Imported by:
    - `conversations`
    - `conversations/runtime-tmux`
    - `tasks/task-title`
- Exemptions:
  - Exempts itself from:
    - `ids:pk-declared` — `server/internal/tables-user-turn-sent-event.ts` (debt)
    - `boundaries/no-platform-api` — `server/internal/mailbox.ts` (debt)

<!-- AUTOGENERATED:END -->
