import { HOME } from "@plugins/infra/plugins/host-account/core";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  useOpenPane,
  usePaneStore,
} from "@plugins/primitives/plugins/pane/web";
import type {
  Activation,
  LinkTarget,
} from "@plugins/primitives/plugins/link-gesture/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  isBrowsableFileSystem,
  type BrowsableFileSystem,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import {
  baseName,
  decodeOpenParam,
  encodeOpenParam,
  type ExplorerLocation,
} from "../core";
import { FileBrowser, FilePreview } from "./components/file-browser";
import { useRoutedHistory, type ExplorerNavigator } from "./internal/navigator";
import { useHomeSystem } from "./internal/explorer-system";

// Files is a Miller row: a folder column, and the file open in it as a
// column of its own beside it —
//
//   /files/browse/<folder>[;fs=<system>][/preview/<open file>]
//
// The folder is ONE encoded segment (`~%2FProjects`); the open file is
// written relative to it when it is inside it (`README.md`), else in full.
// `;fs` names the file system — absent, the computer's disk. Every location is
// therefore a link, and back / forward are the browser history:
//
// - another folder is a fresh route (`mode: "root"`): a new entry and a new
//   folder column, so the filter and selection start over;
// - opening a file pushes the preview column beside the folder's (replacing
//   the one open there), closing it closes that column — the folder column is
//   never remounted, so the listing keeps its scroll and expansion, and the
//   preview slides in and out with the row's column motion.

// Not `at/…`: a URL is matched against every app's panes, and the Demo's
// `at/:url*` claims any `/files/at/…` loaded cold. The id is the one this
// pane had at `/files/at/…`, so a saved route still restores.
const folderRoute = defineRoute({ id: "files-at", segment: "browse/:dir;fs" });

/** `/files/browse/<folder>[;fs=<system>]` — any folder of a browsable file system. */
export const filesFolderPane = Pane.define({
  route: folderRoute,
  app: fileExplorerApp,
  title: { useText: useFolderTitle },
  useResolve: false,
  component: FilesFolder,
  // The mockup's 1 : 1.1 split beside an open file; alone, the leaf column
  // fills the row.
  width: 560,
});

/** `…/preview/<open file>` — the file open in the folder, previewed beside it. */
export const filesPreviewPane = Pane.define({
  route: defineRoute({
    id: "files-preview",
    segment: "preview/:open",
    parent: folderRoute,
  }),
  app: fileExplorerApp,
  title: { useText: usePreviewTitle },
  useResolve: false,
  component: FilesPreview,
  width: 600,
});

/**
 * `/files` — the app's index pane: Files opens on the home folder of the file
 * system this host serves first (the computer's disk on the desktop, the
 * browser's storage in the in-browser demo), forwarded to that folder's own
 * address once the system is known — REPLACING the history entry, so Back
 * skips the bare root that only forwarded.
 */
export const filesHomePane = Pane.define({
  route: defineRoute({ id: "files-home", segment: "" }),
  app: fileExplorerApp,
  appIndex: true,
  title: "Home",
  component: FilesHome,
});

/**
 * `/files/<fs>/at/<folder>[/<open file>]` — the address a location had while
 * Files kept one folder pane per file system. Forwards to `/files/browse/…`,
 * REPLACING the history entry, so an old link still opens and Back skips the
 * address that only forwarded.
 */
export const filesComputerAtLegacyPane = Pane.define({
  route: defineRoute({
    id: "files-computer-at",
    segment: "computer/at/:dir/:open?",
  }),
  app: fileExplorerApp,
  title: { useText: useFolderTitle },
  useResolve: false,
  component: FilesComputerAtLegacy,
});

export const filesBrowserAtLegacyPane = Pane.define({
  route: defineRoute({
    id: "files-browser-at",
    segment: "browser/at/:dir/:open?",
  }),
  app: fileExplorerApp,
  title: { useText: useFolderTitle },
  useResolve: false,
  component: FilesBrowserAtLegacy,
});

function FilesComputerAtLegacy(): ReactNode {
  const params = filesComputerAtLegacyPane.useParams();
  return (
    <PaneChrome pane={filesComputerAtLegacyPane}>
      <LegacyForward location={locationOf("computer", params)} />
    </PaneChrome>
  );
}

function FilesBrowserAtLegacy(): ReactNode {
  const params = filesBrowserAtLegacyPane.useParams();
  return (
    <PaneChrome pane={filesBrowserAtLegacyPane}>
      <LegacyForward location={locationOf("browser", params)} />
    </PaneChrome>
  );
}

