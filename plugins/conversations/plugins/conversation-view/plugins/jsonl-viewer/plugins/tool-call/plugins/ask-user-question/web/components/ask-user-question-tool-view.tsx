import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useEffect } from "react";
import { useTranscriptEvents } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import {
  isInterruptContent,
  replyOf,
} from "@plugins/conversations/plugins/transcript-source/core";
import { useConversation } from "@plugins/conversations/web";
import { useTurnsInFlight } from "@plugins/conversations/plugins/conversation-view/plugins/pending-turn/web";
import { MarkerAnswerForm } from "./marker-answer-form";
import {
  AnsweredQuestions,
  SendingStatus,
  answeredSummary,
  selectionsFromForm,
  selectionsFromParsed,
} from "./answered-view";
import { dropSentAnswer, useSentAnswer } from "./sent-answers";
import { summaryFor } from "./question-card";
import {
  findAnswerTurn,
  markerAnswerInFlight,
  questionState,
} from "./question-state";
import {
  answersFromRecord,
  parseMarkerAnswer,
  type AskUserQuestionInput,
  type ParsedAnswer,
} from "./answer-model";

export function AskUserQuestionToolView({ event }: ToolRendererProps) {
  const input = event.input as AskUserQuestionInput;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; input is `as`-cast from unknown
  const questions = Array.isArray(input?.questions) ? input.questions : [];

  const { convId } = conversationPane.useParams();
  // The transcript this card is drawn in. On a long conversation that is its
  // latest window — which holds every event after any event it holds, so the
  // scans below (from this call forward) see all they would in the whole
  // transcript.
  const events = useTranscriptEvents();
  const conversation = useConversation(convId);
  const sent = useSentAnswer(event.toolUseId);
  // Answer turns (the marker path) still on their way to the agent.
  const answerTurns = useTurnsInFlight(convId, "answer");
  // The transcript now holds this call's outcome: the answer this tab sent is
  // no longer on its way.
  const resolved = event.result != null && event.result.outcomeUnknown !== true;
  useEffect(() => {
    if (resolved && sent !== null) dropSentAnswer(event.toolUseId);
  }, [resolved, sent, event.toolUseId]);

  if (conversation.status === "loading" || answerTurns.status === "loading")
    return null;

  const state = questionState(
    events,
    event,
    conversation.status === "ready" ? conversation.data : null,
  );
  // Neither the tmux-era cancel-to-flush interrupt nor the result the CLI
  // filled in after a restart is a failure — a question changes nothing, so
  // it is just unanswered there. Only a genuine error is styled as one.
  const resultIsInterrupt =
    event.result != null &&
    event.result.isError === true &&
    (event.result.outcomeUnknown === true ||
      isInterruptContent(event.result.content));
  const showAsError = !resultIsInterrupt && (event.result?.isError ?? false);
  const answerTurn = findAnswerTurn(events, event.toolUseId);
  // Over a failed ledger read, the last known turns (none: the form shows).
  const markerSending = markerAnswerInFlight(
    answerTurns.status === "ready"
      ? answerTurns.data
      : (answerTurns.stale ?? []),
    state,
    event.at,
  );

  switch (state.kind) {
    case "held":
      // The `"question"` pending prompt draws a held question (the relay form,
      // answered as the tool's real result); the transcript leaves it to that
      // one card.
      return null;
    case "orphaned":
      // Nothing holds the call any more: the answer goes in as a message —
      // drawn as sent below while it is on its way.
      if (markerSending !== null) break;
      return (
        <ToolCallCard
          event={event}
          summary={summaryFor(questions, [])}
          defaultOpen
          isError={showAsError}
          outcomeUnknown={false}
        >
          {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mt offsets the form from the question card above (no named margin utility) */}
          <Stack gap="sm" className="mt-2">
            <Text as="p" variant="caption" tone="muted">
              The agent stopped while asking, so your answer is sent as a
              message.
            </Text>
            <MarkerAnswerForm
              questions={questions}
              convId={convId}
              toolUseId={event.toolUseId}
            />
          </Stack>
        </ToolCallCard>
      );
    case "asking":
    case "settled":
      break;
  }

  // answerMap selection:
  // - flush path: a marker answer turn was found → parse it.
  // - relay / terminal path: the CLI's structured answer record on the result.
  // - otherwise (result null pre-flush, or interrupted-but-not-last historical
  //   question with no answer turn): empty map → question rendered read-only.
  const answerRecord = event.result?.questionAnswer;
  let reply = answerRecord ? (replyOf(answerRecord) ?? null) : null;
  let answerMap: Record<string, ParsedAnswer> | null = null;
  if (answerTurn != null) {
    answerMap = parseMarkerAnswer(answerTurn.text, questions);
  } else if (answerRecord != null) {
    answerMap = answersFromRecord(answerRecord);
  }
  let selections = selectionsFromParsed(questions, answerMap);
  // An answer still on its way: draw it as sent, "Sending…" under it.
  // - relay: answered from this tab, the hold let go, the result not written;
  // - marker: the answer turn not in the transcript yet.
  let inFlight = false;
  if (state.kind === "asking" && sent !== null) {
    inFlight = true;
    selections = selectionsFromForm(questions, sent.answer);
    reply = sent.answer.response;
  } else if (markerSending !== null) {
    inFlight = true;
    selections = selectionsFromParsed(
      questions,
      parseMarkerAnswer(markerSending, questions),
    );
  }

  return (
    <ToolCallCard
      event={event}
      summary={answeredSummary(questions, selections, reply)}
      defaultOpen
      isError={showAsError}
      outcomeUnknown={false}
    >
      <AnsweredQuestions
        questions={questions}
        selections={selections}
        reply={reply}
        footer={
          inFlight ? (
            <SendingStatus />
          ) : (
            event.result?.isError &&
            !resultIsInterrupt && (
              <Text as="p" variant="caption" tone="destructive">
                {event.result.content}
              </Text>
            )
          )
        }
      />
    </ToolCallCard>
  );
}
