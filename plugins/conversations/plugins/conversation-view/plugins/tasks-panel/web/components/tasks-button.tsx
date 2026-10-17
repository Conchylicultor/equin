import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { useActiveDependentCount, useTask } from "@plugins/tasks/web";
import { STATUS_META } from "@plugins/tasks/plugins/task-status/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const checklistIcon = symbol("checklist");

/**
 * The ONE task affordance of the conversation toolbar: opens the task pane and
 * carries the two facts about that task worth reading at a glance — its status
 * (a colored dot) and how many tasks are waiting on it (a bare count). Both
 * spell themselves out in the tooltip, so the glyphs stay quiet.
 */
export function TasksButton() {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  const taskId = conversation?.taskId;
  const { isOpen, toggle } = taskDetailPane.useToggle({ taskId: taskId ?? "" });

  const task = useTask(taskId ?? null);
  const blocked = useActiveDependentCount(taskId);
  // The status dot appears once the task is known; a failed read leaves it out
  // (the blocked-count line below names the failure — both read one list).
  const status = foldResource(task, {
    loading: () => null,
    error: () => null,
    ready: (t) => (t ? STATUS_META[t.status] : null),
  });
  // Until the task set is known there is no count to show — and no `0` drawn
  // either, so the button never claims "nothing is waiting on this" before it
  // could know. The count simply appears once the answer arrives.
  // A count that FAILED to load says so in the tooltip rather than vanishing
  // as if still on its way.
  const blockedCount = foldResource(blocked, {
    loading: () => null,
    error: () => null,
    ready: (count) => (count === 0 ? null : count),
  });
  const blockedLine = foldResource(blocked, {
    loading: () => null,
    error: (error) => `Blocked count failed to load: ${error.message}`,
    ready: (count) =>
      count === 0
        ? null
        : `${count} task${count === 1 ? "" : "s"} blocked on this task`,
  });

  const title = ["Tasks", status?.label, blockedLine]
    .filter(Boolean)
    .join(" · ");

  return (
    <Button
      variant={isOpen ? "secondary" : "ghost"}
      tooltip={title}
      aria-label={title}
      aria-pressed={isOpen}
      onClick={() => {
        if (taskId) toggle();
      }}
      disabled={!taskId}
      className="gap-xs"
    >
      <Icon icon={checklistIcon} />
      {status && <StatusDot colorClass={status.dotClass} />}
      {blockedCount !== null && (
        <Text as="span" variant="count" tone="muted">
          {blockedCount}
        </Text>
      )}
    </Button>
  );
}
