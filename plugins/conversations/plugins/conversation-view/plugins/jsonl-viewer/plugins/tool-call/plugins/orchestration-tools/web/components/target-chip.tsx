import { ConvChip } from "@plugins/active-data/plugins/conv/web";
import { TaskLinkChip } from "@plugins/active-data/plugins/task-link/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

const NO_ATTRS = {};

/** A task's chip (its live title and status, opens its detail). */
export function TaskChip({ taskId }: { taskId: string }) {
  return <TaskLinkChip content={taskId} attrs={NO_ATTRS} />;
}

/** What `message_agent` names as its recipient: a task id (its latest
 *  conversation) or a conversation id. */
export function AgentChip({ to }: { to: string }) {
  if (to.startsWith("task-")) return <TaskChip taskId={to} />;
  return <ConvChip content={to} attrs={NO_ATTRS} />;
}

/** The tool's refusal, in its own words. */
export function Refusal({ message }: { message: string }) {
  return (
    <Text
      as="p"
      variant="caption"
      className="text-destructive whitespace-pre-wrap"
    >
      {message}
    </Text>
  );
}
