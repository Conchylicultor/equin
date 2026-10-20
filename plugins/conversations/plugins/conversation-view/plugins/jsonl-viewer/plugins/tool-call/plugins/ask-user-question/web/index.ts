import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewerTool } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { JsonlRowActions } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { isInterruptContent } from "@plugins/conversations/plugins/transcript-source/core";
import { AskUserQuestionToolView } from "./components/ask-user-question-tool-view";
import { ChangeAnswersAction } from "./components/change-answers-action";
import { ANSWER_MARKER } from "../shared";

// The answer surfaces another plugin composes: the question relay
// (conversations/question-relay) owns the `"question"` pending prompt and
// renders its held question as a `QuestionCard` holding an `AnswerForm`.
export { AnswerForm } from "./components/answer-form";
export { QuestionCard } from "./components/question-card";
export { answerDraftScope } from "./components/answer-draft";
export type {
  AnswerSelections,
  FormAnswer,
  Question,
  QuestionSelection,
} from "./components/answer-model";

export default {
  description:
    "Renders AskUserQuestion tool calls with question headers, option lists, and answer highlights.",
  contributions: [
    JsonlViewerTool.Renderer({
      match: "AskUserQuestion",
      component: AskUserQuestionToolView,
    }),
    JsonlRowActions.Item({
      id: "change-answers",
      component: ChangeAnswersAction,
    }),
    JsonlViewer.EventFilter({
      id: "ask-user-question:suppress-answer-turn",
      hide: (event) =>
        event.kind === "user-text" && event.text.startsWith(ANSWER_MARKER),
    }),
    // Hide the standalone "[Request interrupted by user for tool use]" turn the
    // CLI emits when a tool (e.g. an AskUserQuestion menu) is cancelled — the
    // cancellation is already conveyed by the question card's awaiting/answered
    // state, so the bare row is pure noise.
    JsonlViewer.EventFilter({
      id: "ask-user-question:suppress-interrupt-turn",
      hide: (event) =>
        event.kind === "user-text" && isInterruptContent(event.text),
    }),
  ],
} satisfies PluginDefinition;
