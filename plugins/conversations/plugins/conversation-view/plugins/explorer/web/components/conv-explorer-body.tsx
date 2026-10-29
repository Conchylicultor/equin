import { useCallback } from "react";
import {
  FileBrowser,
  locationParams,
  useLocationNavigator,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import type { ExplorerLocation } from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversation } from "@plugins/conversations/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { convFileTreePane } from "../panes";
import { useConvLocation } from "./conv-location";

export function ConvExplorerBody() {
  const convId = conversationPane.useRouteEntry()?.params.convId;
  if (convId === undefined)
    return <Placeholder>No conversation open.</Placeholder>;
  return <ConvExplorer convId={convId} />;
}

function ConvExplorer({ convId }: { convId: string }) {
  const result = useConversation(convId);
  if (result.status === "loading") return <Loading variant="rows" />;
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the conversation"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }
  if (result.data === null) {
    return <Placeholder>This conversation no longer exists.</Placeholder>;
  }
  // A reaped worktree is not special-cased: the browser renders its root
  // listing's `missing` answer ("… does not exist") like any other folder.
  return <RoutedExplorer worktree={result.data.worktreePath} />;
}

/**
 * The file explorer's browser over the checkout, routed through this pane's
 * params: another folder swaps this slot for a fresh instance (a history
 * entry; the filter and selection start over, as in Files), and opening a
 * file rewrites the params in place.
 */
function RoutedExplorer({ worktree }: { worktree: string }) {
  const location = useConvLocation(worktree);
  const openPane = useOpenPane();
  const setParams = convFileTreePane.useSetParams();
  const go = useCallback(
    (next: ExplorerLocation) =>
      openPane.to(convFileTreePane, locationParams(next), { mode: "swap" }),
    [openPane],
  );
  const navigator = useLocationNavigator(location, go, setParams);
  return (
    <FileBrowser navigator={navigator} root={worktree} atSurfaceEdge={false} />
  );
}
