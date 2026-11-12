import { getConversationPreprompt } from "@plugins/conversations/plugins/conversation-preprompt/server";
import { composeSystemPromptAppend } from "@plugins/conversations/plugins/system-prompt/plugins/composer/server";

/**
 * What a spawn appends to Claude Code's own system prompt: the conversation's
 * preprompt and every system-prompt section, composed now — call it right
 * before `runtime.create`, never at enqueue (a queued spawn would start on what
 * was true when it was queued).
 */
export async function spawnSystemPrompt(
  conversationId: string,
): Promise<string | undefined> {
  const preprompt = await getConversationPreprompt(conversationId);
  return composeSystemPromptAppend(conversationId, preprompt?.text);
}
