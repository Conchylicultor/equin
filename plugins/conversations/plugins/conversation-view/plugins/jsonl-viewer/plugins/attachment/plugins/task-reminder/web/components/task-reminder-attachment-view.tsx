import { CollapsibleCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";
import type { AttachmentRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/core";
import {
  FirstLine,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

interface TaskReminderItem {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: string;
  blocks: string[];
  blockedBy: string[];
}

interface TaskReminderPayload {
  type: "task_reminder";
  itemCount: number;
  content: TaskReminderItem[];
}

const STATUS_DOT: Record<string, string> = {
  in_progress: "bg-info",
  done: "bg-success",
  completed: "bg-success",
  blocked: "bg-destructive",
  need_action: "bg-warning",
};
const DEFAULT_DOT = "bg-muted-foreground/40";

export function TaskReminderAttachmentView({ event }: AttachmentRendererProps) {
  const att = event.attachment as TaskReminderPayload;
  const count = att.itemCount ?? att.content?.length ?? 0;

  return (
    <CollapsibleCard
      label="Task reminder"
      note={`· ${count === 0 ? "no tasks" : `${count} task${count === 1 ? "" : "s"}`}`}
    >
      {count === 0 ? (
        <Text
          as="p"
          variant="caption"
          className="text-muted-foreground/60 italic"
        >
          No active tasks.
        </Text>
      ) : (
        <Stack as="ul" gap="xs">
          {att.content.map((task) => (
            <Stack as="li" key={task.id} direction="row" gap="sm" align="start">
              <FirstLine variant="caption">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    rigidClass(),
                    STATUS_DOT[task.status] ?? DEFAULT_DOT,
                  )}
                />
              </FirstLine>
              <Text as="span" variant="caption" className={fillClasses("x")}>
                <span className="text-foreground">{task.subject}</span>
                {task.description && (
                  <>
                    {" "}
                    <span className="text-muted-foreground/60 truncate">
                      — {task.description}
                    </span>
                  </>
                )}
              </Text>
            </Stack>
          ))}
        </Stack>
      )}
    </CollapsibleCard>
  );
}
