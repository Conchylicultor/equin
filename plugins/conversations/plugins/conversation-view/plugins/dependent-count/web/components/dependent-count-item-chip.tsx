import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import type { ConversationItemConv } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { useActiveDependentCount } from "@plugins/tasks/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";

/**
 * Per-row "N blocked" chip for a conversation item (queue / sidebar rows): how
 * many tasks are transitively blocked by that row's task. The number is always
 * visible; the word "blocked" reveals on hover so a row of chips stays compact.
 *
 * Renders nothing until the count is known, an error glyph when it could not
 * be read, and nothing when it is zero. The
 * conversation toolbar shows the same count inside its Tasks button rather than
 * as a chip of its own.
 */
export function DependentCountItemChip({
  conv,
}: {
  conv: ConversationItemConv;
}) {
  const blocked = useActiveDependentCount(conv.taskId);

  if (blocked.status === "loading") return null;
  if (blocked.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the blocked-task count"
        error={blocked.error}
        refetch={blocked.refetch}
      />
    );
  if (blocked.data === 0) return null;
  const count = blocked.data;

  return (
    <Badge
      className="group/blocked"
      tooltip={`${count} task${count === 1 ? "" : "s"} blocked on this task`}
    >
      {count}
      <span className="hidden group-hover/blocked:inline"> blocked</span>
    </Badge>
  );
}
