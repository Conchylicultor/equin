import { useCallback, useMemo, type ReactNode } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  useOpenPane,
  type PaneExpandTarget,
  PaneMessage,
} from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import {
  isBrowsableFileSystem,
  type BrowsableFileSystem,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  baseName,
  type ExplorerLocation,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/core";
import {
  FileBrowserBody,
  FileBrowserHeader,
  FileBrowserPath,
  FileBrowserProvider,
  PendingFileBrowserProvider,
  locationOf,
  locationParams,
  useLocationNavigator,
  useOpenInFiles,
  type LocationParams,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/web";

/**
 * `folder/<folder>[/<open file>][;fs=<system>]` — any folder of a file system
 * browsed beside whatever surface named it (a folder path in an agent's
 * message, a folder crumb of a file's path bar), with the whole Files
 * browser: the tree, the path bar, Up out of it, a file previewed beside it.
 * The location rides the route like `/files/<fs>/at/…` (same params, same
 * encoding), so every folder is a link and back / forward are the browser
 * history. `;fs` names the file system; absent, it is the computer's disk —
 * the address every folder link had before the pane named one, so an old
 * link still opens.
 *
 * Its home is Files, but it opens BESIDE the surface holding the link, so
 * Expand ("Open in Files") is the one move that leaves the host — on the
 * location the pane is at.
 */
export const folderPeekPane = Pane.define({
  route: defineRoute({ id: "folder-peek", segment: "folder/:dir/:open?;fs" }),
  app: fileExplorerApp,
  // The header is the Files browser's own (back / forward / up, the path bar
  // as the title, the filter, the toggles).
  title: { useText: useFolderTitle, component: FileBrowserPath },
  actions: FileBrowserHeader,
  useResolve: false,
  // Opened from an app's bare root (the agent manager's home), it stays
  // beside that home rather than replacing it.
  companion: true,
  expand: { app: fileExplorerApp, useTarget: useOpenInFilesTarget },
  component: FolderPeek,
});

function useFolderTitle(params: { dir: string }): string {
  return baseName(params.dir);
}

/** The pane's route params of `location`: its folder, file and system. */
function routeParamsOf(location: ExplorerLocation): FolderRouteParams {
  const params = locationParams(location);
  // The computer's disk is the address without `;fs` (see the pane).
  return location.fs === "computer" ? params : { ...params, fs: location.fs };
}

type FolderRouteParams = LocationParams & { fs?: string };

/** The file system `;fs` names: none is the computer's disk. */
function systemOf(fs: string | undefined): BrowsableFileSystem | null {
  if (fs === undefined) return "computer";
  return isBrowsableFileSystem(fs) ? fs : null;
}

function useOpenInFilesTarget(params: FolderRouteParams): PaneExpandTarget {
  const fs = systemOf(params.fs);
  const target = useOpenInFiles(locationOf(fs ?? "computer", params));
  return fs === null ? { kind: "none" } : { kind: "ready", target };
}

function FolderPeek(): ReactNode {
  const { fs } = folderPeekPane.useParams();
  const system = systemOf(fs);
  if (system === null) {
    return (
      <PendingFileBrowserProvider>
        <PaneChrome pane={folderPeekPane}>
          <PaneMessage>
            <Placeholder tone="error">
              {`"${fs}" is not a file system this app knows.`}
            </Placeholder>
          </PaneMessage>
        </PaneChrome>
      </PendingFileBrowserProvider>
    );
  }
  return <FolderPeekBrowser fs={system} />;
}

function FolderPeekBrowser({ fs }: { fs: BrowsableFileSystem }): ReactNode {
  const { dir, open } = folderPeekPane.useParams();
  const setParams = folderPeekPane.useSetParams();
  const openPane = useOpenPane();
  const location = useMemo(
    () => locationOf(fs, { dir, open }),
    [fs, dir, open],
  );
  // Another folder swaps this slot (a history entry, a fresh instance);
  // opening a file rewrites the params in place.
  const go = useCallback(
    (next: ExplorerLocation) =>
      openPane.to(folderPeekPane, routeParamsOf(next), { mode: "swap" }),
    [openPane],
  );
  const setLocation = useCallback(
    (next: LocationParams) =>
      setParams(fs === "computer" ? next : { ...next, fs }),
    [setParams, fs],
  );
  const navigator = useLocationNavigator(location, go, setLocation);
  return (
    <FileBrowserProvider navigator={navigator}>
      <PaneChrome pane={folderPeekPane}>
        <FileBrowserBody />
      </PaneChrome>
    </FileBrowserProvider>
  );
}

/**
 * A folder's link: the folder browsed in a side pane pushed beside the
 * surface holding the link (⌘/middle-click opens it in a new browser tab).
 * `dir` is in `fs`'s absolute spelling.
 */
export function useFolderPeekTarget(): (
  fs: BrowsableFileSystem,
  dir: string,
) => LinkTarget {
  const openPane = useOpenPane();
  return useMemo(
    () => (fs: BrowsableFileSystem, dir: string) =>
      openPane.to(folderPeekPane, routeParamsOf({ fs, dir, open: null }), {
        mode: "push",
      }),
    [openPane],
  );
}

/**
 * Where a folder of `fs` swaps in, from a pane beside it (a file's path bar):
 * the folder pane at that folder.
 */
export function folderLocationParams(
  fs: BrowsableFileSystem,
  dir: string,
): FolderRouteParams {
  return routeParamsOf({ fs, dir, open: null });
}
