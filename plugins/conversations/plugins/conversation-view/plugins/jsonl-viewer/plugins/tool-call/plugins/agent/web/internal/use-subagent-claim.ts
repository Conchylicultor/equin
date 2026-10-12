import type {
  TaskNotificationClaim,
  TaskNotificationEvent,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/task-notification/web";
import { useConversationSubagents } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { agentReportPane } from "../panes";

const articleIcon = symbol("article");

/**
 * Claims a `<task-notification>` that ended one of this conversation's
 * sub-agents, and opens its report pane.
 *
 * It is one of ours when a sub-agent of the conversation joins it: the
 * notification's tool-use id is that sub-agent's (its own, or the `Agent` call's
 * that launched it — a teammate's notification carries the call's), or its task
 * id is the sub-agent's own id. Anything else — a background shell's, say — is
 * declined, so it never opens a sub-agent pane that has nothing to show.
 *
 * The pane opens by the sub-agent's OWN id, the one key every sub-agent has.
 */
export function useSubagentNotificationClaim(
  event: TaskNotificationEvent,
  conversationId: string | null,
): TaskNotificationClaim {
  const subagents = useConversationSubagents(conversationId);
  const openPane = useOpenPane();
  if (subagents.kind === "pending") return { kind: "pending" };
  // The set could not be read, so whether this is a sub-agent's is unknown —
  // decline rather than guess; the sub-agent card says the read failed.
  if (subagents.kind === "failed") return { kind: "declined" };
  const entry = subagents.entries.find(
    ({ row, agentToolEvent }) =>
      row.agentId === event.taskId ||
      (event.toolUseId !== undefined &&
        (agentToolEvent?.toolUseId === event.toolUseId ||
          (row.kind === "described" && row.toolUseId === event.toolUseId))),
  );
  if (entry === undefined) return { kind: "declined" };
  return {
    kind: "claimed",
    target: {
      label: "View sub-agent",
      icon: articleIcon,
      activation: openPane.to(
        agentReportPane,
        { by: "agent", key: entry.row.agentId },
        { mode: "push" },
      ),
    },
  };
}
