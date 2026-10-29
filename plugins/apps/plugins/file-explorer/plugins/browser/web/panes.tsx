import { HOME } from "@plugins/infra/plugins/host-account/core";
import { useCallback, useMemo, type ReactNode } from "react";
import {
  Pane,
  defineRoute,
  useOpenPane,
} from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import {
  baseName,
  decodeOpenParam,
  encodeOpenParam,
  type ExplorerLocation,
} from "../core";
import { FileBrowser } from "./components/file-browser";
import { useRoutedHistory, type ExplorerNavigator } from "./internal/navigator";

/**
 * `/files` — the home folder. The app's index pane: no URL of its own, so the
 * bare app root opens on home.
 */
export const filesHomePane = Pane.define({
  route: defineRoute({ id: "files-home", segment: "" }),
  app: fileExplorerApp,
  appIndex: true,
  title: "Home",
  component: FilesHome,
});

/**
 * `/files/at/<folder>[/<open file>]` — any folder, and optionally the file
 * previewed beside it. The folder is ONE encoded segment (`~%2FProjects`) so
 * the open file can follow it: written relative to the folder when it is
 * inside it (`README.md`), else in full. Every location is therefore a link,
 * and back / forward are the browser history:
 *
 * - another folder is a fresh route (`mode: "root"`, the full-pane screen
 *   stack): a new entry and a new instance, so the filter and selection start
 *   over;
 * - opening or closing a file rewrites this instance's params in place (still
 *   a history entry), so the listing keeps its scroll and expansion.
 */
export const filesAtPane = Pane.define({
  route: defineRoute({ id: "files-at", segment: "at/:dir/:open?" }),
  app: fileExplorerApp,
  title: { useText: useFolderTitle },
  useResolve: false,
  component: FilesAt,
});

function useFolderTitle(params: { dir: string }): string {
  return params.dir === HOME ? "Home" : baseName(params.dir);
}

/**
 * A location as route params: the folder, and the open file written relative
 * to it when it is inside it. The shape of `/files/at/…`, and of any pane
 * hosting a routed explorer elsewhere (the conversation's Files pane).
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

/** The location route params name. */
export function locationOf(params: LocationParams): ExplorerLocation {
  return {
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
 * params of its own (the index pane). Every move is a link.
 */
export function useLocationNavigator(
  location: ExplorerLocation,
  go: (next: ExplorerLocation) => LinkTarget,
  setParams: ((params: LocationParams) => void) | null,
): ExplorerNavigator {
  const { canBack, canForward } = useRoutedHistory(location);
  return useMemo(() => {
    return {
      location,
      to: (dir, open = null) => go({ dir, open }),
      fileTo: (open) => {
        const next = go({ dir: location.dir, open });
        if (!setParams) return next;
        // Same place, reached in place: this instance keeps its scroll and
        // expansion. A new browser tab simply boots the route.
        return {
          open: () => setParams(locationParams({ dir: location.dir, open })),
          href: () => next.href(),
        };
      },
      // Back / forward are the browser history, whichever pane holds the
      // location (any pane's back() walks the same history).
      back: () => filesAtPane.back(),
      forward: () => filesAtPane.forward(),
      canBack,
      canForward,
    };
  }, [location, go, setParams, canBack, canForward]);
}

/** The `/files/at/…` navigator: every folder is a fresh route in Files. */
function useFilesNavigator(
  location: ExplorerLocation,
  setParams: ((params: LocationParams) => void) | null,
): ExplorerNavigator {
  const openPane = useOpenPane();
  const go = useCallback(
    (next: ExplorerLocation): LinkTarget =>
      openPane.to(filesAtPane, locationParams(next), { mode: "root" }),
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
  return openPane.to(filesAtPane, locationParams(location), { mode: "root" });
}

const HOME_LOCATION: ExplorerLocation = { dir: HOME, open: null };

function FilesHome(): ReactNode {
  const navigator = useFilesNavigator(HOME_LOCATION, null);
  return <FileBrowser navigator={navigator} />;
}

function FilesAt(): ReactNode {
  const { dir, open } = filesAtPane.useParams();
  const setParams = filesAtPane.useSetParams();
  const location = useMemo(() => locationOf({ dir, open }), [dir, open]);
  const navigator = useFilesNavigator(location, setParams);
  return <FileBrowser navigator={navigator} />;
}

/**
 * The location the routed explorer on this surface is showing — for chrome
 * beside it (the Places sidebar marks the folder it is in). Home when no
 * folder route is open.
 */
export function useExplorerLocation(): ExplorerLocation {
  const entry = filesAtPane.useRouteEntry();
  if (entry === null) return HOME_LOCATION;
  return locationOf(entry.params);
}

/**
 * The routed explorer on `dir` — with `open` previewed beside it, when given —
 * as a link (a new history entry; ⌘/middle-click opens it in a new browser
 * tab).
 */
export function useExplorerFolderTarget(): (
  dir: string,
  open?: string,
) => LinkTarget {
  const openPane = useOpenPane();
  return (dir, open) =>
    openPane.to(filesAtPane, locationParams({ dir, open: open ?? null }), {
      mode: "root",
    });
}
