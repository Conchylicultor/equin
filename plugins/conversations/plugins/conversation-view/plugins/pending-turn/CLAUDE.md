# pending-turn

The **single entry point** for sending a turn from the browser, and the view of
the server's turn ledger. Where a turn stands is the server's business — its
`conversation_turns` row, moved by the send, the agent's own confirmation and
Stop: see [`turn-ledger/CLAUDE.md`](../../../turn-ledger/CLAUDE.md)
and `research/2026-10-15-conversations-turn-ledger.md`. This plugin only
sends, echoes and draws.

## Sending — `useSendConversationTurn()` → `(conversationId, { text, delivery? })`

- **One store per transport** (`transportScoped`, `internal/send.ts`): a turn
  sent inside a demo scope is that scope's server's turn — its echo, its
  in-flight guard and its Retry live beside that scope's ledger, never the
  page's, even under the same conversation id. Every hook reads the subtree's
  store: `useSendConversationTurn`, `useResendTurn`, `useDismissSentTurn`,
  `useSentTurns`, `useTurnSendInFlight`. Each entry keeps the fetcher it was
  sent with (its store's transport), which its delivery receives as
  `send(fetchEndpoint, …)`; the ledger row's Retry / Copy to draft
  (`retryLedgerTurn` / `withdrawLedgerTurn`) take the card's.
- Mints the turn's id (`turnIdKind`) — the id the server writes its ledger row
  under, so a repeated request is the same turn and the live row replaces the
  echo exactly, never by matching text.
- Records the turn in the transport's in-memory store so the echo
  shows at once, then runs the delivery. A failed request leaves the entry
  `unsent`: Retry re-sends the same id, Copy to draft drops it. Once the tab
  holds the turn's live row, the entry is dropped (`useSettleSentTurns`).
- A **delivery** (`TurnDelivery`, `internal/delivery.ts`) is the one thing that
  differs between surfaces: which endpoint carries the turn, and the ledger
  `kind` it makes (`turn` — the default, `POST …/turn`; `push-and-exit`;
  `answer`). It is a plain value the caller passes; nothing outlives the tab
  but the ledger row, whose Retry is the server's.
- `turn-send-safety/no-adhoc-turn-send` (this plugin's `lint/`) makes importing
  a turn endpoint into web code an error outside the delivery modules each
  plugin sanctions in its `exempt/index.ts`: a direct call would type the turn
  with no ledger id (a repeated request types it twice), no echo and no card.
- `useTurnSendInFlight` — a request this tab sent is still open: the
  double-click guard of Push & Close's turn modes.
- **Sending needs the computer.** The turn endpoints (turn, retry, withdraw;
  the answer and Push & Close deliveries too) are `needsMachine`, so a
  delivery under a transport without one would answer `unavailable`.
  `useTurnSendAvailability()` (beside the deliveries, so a composer never names
  a turn endpoint) is what every composer gates on BEFORE a send: disabled,
  with its sentence as the placeholder (prompt input, the agent thread's
  composer, Push & Close). A delivery that reaches an `unavailable` answer
  anyway rejects with it — the send's failure card, never a recorded turn.

## Reading — `usePendingTurns` and `PendingTurnCard`

`usePendingTurns(conversationId, events)` is `useLive(conversationTurns, {
where: { conversationId } })` mapped through `pendingTurnsOf` with the tab's
unsettled sends and the transcript the caller renders (`events`, null while it
loads) — the cards the transcript ends with, oldest first; loading until both
the ledger and the transcript are in. `jsonl-pane` holds the pane on its loader
until then, and shows a ledger read error inline where the cards go.

An `answer` turn draws no card while in flight: its question card draws it as
sent, reading it with `useTurnsInFlight(conversationId, "answer")` (the same
ledger window and tab sends, filtered to the echo states).

| State | Card |
|---|---|
| `sending` (tab only) / `held` / `typing` / `typed` / `accepted` | echo, **until the agent confirmed it and the transcript holds its line** (a user message under the uuid it was confirmed as, or a window beginning after its confirmation) — "Sending…" under it, "Waiting for the agent to start…" when held, and **Queued · Send now** when typed while a turn runs: the agent's CLI holds it until the next tool boundary or the turn's end. Mounted after the transcript, the echo stays last while the agent's steps land above it; Send now interrupts the running turn (`POST /api/conversations/:id/interrupt`), and the CLI starts the queued message next |
| `returned` / `withdrawn` | nothing: the draft has it |
| `failed` / `unsent` (tab only) | Retry + Copy to draft, with the error |

**An echo is the host's own user row, not a look-alike.** `PendingTurnCard`
takes a required `renderEcho(turn, status)`: the host draws the turn with the
component it draws the confirmed turn with (the transcript: a stand-in
`user-text` event through its renderer, in its pinned section header —
`jsonl-viewer`'s `EchoRow`; a thread: its `UserBubble`) and places `status` —
the caption, a highlight sweeping across it — under it. So when the transcript
takes over, the message does not move, re-wrap or change colour; only the
status line goes. Never dim or restyle the echo itself.

**An echo retires on its own transcript line, never on a guess.** The echo
stands in for the message, and the two reach the tab on different channels
(the ledger's change feed, the transcript watcher). `transcriptShows`
(`internal/landed.ts`): the row is `accepted` — the agent confirmed taking this
turn, as transcript line `promptUuid` — **and** either the loaded transcript
holds that line, or the window begins after the row's `submittedAt` (the line
is above what is loaded, so the echo is not on screen in its place either).
The line is a `user-text` event with `uuid === promptUuid` — a slash command's
too (`/compact` writes `<command-name>/compact…` under the turn's uuid), and a
prompt a busy agent folded into its running turn (the CLI writes a
`queued_command` attachment, which the transcript parser makes the user's
message under its `source_uuid`; see turn-ledger's "The transcript line a turn
becomes"), and a send the CLI merged into another's line (sends queued
together are dequeued as ONE line under the first send's uuid; the rest ride
on it as `mergedSendUuids`, which the parser carries on the event). No
"newest event is later" guess: a reply or another turn landing
after the confirmation says nothing about this line. And since the agent
confirms a turn when its CLI **starts** it, not when it queues it, a queued
turn stays an echo (Queued) until its line is due. A turn nothing confirmed
keeps its echo until its row moves (confirmed, failed, returned) — never one
shown nowhere.

**Temporary:** a row accepted before `prompt_uuid` existed has none; it keeps
the old rule (the window's newest event at or after `submittedAt`). Every
confirmation since stamps the uuid and retention sweeps settled rows after 7
days, so this goes a week after the column reached main.

An `answer` draws no in-flight echo (its question card is its in-flight state)
but its failure card like any other. A ledger row's Retry is
`retryConversationTurn`; its Copy to draft is `withdrawConversationTurn`
(→ `withdrawn`) plus the draft write. Every state's card is one exhaustive
Record, `CARD_OF` (`internal/pending.ts`).

## `useTurnAwaitingStart`

Whether a turn waits for a starting agent (`held`, or `typing` / `typed` as
the launch message) — over the same ledger window as the cards. Push & Close's
button reads it to offer **Stop while the conversation is `starting`**: the
server takes the waiting turns back (`returned`), the echo goes, and their
text comes back into the draft; the workspace and the agent keep coming up,
idle, so the user edits the prompt and sends it again.

## `useOptimisticConversationStatus`

`working` only while the server cannot know about a turn yet: this tab's
request is open (or done, its row not here yet), or a row is `typing` /
`typed` awaiting the agent's confirmation — sent since the server's status
last moved (`updatedAt`). From the confirmation on (`accepted`) the server's
status is the one answer: the status reconciler itself reads the confirmed
submit (`submitted_at`) against the agent's own idle/busy write, so every surface — the
header chip, the sidebar dot — shows the same status. It reads the tab's sends
and the ledger's newest rows across all conversations (the default window — one
shared subscription for every row of a list); a failure retracts it.

## Legacy

Until the ledger, this plugin kept a localStorage state machine
(`<browser key prefix>:pending-turns:*`) that guessed delivery by matching the
transcript's text against a 90 s deadline and filed `turn-unconfirmed`
reports. The keys are removed once per page load (`internal/legacy-cleanup.ts`,
this plugin's `register`); the report kind stays registered so old rows still
render (`reports/turn-unconfirmed`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The single entry point for sending a turn from the browser (useSendConversationTurn, bound to the subtree's transport: mints the turn's ledger id, shows its echo at once, then runs its delivery), and the view of the server's turn ledger (conversations/turn-ledger): usePendingTurns merges a conversation's live ledger rows with this tab's sends whose row has not arrived, PendingTurnCard renders each by state (echo while held or being typed until the transcript holds its line, Retry + Copy to draft when it failed), useSentTurnFollowKey is the transcript's followKey (moves only when the user sends a turn, never on an automatic event turn or a retiring echo), and useOptimisticConversationStatus reads a conversation as working from the instant a turn is sent. Every surface (prompt input, template chips, Send/Queue/Go, Push & Close, AskUserQuestion answers) sends through it and differs only in its delivery. Contributes the turn-send-safety lint rule.
- Web:
  - Uses: 25 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `infra/endpoints` ×5
    - `primitives/live-state` ×4
    - `primitives/persistent-draft` ×3
    - `primitives/css/ui-kit` ×2
    - `primitives/networking` ×2
    - `conversations/conversation-view/user-message.UserMessageText`
    - `network/live.useLive`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/working-dots.WorkingText`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/sync-status.useReportSync`
    - `shell/toast.showToast`
    - `ui/icons.Icon`
  - Exports (types):
    - `InFlightTurn`
    - `PendingCard`
    - `PendingTurn`
    - `PendingTurnState`
    - `RenderEcho`
    - `TurnDelivery`
    - `TurnSend`
  - Exports (values):
    - `conversationPromptDraft`
    - `PendingTurnCard`
    - `useOptimisticConversationStatus`
    - `usePendingTurns`
    - `useSendConversationTurn`
    - `useSentTurnFollowKey`
    - `useTurnAwaitingStart`
    - `useTurnRunning`
    - `useTurnSendAvailability`
    - `useTurnSendInFlight`
    - `useTurnsInFlight`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `conversations/agent-thread`
    - `conversations/all-conversations`
    - `conversations/conversation-view/jsonl-viewer`
    - `conversations/conversation-view/jsonl-viewer/tool-call/ask-user-question`
    - `conversations/conversation-view/jsonl-viewer/transcript-stats/context`
    - `conversations/conversation-view/prompt-input`
    - `conversations/conversation-view/prompt-templates`
    - `conversations/conversation-view/push-and-exit`
    - `conversations/conversation-view/status`
    - `conversations/conversations-view/data-view`
    - `tasks/outcome-report`
- Exemptions:
  - Exempts itself from: `turn-send-safety/no-adhoc-turn-send` — `web/internal/delivery.ts` (sanctioned)
  - Exempted by:
    - `conversations/conversation-view/jsonl-viewer/tool-call/ask-user-question` (0 debt)
    - `conversations/conversation-view/pending-turn` (0 debt)
    - `conversations/conversation-view/push-and-exit` (0 debt)

<!-- AUTOGENERATED:END -->
