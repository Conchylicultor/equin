import {
  Pane,
  PaneChrome,
  defineRoute,
  type PaneExpandTarget,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import {
  locationOf,
  useOpenInFiles,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { ConvExplorerBody } from "./components/conv-explorer-body";

export const convFileTreePane = Pane.define({
  title: "Files",
  // The explorer's location rides the route like `/files/at/…` does — the
  // folder (`;dir`, absent = the checkout) and the file open beside it
  // (`;open`) — so every folder is a link, back / forward are the browser
  // history, and Open in Files lands where the user is.
  route: defineRoute({
    id: "conv-file-tree",
    segment: "files;dir;open",
  }),
  app: agentManagerApp,
  // Conversation-scoped satellite: a promote of the pane itself would strip
  // convId from the URL, so Expand is Files, on the current location.
  expand: { app: fileExplorerApp, useTarget: useOpenInFilesTarget },
  component: ConvExplorerChromedBody,
  // Tree plus the selected file's preview beside it.
  width: 960,
});

function useOpenInFilesTarget(params: {
  dir?: string;
  open?: string;
}): PaneExpandTarget {
  const convId = conversationPane.useRouteEntry()?.params.convId ?? null;
  const worktree = useConversationById(convId)?.worktreePath;
  const target = useOpenInFiles(
    locationOf({ dir: params.dir ?? worktree ?? "", open: params.open }),
  );
  // Never `none`: its fallback is the pane's own promote, which drops convId.
  if (params.dir === undefined && worktree === undefined) {
    return { kind: "pending" };
  }
  return { kind: "ready", target };
}

function ConvExplorerChromedBody() {
  return (
    <PaneChrome pane={convFileTreePane}>
      <ConvExplorerBody />
    </PaneChrome>
  );
}
