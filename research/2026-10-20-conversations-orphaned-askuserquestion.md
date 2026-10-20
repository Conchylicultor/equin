# Orphaned AskUserQuestion — answerable as a message

## Context

On the sdk runtime, an AskUserQuestion is answerable only through its **holder**:
the `canUseTool` promise parked in the live agent process. When that process
dies with the question open (the tmux → sdk move, a crash, a reboot, a
hibernate kill), the holder is gone for good — a resumed session never re-asks
a call already in its transcript. The transcript then ends on a `tool_use` with
no result, the hold row is `abandoned`, and the conversation is `waiting` with
`waitingFor: null`.

The question card knew two live cases — *held* (hidden; the `"question"`
pending prompt draws the relay form) and the tmux-era *cancelled* case (the
interrupt-sentinel result, answered via `MarkerAnswerForm`). A no-result call
with no holder matched neither and fell through to the read-only rendering, so
the user saw the question with nothing to click (`conv-1792445817-k9w68e`).

Mental model: wiki *Mental model → Agent Manager → SDK Claude → AskUserQuestion*.

## Design

One pure derivation, `questionState(events, toolCall, conversation)` in
`ask-user-question/web/components/question-state.ts`, returning a closed union
the tool view switches on:

| kind | when | view |
|---|---|---|
| `held` | unresolved, last, `waitingFor === "question"` | `null` — the pending prompt draws the relay form |
| `asking` | unresolved, last, conversation `starting` / `working` (the hold is being registered) | read-only |
| `orphaned` | unresolved, last, nothing after it, no holder, conversation can take a turn (`canSendTurn`) | `MarkerAnswerForm` + a caption saying the answer goes as a message |
| `settled` | answered (record or marker turn), superseded (a later tool call / user message), a non-interrupt result, or a conversation that can take no turn | read-only with whatever answer exists |

"Unresolved" = no result, or the interrupt-sentinel result (the tmux-era flush
— the same orphan, spelled differently). This replaces `isAwaitingAnswer`
(and the unused `findAwaitingAuqEvent`); `findAnswerTurn` stays.

No server change: `MarkerAnswerForm` sends an `answer` ledger turn, and
`submitTurn` routes it through the sdk runtime's `answerPrompt`, which dismisses
any open request (none here) then sends a normal turn. The marker turn then
makes the call `settled` with its picks (`findAnswerTurn` + `parseMarkerAnswer`).

## Files

- `…/ask-user-question/web/components/awaiting.ts` → `question-state.ts` (derivation + `findAnswerTurn`)
- `…/ask-user-question/web/components/awaiting.test.ts` → `question-state.test.ts` (every arm)
- `…/ask-user-question/web/components/ask-user-question-tool-view.tsx` (switch on the union)
- `…/ask-user-question/web/components/change-answers-action.tsx` (import path)
- `…/ask-user-question/web/components/marker-answer-form.tsx` (doc comment)

## Verification

- `./singularity test` on the ask-user-question plugin.
- `./singularity build`, then reproduce an orphan on the worktree: ask an agent
  to call AskUserQuestion, kill its agent process, reopen → the card shows the
  form; answering sends the turn, the agent continues, the card turns answered.
