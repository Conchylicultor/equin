import { useCallback } from "react";
import type { ReactNode } from "react";
import {
  FileBrowserBody,
  FileBrowserProvider,
  PendingFileBrowserProvider,
  locationParams,
  useLocationNavigator,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import type { ExplorerLocation } from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversation } from "@plugins/conversations/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  PaneChrome,
  useOpenPane,
  PaneMessage,
} from "@plugins/primitives/plugins/pane/web";
import { convFileTreePane } from "../panes";
import { useConvLocation } from "./conv-location";

/**
 * The pane: the browser over the conversation's checkout, its header the
 * browser's own — held back (PendingFileBrowserProvider) while there is no
 * checkout to browse yet.
 */
export function ConvExplorerBody() {
  const convId = conversationPane.useEnclosing()?.params.convId;
  if (convId === undefined)
    return (
      <Pending>
        <Placeholder>No conversation open.</Placeholder>
      </Pending>
    );
  return <ConvExplorer convId={convId} />;
}

function Pending({ children }: { children: ReactNode }) {
  return (
    <PendingFileBrowserProvider>
      <PaneChrome pane={convFileTreePane}>
        <PaneMessage>{children}</PaneMessage>
      </PaneChrome>
    </PendingFileBrowserProvider>
  );
}

function ConvExplorer({ convId }: { convId: string }) {
  const result = useConversation(convId);
  if (result.status === "loading") {
    return (
      <Pending>
        <Loading variant="rows" />
      </Pending>
    );
  }
  if (result.status === "error") {
    return (
      <Pending>
        <ResourceErrorInline
          variant="block"
          subject="the conversation"
          error={result.error}
          refetch={result.refetch}
        />
      </Pending>
    );
  }
  if (result.data === null) {
    return (
      <Pending>
        <Placeholder>This conversation no longer exists.</Placeholder>
      </Pending>
    );
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
    <FileBrowserProvider navigator={navigator} root={worktree}>
      <PaneChrome pane={convFileTreePane}>
        <FileBrowserBody />
      </PaneChrome>
    </FileBrowserProvider>
  );
}
