import { rowOrStale } from "@plugins/network/plugins/live/web";
import {
  Pane,
  defineRoute,
  type PaneExpandTarget,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import {
  FileBrowserHeader,
  FileBrowserPath,
  filePreviewBesidePane,
  useOpenInFiles,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { ConvExplorerBody } from "./components/conv-explorer-body";

export const convFileTreePane = Pane.define({
  // The header is the file browser's own (back / forward / up, the path bar
  // as the title, the filter, the toggles); the tab still reads "Files".
  title: { useText: "Files", component: FileBrowserPath },
  actions: FileBrowserHeader,
  // The explorer's folder rides the route like `/files/browse/…` does
  // (`;dir`, absent = the checkout), so every folder is a link, back / forward
  // are the browser history, and Open in Files lands where the user is. The
  // open file is a column of its own beside this one (the browser's
  // `filePreviewBesidePane`); a stale `;open` from before is dropped on parse.
  route: defineRoute({
    id: "conv-file-tree",
    segment: "files;dir",
  }),
  app: agentManagerApp,
  // Conversation-scoped satellite: a promote of the pane itself would strip
  // convId from the URL, so Expand is Files, on the current location.
  expand: { app: fileExplorerApp, useTarget: useOpenInFilesTarget },
  component: ConvExplorerBody,
});

function useOpenInFilesTarget(params: { dir?: string }): PaneExpandTarget {
  const convId = conversationPane.useEnclosing()?.params.convId ?? null;
  const conversation = useConversationById(convId);
  const worktree = rowOrStale(conversation)?.worktreePath;
  // The file previewed in the column this pane opened, if any.
  const opened = filePreviewBesidePane.useOpenedHere();
  const target = useOpenInFiles({
    fs: "computer",
    dir: params.dir ?? worktree ?? "",
    open:
      opened !== null && opened.params.fs === undefined
        ? opened.params.path
        : null,
  });
  // Never `none`: its fallback is the pane's own promote, which drops convId.
  // Pending only while the worktree may still arrive: a conversation that is
  // not there (or a read that failed with nothing seen) opens Files at its root.
  if (
    params.dir === undefined &&
    worktree === undefined &&
    conversation.status === "loading"
  ) {
    return { kind: "pending" };
  }
  return { kind: "ready", target };
}
