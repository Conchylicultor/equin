import { PaneIconAction } from "@plugins/primitives/plugins/pane/web";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { useOpenInFiles } from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { useConvLocation } from "./conv-location";

/**
 * The pane's Expand: the Files app, on the folder (and open file) the pane is
 * showing — what a guest pane's "Open in <App>" is, for a pane whose home stays
 * the conversation (it is rooted at the conversation's checkout).
 */
export function OpenInFilesAction() {
  const convId = conversationPane.useRouteEntry()?.params.convId ?? null;
  const worktree = useConversationById(convId)?.worktreePath;
  // Nothing to open until the conversation names its checkout.
  if (worktree === undefined) return null;
  return <OpenInFiles worktree={worktree} />;
}

function OpenInFiles({ worktree }: { worktree: string }) {
  const target = useOpenInFiles(useConvLocation(worktree));
  return (
    <PaneIconAction
      label="Open in Files"
      icon={navIcons.expand}
      {...linkProps(target)}
    />
  );
}
