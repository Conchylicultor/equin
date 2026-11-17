import { HOME } from "@plugins/infra/plugins/host-account/core";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  useOpenPane,
  usePaneStore,
  PaneMessage,
  type AnyPane,
  type PaneExpandTarget,
} from "@plugins/primitives/plugins/pane/web";
import {
  PLAIN_GESTURE,
  type Activation,
  type LinkTarget,
} from "@plugins/primitives/plugins/link-gesture/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import { useConfigResult } from "@plugins/config_v2/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  ResourceErrorInline,
  foldResource,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  isBrowsableFileSystem,
  type BrowsableFileSystem,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import {
  baseName,
  filesConfig,
  decodeOpenParam,
  encodeOpenParam,
  parentPath,
  type ExplorerLocation,
} from "../core";
import { FileBrowserBody } from "./components/file-browser";
import {
  FileBrowserPath,
  FileBrowserProvider,
  PendingFileBrowserProvider,
} from "./components/file-browser-header";
import {
  FilePreviewPane,
  FilePreviewTitle,
  PendingFilePreviewPane,
} from "./components/file-preview";
import { FileBrowserHeader, FilePreviewHeader } from "./slots";
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

// Not `at/…`: `at` spells an embed's place on the page URL (the embed tail,
// `pane` CLAUDE.md), and the Demo's former `at/:url*` pane carried any
// `/files/at/…` loaded cold off to the Demo. The id is the one this pane had
// at `/files/at/…`, so a saved route still restores.
const folderRoute = defineRoute({ id: "files-at", segment: "browse/:dir;fs" });

/** `/files/browse/<folder>[;fs=<system>]` — any folder of a browsable file system. */
export const filesFolderPane = Pane.define({
  route: folderRoute,
  app: fileExplorerApp,
  // The header is the shared browser header (back / forward / up, the path
  // bar as the title, the filter, the toggles).
  title: { useText: useFolderTitle, component: FileBrowserPath },
  actions: FileBrowserHeader,
  useResolve: false,
  component: FilesFolder,
});

