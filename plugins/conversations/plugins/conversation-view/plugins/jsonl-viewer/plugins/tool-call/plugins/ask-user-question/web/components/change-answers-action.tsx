import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useTranscriptEvents } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { RowActionButton } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { useGoBackToMessage } from "@plugins/conversations/plugins/conversation-view/plugins/rewind/web";
import {
  restoreAnswerDraft,
  restoreAnswerDraftFromRecord,
} from "./answer-draft";
import { type AskUserQuestionInput, type Question } from "./answer-model";
import { findAnswerTurn } from "./question-state";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const callSplitIcon = symbol("call-split");
const historyIcon = symbol("history");
const undoIcon = symbol("undo");

type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;

/**
 * Row action on an answered question: go back to just before the answer was
 * sent, and reopen the question's form with the previous answer filled in —
 * either here (the agent forgets everything since) or in a new conversation.
 * Same glyph and menu as the rewind on the user's own messages.
 *
 * The answer is either the tool's real result (answered through the live
 * form) or an ordinary user turn this plugin hides from the transcript (sent
 * after the agent stopped asking). Neither is a row the transcript's own
 * per-message rewind shows on, so the question's row is the only place that
 * can offer it.
 */
export function ChangeAnswersAction({ event }: { event: JsonlEvent }) {
  if (event.kind !== "tool-call" || event.name !== "AskUserQuestion") {
    return null;
  }
  return <ChangeAnswersMenu event={event} />;
}

function ChangeAnswersMenu({ event }: { event: ToolCallEvent }) {
  const { convId } = conversationPane.useParams();
  // The transcript this row is drawn in: a window of a long conversation
  // still holds every event after this call, which is where its answer is.
  const events = useTranscriptEvents();
  const answerTurn = findAnswerTurn(events, event.toolUseId);
  if (answerTurn != null) {
    // Answered as a message: its text is the serialized answer.
    return (
      <ChangeAnswersMenuFor
        convId={convId}
        event={event}
        answerUuid={answerTurn.uuid}
        restore={(targetConvId, questions, answerText) =>
          restoreAnswerDraft(
            targetConvId,
            event.toolUseId,
            questions,
            answerText,
          )
        }
      />
    );
  }
  const record = event.result?.questionAnswer;
  const answerUuid = event.result?.answerUuid;
  if (record == null || answerUuid == null) return null;
  // Answered as the tool's result: its structured record is the answer.
  return (
    <ChangeAnswersMenuFor
      convId={convId}
      event={event}
      answerUuid={answerUuid}
      restore={(targetConvId, questions) =>
        restoreAnswerDraftFromRecord(
          targetConvId,
          event.toolUseId,
          questions,
          record,
        )
      }
    />
  );
}

function ChangeAnswersMenuFor({
  convId,
  event,
  answerUuid,
  restore,
}: {
  convId: string;
  event: ToolCallEvent;
  answerUuid: string | undefined;
  /** Put the removed answer back in the reopened form of `targetConvId`. */
  restore: (
    targetConvId: string,
    questions: Question[],
    answerText: string,
  ) => void;
}) {
  const input = event.input as AskUserQuestionInput;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; input is `as`-cast from unknown
  const questions = Array.isArray(input?.questions) ? input.questions : [];

  const { available, busy, run } = useGoBackToMessage({
    convId,
    uuid: answerUuid,
    // The removed answer goes back in the form, not in the prompt editor.
    onBack: (targetConvId, answerText) =>
      restore(targetConvId, questions, answerText),
  });

  if (!available) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <RowActionButton tooltip="Change answers">
            <Icon icon={historyIcon} className="size-3" />
          </RowActionButton>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={busy} onClick={() => void run("rewind")}>
          <Icon icon={undoIcon} />
          Rewind and answer again
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onClick={() => void run("fork")}>
          <Icon icon={callSplitIcon} />
          Answer again in a fork
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