function LegacyForward({
  location,
}: {
  location: ExplorerLocation;
}): ReactNode {
  const openPane = useOpenPane();
  const { fs, dir, open } = location;
  useEffect(() => {
    locationTarget(openPane, { fs, dir, open }, { replace: true }).open();
  }, [openPane, fs, dir, open]);
  return <Loading variant="rows" />;
}

function useFolderTitle(params: { dir: string }): string {
  return params.dir === HOME ? "Home" : baseName(params.dir);
}

function usePreviewTitle(params: { dir: string; open: string }): string {
  return baseName(decodeOpenParam(params.dir, params.open));
}

/** The folder pane's params: the folder, and its system unless the computer's disk. */
interface FolderParams {
  dir: string;
  fs?: string;
}

function folderParams(fs: BrowsableFileSystem, dir: string): FolderParams {
  return fs === "computer" ? { dir } : { dir, fs };
}

/** The file system `;fs` names: none is the computer's disk. */
function systemOf(fs: string | undefined): BrowsableFileSystem | null {
  if (fs === undefined) return "computer";
  return isBrowsableFileSystem(fs) ? fs : null;
}

type OpenPaneFn = ReturnType<typeof useOpenPane>;

/**
 * Files on `location`, from scratch: its folder column, with the open file's
 * preview column beside it when there is one (built from the preview's
 * declared parent).
 */
function locationTarget(
  openPane: OpenPaneFn,
  location: ExplorerLocation,
  opts: { replace?: boolean } = {},
): LinkTarget {
  const folder = folderParams(location.fs, location.dir);
  return location.open === null
    ? openPane.to(filesFolderPane, folder, { mode: "root", ...opts })
    : openPane.to(
        filesPreviewPane,
        { ...folder, open: encodeOpenParam(location.dir, location.open) },
        { mode: "root", ...opts },
      );
}

/**
 * A location as route params: the folder, and the open file written relative
 * to it when it is inside it — the shape of a pane hosting a routed explorer
 * with its preview inside it (the conversation's Files pane, a folder peek).
 */
export interface LocationParams {
  dir: string;
  open?: string;
}

/** The route params of a location. */
export function locationParams(location: ExplorerLocation): LocationParams {
  return location.open === null
    ? { dir: location.dir }
    : { dir: location.dir, open: encodeOpenParam(location.dir, location.open) };
}

/** The location route params name, in `fs`. */
export function locationOf(
  fs: BrowsableFileSystem,
  params: LocationParams,
): ExplorerLocation {
  return {
    fs,
    dir: params.dir,
    open:
      params.open === undefined
        ? null
        : decodeOpenParam(params.dir, params.open),
  };
}

/**
 * A routed explorer's navigator, for a pane that previews the open file
 * inside itself: where the explorer is comes from its pane's route, a folder
 * change is `go` (a new history entry — a fresh route or a swapped slot, the
 * host's call), and an open-file change rewrites the current instance in
 * place (`setParams`). Every move is a link, and stays in the location's file
 * system.
 */
export function useLocationNavigator(
  location: ExplorerLocation,
  go: (next: ExplorerLocation) => LinkTarget,
  setParams: (params: LocationParams) => void,
): ExplorerNavigator {
  const fileTo = useCallback(
    (open: string | null): Activation => {
      const next = { fs: location.fs, dir: location.dir, open };
      // Same place, reached in place: this instance keeps its scroll and
      // expansion. A new browser tab simply boots the route.
      return {
        open: () => setParams(locationParams(next)),
        href: () => go(next).href(),
      };
    },
    [location.fs, location.dir, go, setParams],
  );
  return useRoutedNavigator(location, go, fileTo);
}

/**
 * The navigator every routed explorer shares: folder moves through `go`,
 * file moves through `fileTo`, back / forward the browser history.
 */
function useRoutedNavigator(
  location: ExplorerLocation,
  go: (next: ExplorerLocation) => LinkTarget,
  fileTo: (open: string | null) => Activation,
): ExplorerNavigator {
  const { canBack, canForward } = useRoutedHistory(location);
  return useMemo(
    () => ({
      location,
      to: (dir, open = null) => go({ fs: location.fs, dir, open }),
      fileTo,
      // Back / forward are the browser history, whichever pane holds the
      // location (any pane's back() walks the same history).
      back: () => filesFolderPane.back(),
      forward: () => filesFolderPane.forward(),
      canBack,
      canForward,
    }),
    [location, go, fileTo, canBack, canForward],
  );
}

/**
 * The Files app on `location`, as a link — the way out of an explorer hosted
 * elsewhere (a pane's "Open in Files"). From another app it hands the route
 * to Files; ⌘/middle-click opens it in a new browser tab.
 */
