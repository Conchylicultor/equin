# One activity indicator while a conversation starts

## Context

Since commit 1423abc084, a launch's prompt is a held turn-ledger row (kind `launch`), so a new
conversation opens with the user's message echoed. The screenshot confirms the pane then draws
**three** activity signals while the agent starts:

1. `WorkingIndicator` ("Working for 0:10" + dots) — `jsonl-pane.tsx` renders it whenever
   `isWorking && !isStarting`, and `isStarting` is false as soon as any pending card exists.
2. The echo card itself, captioned **"Sending…"** — not "Waiting for the agent to start…":
   `launchWithHeldTurn` (`conversations/server/internal/turns.ts`) moves the row `held → typing`
   *before* the spawn, so during the seconds the agent takes to come up, the row is `typing`
   and `ECHO_CAPTION` falls back to "Sending…".
3. The echo card's own `BouncingDots` row under it (`pending-turn-card.tsx`).

The same happens for a message sent to a conversation still `starting`, and (dots ×2) for a
message queued behind a working agent.

Expected: one indicator that says the agent is starting, and the message reads as waiting for it.

## Design

**The card is the message; the host owns the activity.** An echo card stops drawing dots. The
transcript's foot carries the single activity line, which names what the agent is doing.

### 1. `pending-turn` — the echo card

- `PendingTurnCard`: drop the `BouncingDots` row from the echo branch.
- New required prop `agentStarting: boolean` (required, so every host must decide — tsc). While
  true, every echo reads **"Waiting for the agent to start…"** whatever its state (`sending`,
  `held`, `typing`, `typed`), because that is what it is waiting on. Otherwise the existing
  `ECHO_CAPTION` mapping.
- Add `card: PendingCard` to `PendingTurn` (filled from `CARD_OF` in `pendingTurnsOf`), so a
  host can tell "an echo stands" without importing the internal `CARD_OF`. Export the
  `PendingCard` type.

### 2. `jsonl-viewer` — `JsonlPane`'s foot indicator

Replace `WorkingIndicator` with one `TranscriptActivity` line, rendered **after** the pending
cards (the foot of the transcript, where the card's dots used to sit):

| conversation | label |
|---|---|
| `starting` | dots · "Starting the agent" · elapsed |
| `working` | dots · "Working for <elapsed>" (today's) |
| otherwise, an echo stands (idle agent, message on its way) | dots only (today's card dots) |
| otherwise | nothing |

- Still suppressed in the empty starting state (`isStarting` → centred `StartingTranscript`,
  unchanged).
- Elapsed uses the existing `workingStartAt` snapshot.
- Pass `agentStarting={conversation.status === "starting"}` to each `PendingTurnCard`.

Result on launch: echo "Hi / Waiting for the agent to start…", then one line
"● ● ● Starting the agent 0:10". Once the agent is up it becomes "Working for …".

### 3. `agent-thread` — the other host of `PendingTurnCard`

It has no foot indicator; the card's dots were its only signal while starting (its `trailing`
fragment is never null, so the empty-state dots never show). Render a `BouncingDots` line after
its pending cards when an echo stands (`turn.card === "echo"`) and the newest turn is not
`running` (a running turn already draws its own thinking dots). Pass
`agentStarting={status === "starting"}`.

## Files

- `plugins/conversations/plugins/conversation-view/plugins/pending-turn/web/components/pending-turn-card.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/pending-turn/web/internal/pending.ts` (+ `web/index.ts` type export)
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx`
- `plugins/conversations/plugins/agent-thread/web/components/agent-thread.tsx`
- Tests: `pending-turn/web/__tests__/pending-turn-card.test.tsx` (no dots in the card; any echo
  reads "Waiting for the agent to start…" when `agentStarting`), `pending-turns.test.tsx`
  (`card` field).

No server change: the ledger states stay as they are; the caption reads the conversation's
status, which is the authority on "starting".

## Verification

1. `./singularity test plugins/conversations/plugins/conversation-view/plugins/pending-turn plugins/conversations/plugins/agent-thread`
2. `./singularity build`, then with `browser_*`: launch a conversation from the home prompt on
   the worktree build and screenshot during the start — exactly one dots line, labelled
   "Starting the agent", echo captioned "Waiting for the agent to start…"; then it turns into
   "Working for …" and the echo retires.
3. Send a message to a working agent: one "Working for" line at the foot, echo "Waiting for the
   agent to take it…" without its own dots.
