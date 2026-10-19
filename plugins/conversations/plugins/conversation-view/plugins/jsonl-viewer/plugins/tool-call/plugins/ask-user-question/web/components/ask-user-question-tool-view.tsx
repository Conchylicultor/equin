import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { jsonlEvents } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import { isInterruptContent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { useConversation } from "@plugins/conversations/web";
import { QUESTION_WAITING_FOR } from "@plugins/conversations/core";
import { MarkerAnswerForm } from "./marker-answer-form";
import { OptionBody, OptionRow } from "./option-row";
import { summaryFor } from "./question-card";
import { findAnswerTurn, isAwaitingAnswer } from "./awaiting";
import {
  answersFromRecord,
  parseMarkerAnswer,
  parseSelectedLabels,
  type AskUserQuestionInput,
  type ParsedAnswer,
} from "./answer-model";

export function AskUserQuestionToolView({ event }: ToolRendererProps) {
  const input = event.input as AskUserQuestionInput;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; input is `as`-cast from unknown
  const questions = Array.isArray(input?.questions) ? input.questions : [];

  const { convId } = conversationPane.useParams();
  const eventsResult = useLive(jsonlEvents, { id: convId });
  const conversation = useConversation(convId);

  if (eventsResult.status === "loading" || conversation.status === "loading")
    return null;
  if (eventsResult.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the question's answer state"
        error={eventsResult.error}
        refetch={eventsResult.refetch}
      />
    );

  const events = eventsResult.data;
  const lastToolCall = events.findLast((e) => e.kind === "tool-call");

  // State machine derived from the JSONL event stream alone (no `waitingFor`).
  // When answered from the web, the tool is cancelled first, so its result is
  // the interrupt sentinel (not the answer); the real answer arrives later as a
  // separate `Answering your questions:` user turn.
  const resultIsInterrupt =
    event.result != null &&
    event.result.isError === true &&
    isInterruptContent(event.result.content);
  // The interrupt/rejection result is the cancel-to-flush answer mechanism, not a
  // failure — only style the card as an error for a genuine (non-interrupt) error.
  const showAsError = !resultIsInterrupt && (event.result?.isError ?? false);
  const isLastToolCall =
    lastToolCall?.kind === "tool-call" &&
    lastToolCall.toolUseId === event.toolUseId;
  const answerTurn = findAnswerTurn(events, event.toolUseId);

  // still being asked: no result yet, the latest tool call, and the
  // conversation waiting on a question. The `"question"` pending prompt draws
  // the question then (its owner decides how it is answered — a held call's
  // form, or the flush fallback), so the transcript leaves it to that one card.
  // Whether the call reaches the transcript before its answer depends on the
  // host (the SDK writes it at once; the interactive CLI only once answered).
  // A stale conversation row keeps the card: hiding is only for a live ask.
  const waitingOnQuestion =
    conversation.status === "ready" &&
    conversation.data?.waitingFor === QUESTION_WAITING_FOR;
  if (event.result == null && isLastToolCall && waitingOnQuestion) return null;

  // awaiting: cancelled (interrupt) + most recent question + no answer yet,
  // and no message sent in its place.
  if (isAwaitingAnswer(events, event)) {
    return (
      <ToolCallCard
        event={event}
        summary={summaryFor(questions, [])}
        defaultOpen
        isError={showAsError}
      >
        <MarkerAnswerForm
          questions={questions}
          convId={convId}
          toolUseId={event.toolUseId}
        />
      </ToolCallCard>
    );
  }

  // answerMap selection:
  // - flush path: a marker answer turn was found → parse it.
  // - relay / terminal path: the CLI's structured answer record on the result.
  // - otherwise (result null pre-flush, or interrupted-but-not-last historical
  //   question with no answer turn): empty map → question rendered read-only.
  const answerRecord = event.result?.questionAnswer;
  let answerMap: Record<string, ParsedAnswer> | null = null;
  if (answerTurn != null) {
    answerMap = parseMarkerAnswer(answerTurn.text, questions);
  } else if (answerRecord != null) {
    answerMap = answersFromRecord(answerRecord);
  }

  const questionSelections = questions.map((q) => {
    const parsed = answerMap?.[q.question];
    const { selected, otherText } = parseSelectedLabels(
      parsed?.answer ?? undefined,
      q.options,
    );
    return { selected, otherText, notes: parsed?.notes ?? null };
  });

  const firstSel = questionSelections[0];
  const firstAnswerParts = firstSel
    ? [
        ...firstSel.selected,
        ...(firstSel.otherText ? [firstSel.otherText] : []),
        // Fall back to the note when the user attached one without picking an option.
        ...(firstSel.selected.size === 0 &&
        !firstSel.otherText &&
        firstSel.notes
          ? [firstSel.notes]
          : []),
      ]
    : [];

  // A reply given in place of the answers stands in for them in the summary.
  const summary = summaryFor(
    questions,
    firstAnswerParts.length === 0 && answerRecord?.response != null
      ? [answerRecord.response]
      : firstAnswerParts,
  );

  return (
    <ToolCallCard
      event={event}
      summary={summary}
      defaultOpen
      isError={showAsError}
    >
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mt offsets the answered view from the question card above (no named margin utility) */}
      <Stack gap="md" className="mt-2">
        {questions.map((q, qi) => {
          const { selected, otherText, notes } = questionSelections[qi] ?? {
            selected: new Set<string>(),
            otherText: null,
            notes: null,
          };
          const hasAnswer = selected.size > 0 || otherText != null;

          return (
            <div key={qi}>
              {questions.length > 1 && (
                <p
                  // eslint-disable-next-line spacing/no-adhoc-spacing -- mb separates the per-question header from its question text (no named margin utility)
                  className="mb-1 text-3xs font-medium tracking-wider text-muted-foreground"
                >
                  {q.header}
                </p>
              )}
              {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mb separates the question text from its option list (no named margin utility) */}
              <Text as="p" variant="caption" className="mb-1.5 text-foreground">
                {q.question}
              </Text>
              <Stack gap="xs">
                {q.options.map((opt, oi) => (
                  <OptionRow
                    key={oi}
                    selected={selected.has(opt.label)}
                    multi={q.multiSelect}
                    dimmed={hasAnswer}
                  >
                    <OptionBody
                      label={opt.label}
                      description={opt.description}
                      preview={opt.preview}
                    />
                  </OptionRow>
                ))}
                {otherText != null && (
                  <OptionRow selected multi={q.multiSelect}>
                    <Text
                      as="p"
                      variant="caption"
                      className="italic text-foreground"
                    >
                      {otherText}
                    </Text>
                  </OptionRow>
                )}
                {notes != null && (
                  <div className="rounded-md border-l-2 border-muted-foreground/30 bg-muted/40 py-xs pl-sm">
                    <p className="text-3xs font-medium tracking-wider text-muted-foreground">
                      Note
                    </p>
                    <Text
                      as="p"
                      variant="caption"
                      className="whitespace-pre-wrap break-words text-foreground"
                    >
                      {notes}
                    </Text>
                  </div>
                )}
              </Stack>
            </div>
          );
        })}
        {answerRecord?.response != null && (
          <div className="rounded-md border-l-2 border-muted-foreground/30 bg-muted/40 py-xs pl-sm">
            <p className="text-3xs font-medium tracking-wider text-muted-foreground">
              Reply
            </p>
            <Text
              as="p"
              variant="caption"
              className="whitespace-pre-wrap break-words text-foreground"
            >
              {answerRecord.response}
            </Text>
          </div>
        )}
        {event.result?.isError && !resultIsInterrupt && (
          <Text as="p" variant="caption" tone="destructive">
            {event.result.content}
          </Text>
        )}
      </Stack>
    </ToolCallCard>
  );
}
