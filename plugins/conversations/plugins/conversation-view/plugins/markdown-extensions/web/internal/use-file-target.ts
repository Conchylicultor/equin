import { useMemo } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { useFileLinksWorkspace } from "@plugins/primitives/plugins/file-links/web";
import { filePeekPane } from "@plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web";

// Resolves the file link shared by every inline renderer here: the markdown
// file-links + code + img enhancers and the plain-text inline walker. A path's
// target is a file-peek pane in the checkout the content's HOST declared
// (`FileLinksWorkspaceProvider` — the conversation pane, task detail, file
// peek, a global card) — a LinkTarget, so ⌘/middle-click opens it in a new
// browser tab. Outside every provider → undefined (paths stay plain). Never
// read from the pane route: that throws in global chrome. Single source so the
// markdown and plain-text file links can't diverge.
export function useFileTarget():
  ((path: string, line?: number) => LinkTarget) | undefined {
  const workspace = useFileLinksWorkspace()?.workspace;
  // Legal anywhere — opening, unlike reading the route, works from global
  // chrome too (it opens into the focused tab).
  const openPane = useOpenPane();

  return useMemo(() => {
    if (!workspace) return undefined;
    return (path: string, line?: number) =>
      openPane.to(
        filePeekPane,
        {
          worktree: workspace,
          filePath: line != null ? `${path}:${line}` : path,
        },
        { mode: "push" },
      );
  }, [workspace, openPane]);
}
