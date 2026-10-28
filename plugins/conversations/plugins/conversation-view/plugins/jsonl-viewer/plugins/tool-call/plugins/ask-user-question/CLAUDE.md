# ask-user-question

Renderer for `AskUserQuestion` tool calls in the JSONL viewer.

Collapsed: blue header badge(s) showing each question's `header` field, plus the first question's text truncated.
Expanded: for each question, shows the full question text and a vertical option list. An "Other" row appears if the answer doesn't match any predefined option label.

## Where a question stands — `questionState`

One pure derivation (`web/components/question-state.ts`) from the transcript
plus the conversation row decides what the card draws. A question is answerable
as the tool's real result only through its **holder** — the agent process's
parked `canUseTool` — which lives in that process's memory alone: a process
that dies with the question open takes it along, and a resumed session never
re-asks a call already in its transcript.

- **held** — a live holder waits (`waitingFor: "question"`): the card renders
  nothing; `conversations/question-relay` owns the `"question"` pending prompt
  and composes this plugin's `QuestionCard` + `AnswerForm` (presentational: it
  hands structured selections to `onSubmit`). The answer becomes a real
  `Your questions have been answered: …` result, read back from the line's
  structured `toolUseResult` (`result.questionAnswer`, `answersFromRecord`) —
  never from the result's prose, whose wording the CLI changes across versions.
- **asking** — the agent is mid-turn and the hold is not registered yet (or
  let go, the result not written yet): read-only — or, when this tab sent the
  answer, that answer with "Sending…" under it (see below).
- **orphaned** — unresolved (no result, the result the CLI fills in on resume
  after a restart killed the session mid-question — `outcomeUnknown` — or the
  tmux-era interrupt sentinel),
  the latest thing in the transcript, nothing holds it, and the conversation
  can take a turn: `MarkerAnswerForm` sends the answer as an
  `Answering your questions:` turn. The marker / interrupt `EventFilter`s,
  `findAnswerTurn` and *Change answers* serve this path.
- **settled** — answered, superseded, failed, or a conversation that can take
  no turn: read-only.

## A sent answer shows at once — `sent-answers`

Submitting a held question must not make it vanish: the relay row leaves its
collection at once and the transcript card stays out while the call is held,
so the question used to disappear until the CLI wrote the result. Whoever
sends the answer calls `recordSentAnswer(toolUseId, { questions, answer })`
(an in-memory per-tab store); both surfaces then draw it with the same
`AnsweredQuestions` body the settled card uses, plus `SendingStatus` under it
— the `"question"` pending prompt through `SentAnswerCard` while the call is
held, then the transcript card in **asking** — so when the result lands only
the "Sending…" line goes (the user-message echo contract,
`conversation-view/pending-turn`). The transcript card drops the entry once
the call has a result; a failed send drops it, bringing the form back with the
draft.

The **marker path** (an orphaned question, answered as a turn) keeps no copy:
its answer is a ledger turn of kind `answer`, which draws no echo of its own,
and the card reads it back with pending-turn's `useTurnsInFlight` —
`markerAnswerInFlight` picks the one on its way to this question (orphaned:
not yet confirmed by the agent, since a confirmed row stays `accepted` for good
— e.g. one from before a *Change answers* rewind; asking: sent after the
call). It is drawn from the parsed turn text, "Sending…" under it, until
`findAnswerTurn` sees it in the transcript; a failed send stops counting, the
pending-turn failure card offering Retry.

## `OptionRow` owns the selected look — for both states of the card

The awaiting (`AnswerForm`) and answered (`AskUserQuestionToolView`) branches
render the *same* option list, so both go through `OptionRow` / `OptionBody`
(`web/components/option-row.tsx`). They previously carried two hand-maintained
copies of the markup, which is how they drifted. Don't reintroduce a second copy —
add a prop.

Selection is signalled on exactly **two** channels: the radio/checkbox indicator
(semantics) and the container outline (scannability). Three rules keep it honest:

- **Geometry is reserved in both states.** An unselected row is `border-transparent`,
  never border-less, and padding is identical either way — so picking an option
  changes colour only. The old code swapped `pl-2xs` ↔ `pl-sm`, which made the whole
  list jitter horizontally as the user arrowed through it.
- **No left-edge accent bar.** A left bar reads as "this line belongs to a thread"
  (blockquote, active nav item), not "you chose this". Options here are card-shaped
  (label + description + optional preview) and want full-box containment.
- **Hover and selected are separate channels** (muted fill vs primary ring), so
  hovering an already-selected row never reads as "about to deselect".

## The reply is the user's own rich text

