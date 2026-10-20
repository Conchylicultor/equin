import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useLive } from "@plugins/network/plugins/live/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { jsonlEvents } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import { RowActionButton } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { useGoBackToMessage } from "@plugins/conversations/plugins/conversation-view/plugins/rewind/web";
import { restoreAnswerDraft } from "./answer-draft";
import { type AskUserQuestionInput } from "./answer-model";
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
 * The answer is an ordinary user turn this plugin hides from the transcript, so
 * the transcript's own per-message rewind never shows for it; the question's
 * row is the only place that can offer it.
 */
export function ChangeAnswersAction({ event }: { event: JsonlEvent }) {
  if (event.kind !== "tool-call" || event.name !== "AskUserQuestion") {
    return null;
  }
  return <ChangeAnswersMenu event={event} />;
}

function ChangeAnswersMenu({ event }: { event: ToolCallEvent }) {
  const { convId } = conversationPane.useParams();
  const eventsResult = useLive(jsonlEvents, { id: convId });
  // A failed read offers no rewind, deliberately: this is an optional row
  // action, and the question card on the same row renders that read's failure.
  if (eventsResult.status === "loading" || eventsResult.status === "error")
    return null;
  // Only an answer sent from here is a message a rewind can cut at; one given
  // in the terminal lives inside the tool result.
  const answerTurn = findAnswerTurn(eventsResult.data, event.toolUseId);
  if (answerTurn == null) return null;
  return (
    <ChangeAnswersMenuFor
      convId={convId}
      event={event}
      answerUuid={answerTurn.uuid}
    />
  );
}

function ChangeAnswersMenuFor({
  convId,
  event,
  answerUuid,
}: {
  convId: string;
  event: ToolCallEvent;
  answerUuid: string | undefined;
}) {
  const input = event.input as AskUserQuestionInput;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard; input is `as`-cast from unknown
  const questions = Array.isArray(input?.questions) ? input.questions : [];

  const { available, busy, run } = useGoBackToMessage({
    convId,
    uuid: answerUuid,
    // The removed text is the serialized answer: put it back in the form, not
    // in the prompt editor.
    onBack: (targetConvId, answerText) =>
      restoreAnswerDraft(targetConvId, event.toolUseId, questions, answerText),
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
