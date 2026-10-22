import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pendingQuestionsServed } from "./internal/resource";

export { onQuestionResolved } from "./internal/resolved";
export type { ResolvedQuestion } from "./internal/resolved";

export default {
  portable: true,
  description:
    "The AskUserQuestion relay's backend: the pending_questions table (one row per held call: open → answered | abandoned), onQuestionResolved, and the open-questions live collection. Holding a question (the runtime parks the call in-process), the question-hold source the status reconciler reads (and its dead-holder retirement) and the 7-day retention sweep are the machine half's.",
  contributions: [...pendingQuestionsServed.declare],
} satisfies ServerPluginDefinition;
