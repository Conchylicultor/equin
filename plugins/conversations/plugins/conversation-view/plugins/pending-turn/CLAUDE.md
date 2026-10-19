# pending-turn

The **single entry point** for sending a turn from the browser, and the view of
the server's turn ledger. Where a turn stands is the server's business — its
`conversation_turns` row, moved by the CLI's own submit hook, Stop and the
runtime's submit check: see [`turn-ledger/CLAUDE.md`](../../../turn-ledger/CLAUDE.md)
and `research/2026-10-15-conversations-turn-ledger.md`. This plugin only
sends, echoes and draws.

## Sending — `sendConversationTurn(conversationId, { text, delivery? })`

- Mints the turn's id (`turnIdKind`) — the id the server writes its ledger row
  under, so a repeated request is the same turn and the live row replaces the
  echo exactly, never by matching text.
- Records the turn in a per-tab in-memory store (`internal/send.ts`) so the echo
  shows at once, then runs the delivery. A failed request leaves the entry
  `unsent`: Retry re-sends the same id, Copy to draft drops it. Once the tab
  holds the turn's live row, the entry is dropped (`settleSentTurns`).
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

## Reading — `usePendingTurns` and `PendingTurnCard`

`usePendingTurns(conversationId, events)` is `useLive(conversationTurns, {
where: { conversationId } })` mapped through `pendingTurnsOf` with the tab's
unsettled sends and the transcript the caller renders (`events`, null while it
loads) — the cards the transcript ends with, oldest first; loading until both
the ledger and the transcript are in. `jsonl-pane` holds the pane on its loader
until then, and shows a ledger read error inline where the cards go.

| State | Card |
|---|---|
| `sending` (tab only) / `held` / `typing` / `typed` / `accepted` | dimmed echo, **until the transcript shows the turn** — "Waiting for the agent to start…" when held |
| `typed` + `hookless` | nothing: the box took a slash command / `!` line, and nothing will say more |
| `returned` / `withdrawn` | nothing: the draft has it |
| `merged` | warning naming the other text (`extraText`) — only while it is the newest turn |
| `failed` / `unverified` / `unsent` (tab only) | Retry + Copy to draft, with the error |

**The transcript retires the echo, never the ledger.** The echo stands in for
the message, and the two reach the tab on different channels (the ledger's
change feed, the transcript watcher): retiring it on the ledger's `typed` left
the turn on screen nowhere for as long as the transcript lagged.
`landedTurnIds` (`internal/landed.ts`) joins them causally and ordinally — a
turn's transcript entry (its user row, or a busy agent's enqueue) is written
after its ledger row's `createdAt`, and sends are serialized, so the k-th turn
on its way is the k-th prompt landing after the oldest. There is no shared id
for a queued turn (see the file). Ambiguity errs toward retiring one landing
early, never toward an echo held forever.

An `answer` draws no in-flight echo (its question card is its in-flight state)
but its failure card like any other. A ledger row's Retry is
`retryConversationTurn`; its Copy to draft is `withdrawConversationTurn`
(→ `withdrawn`) plus the draft write. Every state's card is one exhaustive
Record, `CARD_OF` (`internal/pending.ts`).

## `useOptimisticConversationStatus`

`working` only while the server cannot know about a turn yet: this tab's
request is open (or done, its row not here yet), or a hooked row is `typing` /
`typed` awaiting the CLI's hook — sent since the server's status last moved
(`updatedAt`). From the hook on (`accepted` / `merged`) the server's status is
the one answer: the status reconciler itself reads the confirmed submit
(`submitted_at`) against the CLI's own idle/busy write, so every surface — the
header chip, the sidebar dot — shows the same status. It reads the tab's sends
and the ledger's newest rows across all conversations (the default window — one
shared subscription for every row of a list); a failure retracts it.

## Legacy

Until the ledger, this plugin kept a localStorage state machine
(`singularity:pending-turns:*`) that guessed delivery by matching the
transcript's text against a 90 s deadline and filed `turn-unconfirmed`
reports. The keys are removed once per page load (`internal/legacy-cleanup.ts`,
this plugin's `register`); the report kind stays registered so old rows still
render (`reports/turn-unconfirmed`).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The single entry point for sending a turn from the browser (sendConversationTurn: mints the turn's ledger id, shows its echo at once, then runs its delivery), and the view of the server's turn ledger (conversations/turn-ledger): usePendingTurns merges a conversation's live ledger rows with this tab's sends whose row has not arrived, PendingTurnCard renders each by state (echo while held or being typed, a warning when the CLI merged it with leftover text, Retry + Copy to draft when it failed), and useOptimisticConversationStatus reads a conversation as working from the instant a turn is sent. Every surface (prompt input, template chips, Send/Queue/Go, Push & Close, AskUserQuestion answers) calls sendConversationTurn and differs only in its delivery. Contributes the turn-send-safety lint rule.
- Web:
  - Uses:
    - `conversations/conversation-view/user-message.UserMessageCard`
    - `conversations/conversation-view/user-message.UserMessageText`
    - `infra/endpoints.fetchEndpoint`
    - `infra/endpoints.getEndpointErrorMessage`
    - `network/live.useLive`
    - `primitives/css/bouncing-dots.BouncingDots`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.Button`
    - `primitives/css/ui-kit.cn`
    - `primitives/live-state.foldResource`
    - `primitives/live-state.mapResource`
    - `primitives/live-state.ResourceResult`
    - `primitives/live-state.useCombinedResources`
    - `primitives/persistent-draft.writeDraft`
    - `primitives/sync-status.useReportSync`
    - `shell/toast.showToast`
  - Exports (types):
    - `PendingTurn`
    - `PendingTurnState`
    - `TurnDelivery`
    - `TurnSend`
  - Exports (values):
    - `PendingTurnCard`
    - `sendConversationTurn`
    - `useOptimisticConversationStatus`
    - `usePendingTurns`
    - `useTurnSendInFlight`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `conversations/agent-thread`
    - `conversations/all-conversations`
    - `conversations/conversation-view/jsonl-viewer`
    - `conversations/conversation-view/jsonl-viewer/tool-call/ask-user-question`
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
