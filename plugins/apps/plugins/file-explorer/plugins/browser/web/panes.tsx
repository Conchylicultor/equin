import { HOME } from "@plugins/infra/plugins/host-account/core";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  useOpenPane,
} from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { BrowsableFileSystem } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import {
  baseName,
  decodeOpenParam,
  encodeOpenParam,
  type ExplorerLocation,
} from "../core";
import { FileBrowser } from "./components/file-browser";
import { useRoutedHistory, type ExplorerNavigator } from "./internal/navigator";
import { useHomeSystem } from "./internal/explorer-system";

/**
 * `/files` — the home folder of the file system this host serves first (the
 * computer's disk on the desktop, the browser's storage in the in-browser
 * demo). The app's index pane: no URL of its own, so the bare app root opens
 * on home. Its `;open` keyed param is the file previewed beside it
 * (`/files;open=notes.md`, written relative to home as in `/files/<fs>/at/…`)
 * — a view of this same mounted pane, so opening and closing a file never
 * remounts the listing (its scroll, expansion and the folder sizes it already
 * read stay on screen).
 */
export const filesHomePane = Pane.define({
  route: defineRoute({ id: "files-home", segment: ";open" }),
  app: fileExplorerApp,
  appIndex: true,
  title: "Home",
  component: FilesHome,
});

// `/files/<fs>/at/<folder>[/<open file>]` — any folder of a file system, and
// optionally the file previewed beside it, one pane per browsable system (the
// set is closed: `BrowsableFileSystem`). The folder is ONE encoded segment
// (`~%2FProjects`) so the open file can follow it: written relative to the
// folder when it is inside it (`README.md`), else in full. Every location is
// therefore a link, and back / forward are the browser history:
//
// - another folder is a fresh route (`mode: "root"`, the full-pane screen
//   stack): a new entry and a new instance, so the filter and selection start
//   over;
// - opening or closing a file rewrites this instance's params in place (still
//   a history entry), so the listing keeps its scroll and expansion.

/** `/files/computer/at/…` — a folder of the computer's disk. */
export const filesComputerAtPane = Pane.define({
  route: defineRoute({
    id: "files-computer-at",
    segment: "computer/at/:dir/:open?",
  }),
  app: fileExplorerApp,
  title: { useText: useFolderTitle },
  useResolve: false,
  component: FilesComputerAt,
});

/** `/files/browser/at/…` — a folder of the browser's storage. */
export const filesBrowserAtPane = Pane.define({
  route: defineRoute({
    id: "files-browser-at",
    segment: "browser/at/:dir/:open?",
  }),
  app: fileExplorerApp,
  title: { useText: useFolderTitle },
  useResolve: false,
  component: FilesBrowserAt,
});

/** The folder pane of each browsable file system. */
const FILES_AT_PANES = {
  computer: filesComputerAtPane,
  browser: filesBrowserAtPane,
} as const;

/** The folder pane of `fs`. */
export function filesAtPaneOf(fs: BrowsableFileSystem) {
  return FILES_AT_PANES[fs];
}

/**
 * `/files/at/<folder>[/<open file>]` — the address a folder had before Files
 * named the file system: always the computer's disk. Forwards to
 * `/files/computer/at/…`, REPLACING the history entry, so an old link still
 * opens and Back skips the address that only forwarded.
 */
export const filesAtLegacyPane = Pane.define({
  route: defineRoute({ id: "files-at", segment: "at/:dir/:open?" }),
  app: fileExplorerApp,
  title: { useText: useFolderTitle },
  useResolve: false,
  component: FilesAtLegacy,
});

function FilesAtLegacy(): ReactNode {
  const params = filesAtLegacyPane.useParams();
  const openPane = useOpenPane();
  const { dir, open } = params;
  useEffect(() => {
    openPane(
      filesComputerAtPane,
      open === undefined ? { dir } : { dir, open },
      { mode: "root", replace: true },
    );
  }, [openPane, dir, open]);
  return (
    <PaneChrome pane={filesAtLegacyPane}>
      <Loading variant="rows" />
    </PaneChrome>
  );
}

function useFolderTitle(params: { dir: string }): string {
  return params.dir === HOME ? "Home" : baseName(params.dir);
}

/**
 * A location as route params: the folder, and the open file written relative
 * to it when it is inside it. The shape of `/files/<fs>/at/…`, and of any
 * pane hosting a routed explorer elsewhere (the conversation's Files pane).
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
 * A routed explorer's navigator: where the explorer is comes from its pane's
 * route, a folder change is `go` (a new history entry — a fresh route or a
 * swapped slot, the host's call), and an open-file change rewrites the current
 * instance in place (`setParams`) — or goes, from a pane with no location
 * params of its own (the index pane). Every move is a link, and stays in the
 * location's file system.
 */
