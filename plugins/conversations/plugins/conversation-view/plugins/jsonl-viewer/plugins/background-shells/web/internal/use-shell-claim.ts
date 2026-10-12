import type {
  TaskNotificationClaim,
  TaskNotificationEvent,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/task-notification/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { shellOutputPane } from "../panes";
import { useConversationShells } from "./use-conversation-shells";

const terminalIcon = symbol("terminal");

/**
 * Claims a `<task-notification>` that ended one of this conversation's
 * background shells — joined the way `backgroundShellsOf` joins it (task id =
 * shell id, else the launching call's tool-use id) — and opens its output
 * pane. Anything else is declined.
 */
export function useShellNotificationClaim(
  event: TaskNotificationEvent,
  conversationId: string | null,
): TaskNotificationClaim {
  const shells = useConversationShells(conversationId);
  const openPane = useOpenPane();
  if (shells.kind === "pending") return { kind: "pending" };
  // Unreadable: whether it is a shell's is unknown — decline, never guess.
  if (shells.kind === "failed") return { kind: "declined" };
  const shell = shells.shells.find(
    (s) =>
      s.shellId === event.taskId ||
      (event.toolUseId !== undefined && s.toolUseId === event.toolUseId),
  );
  if (shell === undefined) return { kind: "declined" };
  return {
    kind: "claimed",
    target: {
      label: "Open output",
      icon: terminalIcon,
      activation: openPane.to(
        shellOutputPane,
        { shellId: shell.shellId },
        { mode: "push" },
      ),
    },
  };
}
