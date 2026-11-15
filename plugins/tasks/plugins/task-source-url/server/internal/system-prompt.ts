import { SystemPrompt } from "@plugins/conversations/plugins/system-prompt/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { tasksSourceUrl } from "./tables";

/**
 * The page the agent's task was filed from, as context rather than as part of
 * the user's words: the draft form's Page URL toggle stores it as data
 * (`tasks_ext_source_url`), and this section hands it to the agent at every
 * spawn. Nothing when the conversation has no task or its task no stored url.
 */
export async function renderSourcePage(
  conversationId: string,
): Promise<string | null> {
  const conversation = await getConversation(conversationId);
  if (conversation === null) return null;
  const row = await tasksSourceUrl.get(conversation.taskId);
  if (row === undefined) return null;
  return [
    "## Source page",
    "",
    `The user filed this task while on ${row.url} — the page their request is about, unless it says otherwise.`,
  ].join("\n");
}

export const sourcePageSection = SystemPrompt.Section({
  id: "source-page",
  label: "Source page",
  render: (conversationId) => renderSourcePage(conversationId),
});
