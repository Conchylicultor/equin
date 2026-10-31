import { useCallback, useMemo, type ReactNode } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  useOpenPane,
  type PaneExpandTarget,
} from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import {
  baseName,
  type ExplorerLocation,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import {
  FileBrowser,
  locationOf,
  locationParams,
  useLocationNavigator,
  useOpenInFiles,
  type LocationParams,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/web";

/**
 * `folder/<folder>[/<open file>]` — any host folder browsed beside whatever
 * surface named it (a folder path in an agent's message), with the whole
 * Files browser: the tree, the path bar, Up out of it, a file previewed
 * beside it. The location rides the route like `/files/at/…` (same params,
 * same encoding), so every folder is a link and back / forward are the
 * browser history.
 *
 * Its home is Files, but it opens BESIDE the surface holding the link, so
 * Expand ("Open in Files") is the one move that leaves the host — on the
 * location the pane is at.
 */
export const folderPeekPane = Pane.define({
  route: defineRoute({ id: "folder-peek", segment: "folder/:dir/:open?" }),
  app: fileExplorerApp,
  title: { useText: useFolderTitle },
  useResolve: false,
  // Opened from an app's bare root (the agent manager's home), it stays
  // beside that home rather than replacing it.
  companion: true,
  expand: { app: fileExplorerApp, useTarget: useOpenInFilesTarget },
  component: FolderPeek,
  // Tree plus the selected file's preview beside it.
  width: 960,
});

function useFolderTitle(params: { dir: string }): string {
  return baseName(params.dir);
}

function useOpenInFilesTarget(params: LocationParams): PaneExpandTarget {
  return { kind: "ready", target: useOpenInFiles(locationOf(params)) };
}

function FolderPeek(): ReactNode {
  const { dir, open } = folderPeekPane.useParams();
  const setParams = folderPeekPane.useSetParams();
  const openPane = useOpenPane();
  const location = useMemo(() => locationOf({ dir, open }), [dir, open]);
  // Another folder swaps this slot (a history entry, a fresh instance);
  // opening a file rewrites the params in place.
  const go = useCallback(
    (next: ExplorerLocation) =>
      openPane.to(folderPeekPane, locationParams(next), { mode: "swap" }),
    [openPane],
  );
  const navigator = useLocationNavigator(location, go, setParams);
  return (
    <PaneChrome pane={folderPeekPane}>
      <FileBrowser navigator={navigator} atSurfaceEdge={false} />
    </PaneChrome>
  );
}

/**
 * A folder's link: the folder browsed in a side pane pushed beside the
 * surface holding the link (⌘/middle-click opens it in a new browser tab).
 * `dir` is absolute.
 */
export function useFolderPeekTarget(): (dir: string) => LinkTarget {
  const openPane = useOpenPane();
  return useMemo(
    () => (dir: string) =>
      openPane.to(folderPeekPane, { dir }, { mode: "push" }),
    [openPane],
  );
}