"Add a comment" opens the prompt's own `TextEditor` (Enter submits, Shift+Enter
breaks the line): paste or drop an image or file, chips render as in a turn.
Its markdown travels as the reply; the server resolves its attachment refs to
disk paths the agent can open, and links them to the conversation, exactly as
a turn's (`resolvePromptAttachments`, conversations/server) — on both paths,
the held answer (question-relay) and the marker turn.

The answered card draws the reply — and a question's note — as one more row of
the list (`WrittenRow`: its icon in the indicator column, like the form's
comment field), never as a left-barred callout, which reads as quoted or
agent-authored. The text goes through `AttachmentText` (paste-images) after
`attachmentRefsOf` (conversations/core) turns the disk paths the agent was
handed back into attachment refs, so it shows the thumbnails the user pasted,
before and after the transcript confirms it; *Change answers* restores the
reply the same way.

## Changing an answer

An answered card carries a **Change answers** row action — the same small
history glyph and menu as the rewind on the user's own messages, revealed on
hover in the card header, never a button in the card body. It goes back to just before the answer
was sent — in this conversation (the agent forgets everything since) or in a
fork — and the question's form reopens with the previous answer filled in.

It reuses the rewind plugin's `useGoBackToMessage`, cutting at the answer —
wherever it lives:

- **The tool's real result** (answered through the held form, or in the
  terminal): the result line, whose uuid the parser stamps on the call's result
  as `answerUuid` (`questionAnswerText`, `transcript-source/core` — the same
  predicate the cut accepts). `restoreAnswerDraftFromRecord` refills the form
  from the structured record, reply included.
- **An answer turn** (the marker path, sent after the agent stopped asking):
  hidden from the transcript by this plugin's EventFilter, so the transcript's
  own per-message rewind button never appears for it. `restoreAnswerDraft`
  refills the form from the parsed text, reply included.

Because the answer turn is hidden, the card is the only place its text shows:
`parseMarkerAnswer` is the full inverse of `serializeMarkerAnswer` — the
answer lines *and* the free-text reply paragraph after them — so the card draws
the reply in its Reply callout, exactly as for an answer given as the result.

After the cut the question is orphaned again (the latest call, unresolved —
the transcript now ends on the call, which the CLI fills in as
`outcomeUnknown` on resume, exactly as after a restart mid-question), so the
ordinary `MarkerAnswerForm` renders with the old answer already in its draft.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Renders AskUserQuestion tool calls with question headers, option lists, and answer highlights.
- Web:
  - Contributes:
    - `JsonlViewerTool.Renderer` "AskUserQuestion" → `AskUserQuestionToolView`
    - `JsonlRowActions.Item` "change-answers" → `ChangeAnswersAction`
    - `JsonlViewer.EventFilter` "ask-user-question:suppress-answer-turn"
    - `JsonlViewer.EventFilter` "ask-user-question:suppress-interrupt-turn"
  - Uses: 38 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×8
    - `primitives/persistent-draft` ×4
    - `conversations/conversation-view/jsonl-viewer/tool-call` ×3
    - `conversations/conversation-view/jsonl-viewer/row-actions` ×2
    - `conversations/conversation-view/jsonl-viewer` ×2
    - `conversations/conversation-view/pending-turn` ×2
    - `primitives/css/selection-indicator` ×2
    - `conversations/conversation-view/rewind.useGoBackToMessage`
    - `conversations/conversation-view.conversationPane`
    - `conversations.useConversation`
    - `infra/endpoints.useMachineAvailability`
    - `primitives/css/badge.Badge`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/working-dots.WorkingText`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/text-editor/paste-images.AttachmentText`
    - `primitives/text-editor.TextEditor`
    - `ui/icons.Icon`
  - Exports (types):
    - `AnswerSelections`
    - `FormAnswer`
    - `Question`
    - `QuestionSelection`
    - `SentAnswer`
  - Exports (values):
    - `answerDraftScope`
    - `AnswerForm`
    - `dropSentAnswer`
    - `QuestionCard`
    - `recordSentAnswer`
    - `SentAnswerCard`
    - `useSentAnswer`
- Machine:
  - Uses: `infra/endpoints.implementMachine`
  - Routes: `POST /api/conversations/:id/answer-question`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --info`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/font-family --font-mono`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-scale`
    - `ui/tokens/type-scale --font-size-3xs`
    - `ui/tokens/type-scale --font-weight-medium`
    - `ui/tokens/type-scale --line-height-3xs`
  - Imported by: `conversations/question-relay`
- Exemptions:
  - Exempts itself from: `turn-send-safety/no-adhoc-turn-send` — `web/internal/delivery.ts` (sanctioned)
- Shared:
  - Exports (values):
    - `ANSWER_MARKER`
    - `answerAskUserQuestion`
    - `AnswerAskUserQuestionBodySchema`

<!-- AUTOGENERATED:END -->
