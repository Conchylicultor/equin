import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState, type ReactNode } from "react";
import {
  compareFileNames,
  type BrowsableFileSystem,
  type FileListingMeta,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { useFolderListing } from "@plugins/infra/plugins/paths/plugins/file-systems/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { FilepathBreadcrumb } from "@plugins/primitives/plugins/filepath-breadcrumb/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Spinner } from "@plugins/primitives/plugins/css/plugins/spinner/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const folderIcon = symbol("folder");

/** How many entries a page of the browser holds before "Show more". */
const PAGE = 500;
const moreIcon = symbol("more-horiz");

/** Why a path cannot be browsed, keyed by a folder listing's refusal code. */
export const UNAVAILABLE_MESSAGE = {
  "invalid-path": "Not a valid path.",
  missing: "This folder does not exist.",
  denied: "Permission denied.",
  "not-a-dir": "Not a folder.",
  "unreadable-archive": "This archive cannot be read.",
} as const;

/** By name as a folder is shown (`compareFileNames`). */
const byName = (a: { name: string }, b: { name: string }): number =>
  compareFileNames(a.name, b.name);

export interface FolderPickerProps {
  /**
   * The file system whose folders are browsed — the one the picked path is
   * read on (a setting the computer reads picks on the computer's disk).
   */
  fs: BrowsableFileSystem;
  /** Folder to open the browser at. Falls back to the system's home folder. */
  value?: string;
  /** Called with the absolute path when the user confirms a folder. */
  onSelect: (path: string) => void;
}

/**
 * A file system's folder browser block: a breadcrumb of the current directory, a
 * scrollable list of its subdirectories to drill into, and a confirm action.
 * Presentational shell lives in {@link FolderPickerPopover}.
 */
export function FolderPicker({ fs, value, onSelect }: FolderPickerProps) {
  const [browsePath, setBrowsePath] = useState<string | undefined>(
    value && value.trim().length > 0 ? value : undefined,
  );
  // The folder's own facts (its resolved path) and its entries, a page at a
  // time ("Show more") — both the system's live listing, pushed while read.
  // No path = the system's home folder.
  const { meta, pages: entries } = useFolderListing(fs, browsePath ?? "~", {
    limit: PAGE,
  });
  // The folder's resolved facts once known; the breadcrumb falls back to the
  // path asked, the confirm button stays off.
  let folder: FileListingMeta | undefined;
  switch (meta.status) {
    case "ready":
      folder = meta.data;
      break;
    case "loading":
    case "error":
    case "unavailable":
      folder = undefined;
      break;
  }
  const crumbPath = folder?.path ?? browsePath;

  let body: ReactNode;
  if (entries.status === "unavailable") {
    body = <Placeholder tone="error">{entries.message}</Placeholder>;
  } else if (entries.status === "loading") {
    body = (
      <Center axis="horizontal" className="p-md">
        <Spinner className="size-4 text-muted-foreground" />
      </Center>
    );
  } else if (entries.status === "error") {
    const { error } = entries;
    body =
      error.kind === "refused" && error.code !== undefined ? (
        <Placeholder tone="error">
          {UNAVAILABLE_MESSAGE[error.code]}
        </Placeholder>
      ) : (
        <ResourceErrorInline
          error={error}
          refetch={entries.refetch}
          variant="block"
          subject="this folder"
        />
      );
  } else {
    // Folders only (a symlink to a folder counts), dotfolders included.
    const subdirs = entries.data.filter((e) => e.kind === "dir").sort(byName);
    body =
      subdirs.length === 0 && !entries.canGrow ? (
        <Placeholder>No subfolders.</Placeholder>
      ) : (
        <>
          {
            // eslint-disable-next-line data-view/no-adhoc-row-list -- directory drill-down picker (transient chrome)
            subdirs.map((entry) => (
              <Row
                key={entry.name}
                icon={
                  <Icon icon={folderIcon} className="text-muted-foreground" />
                }
                onClick={() =>
                  folder && setBrowsePath(`${folder.path}/${entry.name}`)
                }
              >
                <Text>{entry.name}</Text>
              </Row>
            ))
          }
          {entries.canGrow && (
            <Row
              icon={<Icon icon={moreIcon} className="text-muted-foreground" />}
              onClick={entries.growing ? undefined : entries.loadMore}
            >
              <Text className="text-muted-foreground">
                {entries.growing ? "Loading…" : "Show more"}
              </Text>
            </Row>
          )}
        </>
      );
  }

  return (
    <Stack gap="none">
      <div className="border-b p-sm">
        {crumbPath !== undefined ? (
          <FilepathBreadcrumb
            path={crumbPath}
            showCopy={false}
            onNavigate={(dir) => setBrowsePath(dir)}
          />
        ) : meta.status === "loading" ? (
          <Loading />
        ) : null}
      </div>

      <Scroll className="max-h-64 min-h-24 p-xs">{body}</Scroll>

      <Stack direction="row" gap="none" justify="end" className="border-t p-sm">
        <Button
          disabled={!folder}
          onClick={() => folder && onSelect(folder.path)}
        >
          Select this folder
        </Button>
      </Stack>
    </Stack>
  );
}
