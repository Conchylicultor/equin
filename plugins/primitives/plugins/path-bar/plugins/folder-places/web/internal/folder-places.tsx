import type { ReactElement } from "react";
import {
  compareFileNames,
  type BrowsableFileSystem,
  type FileEntry,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { useFolderListing } from "@plugins/infra/plugins/paths/plugins/file-systems/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { BreadcrumbPlaces } from "@plugins/primitives/plugins/breadcrumb/web";
import { DropdownMenuItem } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type {
  PathPlaces,
  PathPlacesAt,
} from "@plugins/primitives/plugins/path-bar/web";

/**
 * How many entries one level reads at a time. Files share the window with
 * folders (a listing has no kind filter), so a level past it — or a window of
 * only files — offers More rather than reading the whole folder up front.
 */
const LEVEL_LIMIT = 200;

/** `name` inside `parent`, spelled as a path crumb spells it. */
function childPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

/**
 * The places of `fs` as a crumb's menu: every level its folders, read when
 * the level opens. Hand it to a path bar source's `places` or to a
 * `FilepathBreadcrumb`.
 */
export function folderPlaces(fs: BrowsableFileSystem): PathPlaces {
  return (parent, at) => <FolderPlaces fs={fs} path={parent} at={at} />;
}

/**
 * One level: the folders inside `path` (a symlink to a folder counts; an
 * archive does not — it is a file you can open, not a place on a path), as
 * people sort them. A hidden folder is listed only when it is on the trail,
 * as the explorer hides dotfolders. Every folder opens its own folders as a
 * submenu: whether it has any is only known by reading it, which waits for
 * its submenu to open (an empty one says "No folders").
 */
export function FolderPlaces({
  fs,
  path,
  at,
}: {
  fs: BrowsableFileSystem;
  path: string;
  at: PathPlacesAt;
}): ReactElement {
  const { pages } = useFolderListing(fs, path, { limit: LEVEL_LIMIT });
  switch (pages.status) {
    case "loading":
      return <BreadcrumbPlaces places="loading" />;
    case "unavailable":
      return (
        <DropdownMenuItem disabled className="text-destructive">
          {pages.message}
        </DropdownMenuItem>
      );
    case "error":
      return (
        <ResourceErrorInline
          variant="inline"
          subject="this folder"
          error={pages.error}
          refetch={pages.refetch}
        />
      );
    case "ready": {
      const folders = pages.data
        .filter((entry: FileEntry) => entry.kind === "dir")
        .map((entry) => ({ entry, path: childPath(path, entry.name) }))
        .filter(({ entry, path }) => !entry.hidden || at.trail.has(path))
        .sort((a, b) => compareFileNames(a.entry.name, b.entry.name));
      return (
        <BreadcrumbPlaces
          places={folders.map(({ entry, path }) => ({
            key: entry.name,
            label: entry.name,
            activation: at.activationFor(path),
            onTrail: at.trail.has(path),
            inside: <FolderPlaces fs={fs} path={path} at={at} />,
          }))}
          more={
            pages.canGrow || pages.growing
              ? { load: pages.loadMore, growing: pages.growing }
              : undefined
          }
          empty="No folders"
        />
      );
    }
  }
}
