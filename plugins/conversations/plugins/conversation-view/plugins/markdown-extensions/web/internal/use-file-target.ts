import { useMemo } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { filePeekPane } from "@plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web";
import { taskDetailPane } from "@plugins/tasks/plugins/task-detail/web";

// Resolves the file link shared by every conversation/task-scoped inline
// renderer: the markdown file-links + code enhancers and the plain-text inline
// walker. A path's target is a file-peek pane in the right worktree — a
// LinkTarget, so ⌘/middle-click opens it in a new browser tab:
//   - inside a conversation → that conversation's attempt worktree
//   - inside a task detail   → "main"
//   - inside a file-peek pane → that pane's worktree
//   - otherwise               → undefined (paths stay plain)
// Single source so the markdown and plain-text file links can't diverge.
export function useFileTarget():
  ((path: string, line?: number) => LinkTarget) | undefined {
  const convId = conversationPane.useRouteEntry()?.params.convId ?? null;
  const conversation = useConversationById(convId);
  const taskEntry = taskDetailPane.useRouteEntry();
  const peekWorktree = filePeekPane.useRouteEntry()?.params.worktree;
  const openPane = useOpenPane();

  const worktree =
    conversation?.attemptId ?? (taskEntry ? "main" : peekWorktree);

  return useMemo(() => {
    if (!worktree) return undefined;
    return (path: string, line?: number) =>
      openPane.to(
        filePeekPane,
        { worktree, filePath: line != null ? `${path}:${line}` : path },
        { mode: "push" },
      );
  }, [worktree, openPane]);
}
