import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { TaskDraftPopover } from "@plugins/tasks/plugins/task-draft-form/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");

export function NewChildTaskAction() {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  if (!conversation) return null;
  return (
    <TaskDraftPopover
      trigger={
        <Button
          variant="ghost"
          aspect="icon"
          aria-label="New child task"
          tooltip="New child task"
        >
          <Icon icon={addIcon} />
        </Button>
      }
      target={{ kind: "folder", folderTaskId: conversation.taskId }}
      relate={{ taskId: conversation.taskId, defaultMode: "followup" }}
      heading="Create child task"
    />
  );
}