export function useOpenInFiles(location: ExplorerLocation): LinkTarget {
  const openPane = useOpenPane();
  return locationTarget(openPane, location);
}

function FilesHome(): ReactNode {
  const home = useHomeSystem();
  switch (home.kind) {
    case "pending":
      return <Loading variant="rows" />;
    case "failed":
      return (
        <ResourceErrorInline
          variant="block"
          subject="the file systems here"
          error={home.error}
          refetch={home.refetch}
        />
      );
    case "none":
      return <Placeholder>There are no files to browse here</Placeholder>;
    case "ready":
      return <FilesHomeForward fs={home.fs} />;
  }
}

function FilesHomeForward({ fs }: { fs: BrowsableFileSystem }): ReactNode {
  const openPane = useOpenPane();
  useEffect(() => {
    openPane(filesFolderPane, folderParams(fs, HOME), {
      mode: "root",
      replace: true,
    });
  }, [openPane, fs]);
  return <Loading variant="rows" />;
}

function FilesFolder(): ReactNode {
  const { dir, fs: fsParam } = filesFolderPane.useParams();
  const fs = systemOf(fsParam);
  if (fs === null) {
    return <Placeholder>No file system is called “{fsParam}”</Placeholder>;
  }
  return <FilesFolderBrowser fs={fs} dir={dir} />;
}

/**
 * The folder column: the listing, with the file opened from it previewed in
 * the column beside it (`filesPreviewPane`). Opening a file pushes that
 * column — replacing the one open, so the row's swap motion plays — and
 * closing it closes that column; this one stays mounted throughout.
 */
function FilesFolderBrowser({
  fs,
  dir,
}: {
  fs: BrowsableFileSystem;
  dir: string;
}): ReactNode {
  const opened = filesPreviewPane.useOpenedHere();
  const openParam = opened?.params.open;
  const location = useMemo(
    () => locationOf(fs, { dir, open: openParam }),
    [fs, dir, openParam],
  );
  const openPane = useOpenPane();
  const store = usePaneStore();
  const go = useCallback(
    (next: ExplorerLocation) => locationTarget(openPane, next),
    [openPane],
  );
  const openedId = opened?.instanceId;
  const fileTo = useCallback(
    (open: string | null): Activation => {
      if (open !== null) {
        return openPane.to(
          filesPreviewPane,
          { ...folderParams(fs, dir), open: encodeOpenParam(dir, open) },
          { mode: "push" },
        );
      }
      // Closing: the preview column this one opened goes (on this surface's
      // store — an embedded Files is not the live one); as a link, it is
      // this folder on its own.
      const here = go({ fs, dir, open: null });
      return {
        open: () => {
          if (openedId !== undefined) {
            store.close(filesPreviewPane._internal, openedId);
          }
        },
        href: here.href,
      };
    },
    [openPane, store, go, fs, dir, openedId],
  );
  const navigator = useRoutedNavigator(location, go, fileTo);
  return <FileBrowser navigator={navigator} preview="pane" />;
}

function FilesPreview(): ReactNode {
  const { open } = filesPreviewPane.useParams();
  const folder = filesFolderPane.useEnclosing();
  const close = filesPreviewPane.useClose();
  if (folder === null) {
    // Only ever opened beside its folder (its declared parent).
    throw new Error("files-preview: no folder column to its left");
  }
  const fs = systemOf(folder.params.fs);
  if (fs === null) {
    return (
      <Placeholder>No file system is called “{folder.params.fs}”</Placeholder>
    );
  }
  return (
    <FilePreview
      fs={fs}
      path={decodeOpenParam(folder.params.dir, open)}
      onClose={close}
    />
  );
}

/**
 * The location the routed explorer on this surface is showing — for chrome
 * beside it (the Places sidebar marks the folder it is in). `null` while the
 * surface shows no folder (the index, forwarding to home).
 */
export function useExplorerLocation(): ExplorerLocation | null {
  const folder = filesFolderPane.useRouteEntry();
  const preview = filesPreviewPane.useRouteEntry();
  if (folder === null) return null;
  const fs = systemOf(folder.params.fs);
  if (fs === null) return null;
  return locationOf(fs, {
    dir: folder.params.dir,
    open: preview?.params.open,
  });
}

/**
 * The routed explorer on `dir` of `fs` — with `open` previewed beside it,
 * when given — as a link (a new history entry; ⌘/middle-click opens it in a
 * new browser tab).
 */
export function useExplorerFolderTarget(): (
  fs: BrowsableFileSystem,
  dir: string,
  open?: string,
) => LinkTarget {
  const openPane = useOpenPane();
  return (fs, dir, open) =>
    locationTarget(openPane, { fs, dir, open: open ?? null });
}
