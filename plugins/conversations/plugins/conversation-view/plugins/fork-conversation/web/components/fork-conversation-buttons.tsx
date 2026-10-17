import type { Conversation as ConversationRecord } from "@plugins/tasks/plugins/tasks-core/core";
import { LaunchControl } from "@plugins/primitives/plugins/launch/web";
import { WithTooltip } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const forkRightIcon = symbol("fork-right");

export function ForkConversationButtons({
  conversation,
}: {
  conversation: ConversationRecord;
}) {
  return (
    <WithTooltip content="New conversation in this worktree">
      <Stack direction="row" gap="xs" align="center">
        <Icon icon={forkRightIcon} className="size-3.5 text-muted-foreground" />
        <LaunchControl
          variant="ghost"
          getRequest={() => ({ attemptId: conversation.attemptId })}
        />
      </Stack>
    </WithTooltip>
  );
}
