import type { ReactNode } from "react";
import { FileLinksWorkspaceProvider } from "@plugins/primitives/plugins/file-links/web";
import { useConversationById } from "./use-conversations";

/**
 * Declares that file paths rendered below belong to this conversation's
 * attempt worktree (with its checkout path as the root, so an absolute path
 * inside it reads from the checkout). The one spelling for every surface
 * hosting a conversation's content — its pane, a sub-agent's pane, a workflow
 * node's pane. Until the conversation's row is in, paths stay plain.
 */
export function ConversationFileLinks({
  conversationId,
  children,
}: {
  conversationId: string | null;
  children: ReactNode;
}) {
  const conversation = useConversationById(conversationId);
  return (
    <FileLinksWorkspaceProvider
      workspace={conversation?.attemptId}
      root={conversation?.worktreePath}
    >
      {children}
    </FileLinksWorkspaceProvider>
  );
}
