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
  filePreviewBesidePane,
  useBesidePreviewNavigator,
  useOpenInFiles,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/web";

/**
 * `folder/<folder>[;fs=<system>]` — any folder of a file system browsed beside
 * whatever surface named it (a folder path in an agent's message, a folder
 * crumb of a file's path bar), with the whole Files browser: the tree, the
 * path bar, Up out of it, and a file opened from it previewed in a column of
 * its own beside it (the browser's `filePreviewBesidePane`). The folder rides
 * the route like `/files/browse/…` (same encoding), so every folder is a link
 * and back / forward are the browser history. `;fs` names the file system; absent, it is the computer's disk —
 * the address every folder link had before the pane named one, so an old
 * link still opens.
 *
 * Its home is Files, but it opens BESIDE the surface holding the link, so
 * Expand ("Open in Files") is the one move that leaves the host — on the
 * location the pane is at.
 */
export const folderPeekPane = Pane.define({
  route: defineRoute({ id: "folder-peek", segment: "folder/:dir;fs" }),
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

/** The pane's route params of `location`: its folder and system. */
function routeParamsOf(location: ExplorerLocation): FolderRouteParams {
  // The computer's disk is the address without `;fs` (see the pane).
  return location.fs === "computer"
    ? { dir: location.dir }
    : { dir: location.dir, fs: location.fs };
}

interface FolderRouteParams {
  dir: string;
  fs?: string;
}

/** The file system `;fs` names: none is the computer's disk. */
function systemOf(fs: string | undefined): BrowsableFileSystem | null {
  if (fs === undefined) return "computer";
  return isBrowsableFileSystem(fs) ? fs : null;
}

function useOpenInFilesTarget(params: FolderRouteParams): PaneExpandTarget {
  const fs = systemOf(params.fs);
  // The file previewed in the column this pane opened, if any.
  const opened = filePreviewBesidePane.useOpenedHere();
  const target = useOpenInFiles({
    fs: fs ?? "computer",
    dir: params.dir,
    open:
      opened !== null && systemOf(opened.params.fs) === fs
        ? opened.params.path
        : null,
  });
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
  const { dir } = folderPeekPane.useParams();
  const openPane = useOpenPane();
  // Another folder swaps this slot (a history entry, a fresh instance);
  // opening a file pushes its preview column beside this one.
  const go = useCallback(
    (next: ExplorerLocation) =>
      openPane.to(folderPeekPane, routeParamsOf(next), { mode: "swap" }),
    [openPane],
  );
  const navigator = useBesidePreviewNavigator(fs, dir, go);
  return (
    <FileBrowserProvider navigator={navigator} preview="pane">
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