/** `…/preview/<open file>` — the file open in the folder, previewed beside it. */
export const filesPreviewPane = Pane.define({
  route: defineRoute({
    id: "files-preview",
    segment: "preview/:open",
    parent: folderRoute,
  }),
  app: fileExplorerApp,
  // The header is the shared preview header (the file's title, then its
  // renderer tabs and Open with default app).
  title: { useText: usePreviewTitle, component: FilePreviewTitle },
  actions: FilePreviewHeader,
  // Promoted, the preview re-roots onto the very folder + preview it already
  // is (it only ever opens beside its folder): a button that does nothing. Its
  // Expand is the renderer's own, when it has one (FilePreviewPane).
  chrome: { promote: false },
  useResolve: false,
  component: FilesPreview,
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
    locationTarget(openPane, { fs, dir, open }, { replace: true }).open(
      PLAIN_GESTURE,
    );
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

/** The location Files' route params name, in `fs` (`open` relative to `dir`). */
function locationOf(
  fs: BrowsableFileSystem,
  params: { dir: string; open?: string },
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
 * `preview-file/<file>[;fs=<system>]` — a file previewed in a column of its
 * own beside the browser that opened it, for a browser hosted inside some
 * other pane (the conversation's Files pane, a folder peek). Files' own folder
 * column chains its preview under it instead (`filesPreviewPane`), so a root
 * open rebuilds the pair; this one names its whole place itself — the file in
 * display form (`~/…`), `;fs` absent for the computer's disk — so it reads
 * nothing from the column to its left and serves any host.
 *
 * Its home is Files, but it opens BESIDE the browser holding the file, so
 * Expand ("Open in Files") is the move that leaves the host — unless the
 * file's renderer has a fuller view of its own (Open in Sonata), which wins.
 */
export const filePreviewBesidePane = Pane.define({
  route: defineRoute({
    id: "files-preview-beside",
    segment: "preview-file/:path;fs",
  }),
  app: fileExplorerApp,
  title: {
    useText: usePreviewBesideTitle,
    component: FilePreviewTitle,
  },
  actions: FilePreviewHeader,
  useResolve: false,
  // Opened from an app's bare root, it stays beside that home rather than
  // replacing it (like the folder peek it is opened from).
  companion: true,
  expand: { app: fileExplorerApp, useTarget: usePreviewBesideExpand },
  component: FilePreviewBeside,
});

function usePreviewBesideTitle(params: { path: string }): string {
  return baseName(params.path);
}

function usePreviewBesideExpand(params: {
  path: string;
  fs?: string;
}): PaneExpandTarget {
  const fs = systemOf(params.fs);
  const dir = params.path === HOME ? null : parentPath(params.path, HOME);
  const target = useOpenInFiles({
    fs: fs ?? "computer",
    dir: dir ?? "/",
    open: params.path,
  });
  return fs === null || dir === null
    ? { kind: "none" }
    : { kind: "ready", target };
}

function FilePreviewBeside(): ReactNode {
  const { path, fs: fsParam } = filePreviewBesidePane.useParams();
  const fs = systemOf(fsParam);
  if (fs === null) {
    return (
      <PendingFilePreviewPane
        pane={filePreviewBesidePane}
        name={baseName(path)}
      >
        <Placeholder>No file system is called “{fsParam}”</Placeholder>
      </PendingFilePreviewPane>
    );
  }
  return <FilePreviewPane pane={filePreviewBesidePane} fs={fs} path={path} />;
}

/**
 * Opening and closing the file previewed in the column beside a browser: open
 * is `openTarget` (a push — appending the column, or replacing the one open
 * there, so the row's swap motion plays), close closes the column `opened`
 * names on this surface's store (an embedded surface is not the live one) —
 * as a link, the folder on its own (`here`).
 */
function useColumnFileTo(
  openTarget: (open: string) => LinkTarget,
  opened: { pane: AnyPane; instanceId: number } | null,
  here: () => LinkTarget,
): (open: string | null) => Activation {
  const store = usePaneStore();
  return useCallback(
    (open: string | null): Activation => {
      if (open !== null) return openTarget(open);
      return {
        open: (gesture) => {
          if (opened !== null) {
            store.close(opened.pane._internal, opened.instanceId, gesture);
          }
        },
        href: () => here().href(),
      };
    },
    [openTarget, opened, here, store],
  );
}

/**
 * The navigator of a browser hosted inside some pane, its open file
 * previewed in the column beside it (`filePreviewBesidePane`): the folder
 * comes from the host (`dir`, moved through `go` — a new history entry, a
 * fresh route or a swapped slot, the host's call), the open file from the
 * preview column this pane opened. Every move is a link, and stays in `fs`.
 */
export function useBesidePreviewNavigator(
  fs: BrowsableFileSystem,
  dir: string,
  go: (next: ExplorerLocation) => LinkTarget,
): ExplorerNavigator {
  const entry = filePreviewBesidePane.useOpenedHere();
  // Only a preview of this file system counts as this browser's open file.
  const opened =
    entry !== null && systemOf(entry.params.fs) === fs ? entry : null;
  const openPath = opened?.params.path ?? null;
  const location = useMemo(
    () => ({ fs, dir, open: openPath }),
    [fs, dir, openPath],
  );
  const openPane = useOpenPane();
  const openTarget = useCallback(
    (open: string) =>
      openPane.to(
        filePreviewBesidePane,
        fs === "computer" ? { path: open } : { path: open, fs },
        { mode: "push" },
      ),
    [openPane, fs],
  );
  const openedId = opened?.instanceId;
  const openedRef = useMemo(
    () =>
      openedId === undefined
        ? null
        : { pane: filePreviewBesidePane, instanceId: openedId },
    [openedId],
  );
  const here = useCallback(() => go({ fs, dir, open: null }), [go, fs, dir]);
  const fileTo = useColumnFileTo(openTarget, openedRef, here);
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
      return (
        <PaneChrome pane={filesHomePane}>
          <PaneMessage>
            <Placeholder>There are no files to browse here</Placeholder>
          </PaneMessage>
        </PaneChrome>
      );
    case "ready":
      return <FilesHomeForward fs={home.fs} />;
  }
}

/**
 * Home: the configured start folder (`filesConfig`'s `startFolder`, `~`
 * unless set), in the home system — forwarded to that folder's own address.
 */
function FilesHomeForward({ fs }: { fs: BrowsableFileSystem }): ReactNode {
  const config = useConfigResult(filesConfig);
  return foldResource(config, {
    loading: () => <Loading variant="rows" />,
    error: (error) => (
      <ResourceErrorInline
        variant="block"
        subject="the Files start folder"
        error={error}
        refetch={config.refetch}
      />
    ),
    ready: ({ startFolder }) => (
      <FilesStartForward fs={fs} startFolder={startFolder} />
    ),
  });
}

function FilesStartForward({
  fs,
  startFolder,
}: {
  fs: BrowsableFileSystem;
  startFolder: string;
}): ReactNode {
  const openPane = useOpenPane();
  useEffect(() => {
    openPane(filesFolderPane, folderParams(fs, startFolder), {
      mode: "root",
      replace: true,
    });
  }, [openPane, fs, startFolder]);
  return <Loading variant="rows" />;
}

function FilesFolder(): ReactNode {
  const { dir, fs: fsParam } = filesFolderPane.useParams();
  const fs = systemOf(fsParam);
  if (fs === null) {
    return (
      <PendingFileBrowserProvider>
        <PaneChrome pane={filesFolderPane}>
          <PaneMessage>
            <Placeholder>No file system is called “{fsParam}”</Placeholder>
          </PaneMessage>
        </PaneChrome>
      </PendingFileBrowserProvider>
    );
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
  const go = useCallback(
    (next: ExplorerLocation) => locationTarget(openPane, next),
    [openPane],
  );
  const openTarget = useCallback(
    (open: string) =>
      openPane.to(
        filesPreviewPane,
        { ...folderParams(fs, dir), open: encodeOpenParam(dir, open) },
        { mode: "push" },
      ),
    [openPane, fs, dir],
  );
  const openedId = opened?.instanceId;
  const openedRef = useMemo(
    () =>
      openedId === undefined
        ? null
        : { pane: filesPreviewPane, instanceId: openedId },
    [openedId],
  );
  const here = useCallback(() => go({ fs, dir, open: null }), [go, fs, dir]);
  const fileTo = useColumnFileTo(openTarget, openedRef, here);
  const navigator = useRoutedNavigator(location, go, fileTo);
  // The provider and the chrome stay mounted while the preview beside this
  // column opens, closes or changes file: only the navigator's value moves.
  return (
    <FileBrowserProvider navigator={navigator} preview="pane">
      <PaneChrome pane={filesFolderPane}>
        <FileBrowserBody />
      </PaneChrome>
    </FileBrowserProvider>
  );
}

function FilesPreview(): ReactNode {
  const { open } = filesPreviewPane.useParams();
  const folder = filesFolderPane.useEnclosing();
  if (folder === null) {
    // Only ever opened beside its folder (its declared parent).
    throw new Error("files-preview: no folder column to its left");
  }
  const path = decodeOpenParam(folder.params.dir, open);
  const fs = systemOf(folder.params.fs);
  if (fs === null) {
    return (
      <PendingFilePreviewPane pane={filesPreviewPane} name={baseName(path)}>
        <Placeholder>No file system is called “{folder.params.fs}”</Placeholder>
      </PendingFilePreviewPane>
    );
  }
  return <FilePreviewPane pane={filesPreviewPane} fs={fs} path={path} />;
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
