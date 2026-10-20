import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState, type ReactNode } from "react";
import {
  compareHostFsNames,
  hostFsListing,
  type HostFsListingMeta,
} from "@plugins/infra/plugins/host-fs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
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
const moreIcon = symbol("more-horiz");

/** Why a path cannot be browsed, keyed by host-fs's listing refusal code. */
export const UNAVAILABLE_MESSAGE = {
  "invalid-path": "Not a valid path.",
  missing: "This folder does not exist.",
  denied: "Permission denied.",
  "not-a-dir": "Not a folder.",
  "unreadable-archive": "This archive cannot be read.",
} as const;

/** By name as host-fs shows a folder (`compareHostFsNames`). */
const byName = (a: { name: string }, b: { name: string }): number =>
  compareHostFsNames(a.name, b.name);

export interface FolderPickerProps {
  /** Folder to open the browser at. Falls back to the user's home directory. */
  value?: string;
  /** Called with the absolute path when the user confirms a folder. */
  onSelect: (path: string) => void;
}

/**
 * Host-filesystem browser block: a breadcrumb of the current directory, a
 * scrollable list of its subdirectories to drill into, and a confirm action.
 * Presentational shell lives in {@link FolderPickerPopover}.
 */
export function FolderPicker({ value, onSelect }: FolderPickerProps) {
  const [browsePath, setBrowsePath] = useState<string | undefined>(
    value && value.trim().length > 0 ? value : undefined,
  );
  // No path = the user's home folder.
  const query = browsePath === undefined ? {} : { path: browsePath };
  // The folder's own facts (its resolved path) and its entries, a page at a
  // time — both host-fs live values, pushed while read.
  const meta = useLive(hostFsListing.meta, query);
  const entries = useLive(hostFsListing, query);
  // The folder's resolved facts once known; the breadcrumb falls back to the
  // path asked, the confirm button stays off.
  let folder: HostFsListingMeta | undefined;
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
