import type { AvatarSpec } from "@plugins/fields/plugins/avatar/core";
import type { DbExecutor } from "@plugins/database/server";
import { conversationPreprompt } from "./tables";

export interface ConversationPrepromptSnapshot {
  prepromptId: string;
  title: string;
  text: string;
  icon: AvatarSpec | null;
}

// Write the launch-time preprompt snapshot of a conversation. The conversation
// launch calls it on its own transaction, so a conversation exists iff its
// snapshot does — and every later spawn of it (resume, fork) reads the
// instructions back from here. The DB change-feed routes the write to this
// conversation's `:rows` tuple, so the header chip re-renders.
export async function recordConversationPreprompt(
  conversationId: string,
  data: ConversationPrepromptSnapshot,
  exec?: DbExecutor,
): Promise<void> {
  await conversationPreprompt.upsert(conversationId, data, exec);
}

// The preprompt a conversation was launched with; `undefined` when it was
// launched without one.
export async function getConversationPreprompt(
  conversationId: string,
  exec?: DbExecutor,
): Promise<ConversationPrepromptSnapshot | undefined> {
  const row = await conversationPreprompt.get(conversationId, exec);
  if (!row) return undefined;
  return {
    prepromptId: row.prepromptId,
    title: row.title,
    text: row.text,
    icon: row.icon,
  };
}
