import type { ToastArgs } from "@plugins/shell/plugins/notifications/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const droppedIcon = symbol("delete");

/**
 * "Conversation dropped" — what a drop that really dropped the task says,
 * from every surface that drops (the exit menu's Drop & Close, the prompt's
 * Drop & Close). Sent even while the user watches: the drop removes the
 * conversation from what they were looking at. A close that dropped nothing
 * says nothing — the user saw it happen.
 */
export function droppedNotification(conv: {
  id: string;
  name: string;
}): ToastArgs {
  return {
    type: "conversation",
    category: "conversations",
    icon: droppedIcon,
    title: "Conversation dropped",
    description: "",
    subjectId: conv.id,
    subjectName: conv.name,
    variant: "success",
  };
}
