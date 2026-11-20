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
import { FileTypeIcon } from "@plugins/primitives/plugins/file-type/web";
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

/** What a level lists besides its folders. */
export interface FolderPlacesOptions {
  /**
   * List the files too, after the folders — so a trail ending at a file (a
   * file preview) switches to a sibling file from its own crumb. `false` for
   * a trail where only a folder is a place (a folder picker).
   */
  files: boolean;
}

/**
 * The places of `fs` as a crumb's menu: every level its folders (and files,
 * when asked), read when the level opens. Hand it to a path bar source's
 * `places` or to a `FilepathBreadcrumb`.
 */
export function folderPlaces(
  fs: BrowsableFileSystem,
  options: FolderPlacesOptions,
): PathPlaces {
  return (parent, at) => (
    <FolderPlaces fs={fs} path={parent} at={at} {...options} />
  );
}

/**
 * One level: the folders inside `path` (a symlink to a folder counts; an
 * archive does not — it is a file you can open, not a place on a path), then
 * — with `files` — its files, each run as people sort them and each row with
 * its file-type icon. A hidden entry is listed only when it is on the trail,
 * as the explorer hides dotfiles. Every folder opens its own level as a
 * submenu: whether it has anything is only known by reading it, which waits
 * for its submenu to open.
 */
export function FolderPlaces({
  fs,
  path,
  at,
  files,
}: {
  fs: BrowsableFileSystem;
  path: string;
  at: PathPlacesAt;
} & FolderPlacesOptions): ReactElement {
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
      const listed = pages.data
        .filter(
          (entry: FileEntry) =>
            entry.kind === "dir" || (files && entry.kind === "file"),
        )
        .map((entry) => ({ entry, path: childPath(path, entry.name) }))
        .filter(({ entry, path }) => !entry.hidden || at.trail.has(path))
        .sort(
          (a, b) =>
            Number(b.entry.kind === "dir") - Number(a.entry.kind === "dir") ||
            compareFileNames(a.entry.name, b.entry.name),
        );
      return (
        <BreadcrumbPlaces
          places={listed.map(({ entry, path }) => {
            const isDir = entry.kind === "dir";
            return {
              key: entry.name,
              label: (
                <>
                  <FileTypeIcon name={entry.name} isDir={isDir} />
                  {entry.name}
                </>
              ),
              activation: at.activationFor({
                kind: isDir ? "dir" : "file",
                path,
              }),
              onTrail: at.trail.has(path),
              ...(isDir
                ? {
                    inside: (
                      <FolderPlaces fs={fs} path={path} at={at} files={files} />
                    ),
                  }
                : {}),
            };
          })}
          more={
            pages.canGrow || pages.growing
              ? { load: pages.loadMore, growing: pages.growing }
              : undefined
          }
          empty={files ? "Empty folder" : "No folders"}
        />
      );
    }
  }
}
