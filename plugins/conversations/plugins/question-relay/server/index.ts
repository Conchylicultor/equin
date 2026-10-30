import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { pendingQuestionsServed } from "./internal/resource";
import { pendingQuestionsRetention } from "./internal/retention";

export { onQuestionResolved } from "./internal/resolved";
export type { ResolvedQuestion } from "./internal/resolved";

export default {
  portable: true,
  description:
    "The AskUserQuestion relay's backend: the pending_questions table (one row per held call: open → answered | abandoned), onQuestionResolved, the open-questions live collection and the 7-day retention sweep of resolved rows. Holding a question (the runtime parks the call in-process), the question-hold source the status reconciler reads (and its dead-holder retirement) are the machine half's.",
  register: [pendingQuestionsRetention],
  contributions: [...pendingQuestionsServed.declare],
} satisfies ServerPluginDefinition;