export function useLocationNavigator(
  location: ExplorerLocation,
  go: (next: ExplorerLocation) => LinkTarget,
  setParams: ((params: LocationParams) => void) | null,
): ExplorerNavigator {
  const { canBack, canForward } = useRoutedHistory(location);
  return useMemo(() => {
    const { fs } = location;
    return {
      location,
      to: (dir, open = null) => go({ fs, dir, open }),
      fileTo: (open) => {
        const next = go({ fs, dir: location.dir, open });
        if (!setParams) return next;
        // Same place, reached in place: this instance keeps its scroll and
        // expansion. A new browser tab simply boots the route.
        return {
          open: () =>
            setParams(locationParams({ fs, dir: location.dir, open })),
          href: () => next.href(),
        };
      },
      // Back / forward are the browser history, whichever pane holds the
      // location (any pane's back() walks the same history).
      back: () => filesComputerAtPane.back(),
      forward: () => filesComputerAtPane.forward(),
      canBack,
      canForward,
    };
  }, [location, go, setParams, canBack, canForward]);
}

/** The `/files/<fs>/at/…` navigator: every folder is a fresh route in Files. */
function useFilesNavigator(
  location: ExplorerLocation,
  setParams: ((params: LocationParams) => void) | null,
): ExplorerNavigator {
  const openPane = useOpenPane();
  const go = useCallback(
    (next: ExplorerLocation): LinkTarget =>
      openPane.to(filesAtPaneOf(next.fs), locationParams(next), {
        mode: "root",
      }),
    [openPane],
  );
  return useLocationNavigator(location, go, setParams);
}

/**
 * The Files app on `location`, as a link — the way out of an explorer hosted
 * elsewhere (a pane's "Open in Files"). From another app it hands the route
 * to Files; ⌘/middle-click opens it in a new browser tab.
 */
export function useOpenInFiles(location: ExplorerLocation): LinkTarget {
  const openPane = useOpenPane();
  return openPane.to(filesAtPaneOf(location.fs), locationParams(location), {
    mode: "root",
  });
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
      return <FilesHomeFolder fs={home.fs} />;
  }
}

function FilesHomeFolder({ fs }: { fs: BrowsableFileSystem }): ReactNode {
  const { open } = filesHomePane.useParams();
  const setHomeParams = filesHomePane.useSetParams();
  const location = useMemo(
    () => locationOf(fs, { dir: HOME, open }),
    [fs, open],
  );
  // Home's own params are the open file alone: the folder is the pane.
  const setParams = useCallback(
    (params: LocationParams) => setHomeParams({ open: params.open }),
    [setHomeParams],
  );
  const navigator = useFilesNavigator(location, setParams);
  return <FileBrowser navigator={navigator} />;
}

function FilesComputerAt(): ReactNode {
  const { dir, open } = filesComputerAtPane.useParams();
  const setParams = filesComputerAtPane.useSetParams();
  return <FilesAt fs="computer" dir={dir} open={open} setParams={setParams} />;
}

function FilesBrowserAt(): ReactNode {
  const { dir, open } = filesBrowserAtPane.useParams();
  const setParams = filesBrowserAtPane.useSetParams();
  return <FilesAt fs="browser" dir={dir} open={open} setParams={setParams} />;
}

function FilesAt({
  fs,
  dir,
  open,
  setParams,
}: {
  fs: BrowsableFileSystem;
  dir: string;
  open: string | undefined;
  setParams: (params: LocationParams) => void;
}): ReactNode {
  const location = useMemo(
    () => locationOf(fs, { dir, open }),
    [fs, dir, open],
  );
  const navigator = useFilesNavigator(location, setParams);
  return <FileBrowser navigator={navigator} />;
}

/**
 * The location the routed explorer on this surface is showing — for chrome
 * beside it (the Places sidebar marks the folder it is in). `null` on the
 * index pane (home of the home system, which the sidebar reads itself).
 */
export function useExplorerLocation(): ExplorerLocation | null {
  const computer = filesComputerAtPane.useRouteEntry();
  const browser = filesBrowserAtPane.useRouteEntry();
  if (computer !== null) return locationOf("computer", computer.params);
  if (browser !== null) return locationOf("browser", browser.params);
  return null;
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
    openPane.to(
      filesAtPaneOf(fs),
      locationParams({ fs, dir, open: open ?? null }),
      { mode: "root" },
    );
}
