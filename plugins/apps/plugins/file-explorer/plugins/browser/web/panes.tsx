import { useMemo, type ReactNode } from "react";
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
  HOME,
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

/** The URL params of a location. */
function paramsOf(location: ExplorerLocation): { dir: string; open?: string } {
  return location.open === null
    ? { dir: location.dir }
    : { dir: location.dir, open: encodeOpenParam(location.dir, location.open) };
}

/**
 * The route navigator: where the explorer is comes from the URL, a folder
 * change opens a new route, and an open-file change rewrites the current one
 * (`setParams`) — or opens one, from the index pane, which has no params.
 * Every move is a link: its `href` is the location's own `/files/at/…` route.
 */
function useRouteNavigator(
  location: ExplorerLocation,
  setParams: ((params: { dir: string; open?: string }) => void) | null,
): ExplorerNavigator {
  const openPane = useOpenPane();
  const { canBack, canForward } = useRoutedHistory(location);
  return useMemo(() => {
    const go = (next: ExplorerLocation): LinkTarget =>
      openPane.to(filesAtPane, paramsOf(next), { mode: "root" });
    return {
      location,
      to: (dir, open = null) => go({ dir, open }),
      fileTo: (open) => {
        const next = go({ dir: location.dir, open });
        if (!setParams) return next;
        // Same place, reached in place: this instance keeps its scroll and
        // expansion. A new browser tab simply boots the route.
        return {
          open: () => setParams(paramsOf({ dir: location.dir, open })),
          href: () => next.href(),
        };
      },
      back: () => filesAtPane.back(),
      forward: () => filesAtPane.forward(),
      canBack,
      canForward,
    };
  }, [location, setParams, openPane, canBack, canForward]);
}

const HOME_LOCATION: ExplorerLocation = { dir: HOME, open: null };

function FilesHome(): ReactNode {
  const navigator = useRouteNavigator(HOME_LOCATION, null);
  return <FileBrowser navigator={navigator} />;
}

function FilesAt(): ReactNode {
  const { dir, open } = filesAtPane.useParams();
  const setParams = filesAtPane.useSetParams();
  const location = useMemo<ExplorerLocation>(
    () => ({
      dir,
      open: open === undefined ? null : decodeOpenParam(dir, open),
    }),
    [dir, open],
  );
  const navigator = useRouteNavigator(location, setParams);
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
  const { dir, open } = entry.params;
  return {
    dir,
    open: open === undefined ? null : decodeOpenParam(dir, open),
  };
}

/**
 * The routed explorer on `dir` as a link (a new history entry; ⌘/middle-click
 * opens it in a new browser tab).
 */
export function useExplorerFolderTarget(): (dir: string) => LinkTarget {
  const openPane = useOpenPane();
  return (dir) => openPane.to(filesAtPane, { dir }, { mode: "root" });
}
