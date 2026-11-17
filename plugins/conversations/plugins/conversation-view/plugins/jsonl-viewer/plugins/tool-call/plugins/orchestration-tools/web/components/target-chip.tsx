import { ConvChip } from "@plugins/active-data/plugins/conv/web";
import { TaskLinkChip } from "@plugins/active-data/plugins/task-link/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

const NO_ATTRS = {};

/** A task's chip (its live title and status, opens its detail). */
export function TaskChip({ taskId }: { taskId: string }) {
  return <TaskLinkChip content={taskId} attrs={NO_ATTRS} />;
}

/** `message_agent`'s recipient, opening the conversation the message went to
 *  (beside this one): the conversation the tool's answer says it was sent to,
 *  else the conversation id it named. A task id (its latest conversation) the
 *  answer has not resolved yet — still running, or not sent — stays the task's
 *  chip. */
export function AgentChip({
  to,
  sentTo,
}: {
  to: string;
  /** The conversation the answer says the message was delivered to. */
  sentTo: string | undefined;
}) {
  const conversationId = sentTo ?? (to.startsWith("task-") ? null : to);
  if (conversationId === null) return <TaskChip taskId={to} />;
  return <ConvChip content={conversationId} attrs={NO_ATTRS} />;
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
