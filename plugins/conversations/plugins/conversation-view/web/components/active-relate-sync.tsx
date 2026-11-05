import { rowOrStale } from "@plugins/network/plugins/live/web";
import { useActiveRelateTask } from "@plugins/tasks/plugins/task-draft-form/web";
import { useConversationById } from "@plugins/conversations/web";
import { conversationPane } from "../panes";

export function ActiveRelateSync() {
  const { convId } = conversationPane.useParams();
  const conversation = rowOrStale(useConversationById(convId));
  useActiveRelateTask(conversation?.taskId ?? null);
  return null;
}
