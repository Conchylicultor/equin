import { useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  DataView,
  defineDataView,
  type FieldDef,
  type HierarchyConfig,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import type { TreeChildrenState } from "@plugins/primitives/plugins/tree/core";
import {
  isBrowsable,
  type HostFsEntry,
  type HostFsListResult,
} from "@plugins/infra/plugins/host-fs/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { FileTypeIcon } from "@plugins/primitives/plugins/file-type/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import {
  archiveReasonMessage,
  ENTRY_CATEGORY_OPTIONS,
  entryCategory,
  entryExtension,
  entryKindLabel,
  formatCount,
  formatModified,
  formatModifiedFull,
  formatSize,
  itemCount,
  joinPath,
  type EntryFilter,
  type EntryRow,
} from "../../core";
import type { Listing, Listings } from "../internal/listings";
import { useFolderPeek } from "../internal/folder-peek";
import { FileBrowserSlots } from "../slots";
import { ExplorerControlsSlot } from "../internal/controls-slot";

const FILE_TREE_VIEW = defineDataView("file-explorer.tree");

/** What a listing's failure says, in the user's terms. */
function listingFailure(listing: Listing): string | null {
  if (listing.error !== null) return listing.error;
  switch (listing.result?.kind) {
    case "denied":
      return "Permission denied";
    case "missing":
      return "This folder no longer exists";
    case "not-a-dir":
      return "Not a folder";
    case "unreadable-archive":
      return archiveReasonMessage(listing.result.reason);
    case "ok":
    case undefined:
      return null;
  }
}

/**
 * The entries a listing shows, by name as people sort. Folders-first is NOT
 * minted here: the view's pinned `folders` sort rule (FOLDERS_FIELD) owns it,
 * so it survives a header click and the user can turn it off — one source of
 * that ordering, not two. These ranks are the tiebreak under every sort.
 */
function visibleEntries(
  dir: string,
  entries: readonly HostFsEntry[],
  shows: EntryFilter,
): HostFsEntry[] {
  return entries
    .filter((e) => shows(e, joinPath(dir, e.name)))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
}

/**
 * The rows under `root`: its own entries, then — for every folder whose
 * listing has been fetched — that folder's entries, recursively. A folder's
 * children exist as rows only once listed; until then the tree shows its
 * chevron and asks for them (lazy children).
 */
function buildRows(
  listings: Listings,
  root: string,
  shows: EntryFilter,
): EntryRow[] {
  const rows: EntryRow[] = [];
  const walk = (dir: string, parentId: string | null) => {
    const listing = listings.get(dir);
    if (listing?.result?.kind !== "ok") return;
    let rank: Rank | null = null;
    for (const entry of visibleEntries(dir, listing.result.entries, shows)) {
      rank = Rank.between(rank, null);
      const path = joinPath(dir, entry.name);
      rows.push({
        id: path,
        parentId,
        rank,
        name: entry.name,
        path,
        kind: entry.kind,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        ...(entry.birthtimeMs !== undefined
          ? { birthtimeMs: entry.birthtimeMs }
          : {}),
        ...(entry.atimeMs !== undefined ? { atimeMs: entry.atimeMs } : {}),
        ...(entry.symlinkTarget !== undefined
          ? { symlinkTarget: entry.symlinkTarget }
          : {}),
        hidden: entry.hidden,
        browsable: isBrowsable(entry),
        ...(entry.archive !== undefined ? { archive: entry.archive } : {}),
      });
      if (isBrowsable(entry)) walk(path, path);
    }
  };
  walk(root, null);
  return rows;
}

/** A tree-view listing's state, as the lazy-children contract spells it. */
function childrenState(listings: Listings, path: string): TreeChildrenState {
  const listing = listings.get(path);
  if (listing === undefined) return { kind: "unloaded" };
  const failure = listingFailure(listing);
  if (failure !== null) {
    return { kind: "failed", message: failure, retry: listing.retry };
  }
  if (listing.result === null) return { kind: "loading" };
  return { kind: "loaded" };
}

/**
 * No band: the explorer's own toolbar is the folder view's header. It owns the
 * name filter, and the parts the DataView hands this frame (the view switcher
 * once a second view is authored, any creators, and the options trigger —
 * sort, and filter on any field, a contributed one like git's "Changed vs
 * main" included, and fields — the only way to reach those controls) portal
 * into the toolbar cell it publishes, visible at rest like the buttons beside
 * them.
 */
function FileTreeFrame({
  switcher,
  creators,
  options,
  body,
}: HostedToolbarParts): ReactNode {
  const cell = ExplorerControlsSlot.useRoot();
  return (
    <>
      {cell.attached &&
        createPortal(
          <>
            {switcher}
            {creators}
            {options}
          </>,
          cell.root,
        )}
      {body}
    </>
  );
}

const HOSTED: HostedToolbar = {
  kind: "hosted",
  frame: FileTreeFrame,
  forms: { switcher: "chip", options: "visible" },
};

/** The Kind column: what the entry is, in words ("PDF document", "Folder"). */
const KIND_FIELD: FieldDef<EntryRow> = {
  id: "kind",
  label: "Kind",
  width: "140px",
  align: "start",
  // The first column to give way to the names when the listing is narrow.
  dropOrder: 1,
  value: (r) => entryKindLabel(r),
};

/**
 * Finder's "Keep folders on top", as a sort key: folders 0, files 1. Never a
 * column — the config's default view pins an ascending sort rule on it, which
 * sorts ahead of whatever header the user clicks. Unpinning or removing that
 * rule in the sort panel mixes folders and files; re-adding it restores them.
 */
const FOLDERS_FIELD: FieldDef<EntryRow> = {
  id: "folders",
  label: "Folders",
  type: "number",
  visible: false,
  value: (r) => (r.kind === "dir" ? 0 : 1),
};

/**
 * A date column (Modified, Created, Accessed): the short date, left-aligned,
 * the full one on hover, "—" where the filesystem records none — its value
 * then null, so it sorts last rather than as 1970. 92px: the mockup's 96px
 * track less the row's 4px gap between cells.
 */
function timeField(
  id: string,
  label: string,
  get: (r: EntryRow) => number | undefined,
  now: number,
  { visible, dropOrder }: { visible?: boolean; dropOrder?: number } = {},
): FieldDef<EntryRow> {
  return {
    id,
    label,
    type: "number",
    width: "96px",
    align: "start",
    ...(visible === undefined ? {} : { visible }),
    ...(dropOrder === undefined ? {} : { dropOrder }),
    value: (r) => get(r) ?? null,
    cell: (r) => {
      const ms = get(r);
      if (ms === undefined) return "—";
      return (
        <span title={formatModifiedFull(ms)}>{formatModified(ms, now)}</span>
      );
    },
  };
}

function muted(text: string, title: string): ReactNode {
  return (
    <span className="text-muted-foreground" title={title}>
      {text}
    </span>
  );
}

/**
 * A folder's Size cell: how many items it holds, by the browser's visibility
 * rules (Show hidden files, every lens hide rule), expanded or not. An
 * expanded folder counts its listing; any other is peeked (its child names,
 * one directory read) by this cell — so only folders on screen are read, as
 * the tree renders only the rows it shows. Never a 0 that is really a failure.
 */
function FolderSize({
  path,
  listed,
  shows,
  visit,
}: {
  path: string;
  listed: HostFsListResult | null | undefined;
  shows: EntryFilter;
  visit: string;
}): ReactNode {
  const peek = useFolderPeek(path, visit, listed?.kind !== "ok");
  if (peek.kind === "failed" && listed?.kind !== "ok") {
    return (
      <Button
        variant="ghost"
        title={`${peek.message} — click to retry`}
        onClick={(e) => {
          e.stopPropagation();
          peek.retry();
        }}
      >
        Retry
      </Button>
    );
  }
  const count = itemCount(
    path,
    listed,
    peek.kind === "ok" ? peek.result : undefined,
    shows,
  );
  switch (count.kind) {
    case "count":
      return formatCount(count.n);
    case "many":
      return muted(
        formatCount(count.total),
        "Too many items to apply the visibility rules: every item is counted",
      );
    case "denied":
      return muted("No access", "Permission denied");
    case "unreadable":
      return muted("Unreadable", archiveReasonMessage(count.reason));
    case "gone":
      return muted("—", "This folder no longer exists");
    case "loading":
      return <Loading variant="block" className="ml-auto h-3 w-10" />;
  }
}

export interface FileTreeProps {
  root: string;
  /** The listings of the root and of every folder opened so far. */
  listings: Listings;
  /** Ask for a folder's listing (when the tree opens it). */
  request: (path: string) => void;
  shows: EntryFilter;
  query: string;
  onQueryChange: (q: string) => void;
  selectedPath: string | null;
  openPath: string | null;
  /** A row's click (and arrow-key) activation — a link where it opens a place. */
  rowActivation: (row: EntryRow) => Activation;
  onOpen: (row: EntryRow) => void;
  /** What an empty folder shows. */
  emptyState: ReactNode;
}

/**
 * The folder's contents as a DataView tree: Name / Kind / Modified / Size in
 * aligned columns (Created, Accessed, Category, Extension, Path and Link
 * target hidden until switched on) plus every `FileBrowserSlots.Fields` contribution, folders first (a
 * pinned sort rule, so they stay on top under any header sort), every folder lazily listed through host-fs on first
 * expand — an archive file (a zip) expands like one. Clicking a folder makes it the listing; clicking a file selects it
 * (and opens it beside the listing). Double-click or Enter opens either. A
 * row's hover actions are the `FileBrowserSlots.RowActions` contributions.
 */
export function FileTree({
  root,
  listings,
  request,
  shows,
  query,
  onQueryChange,
  selectedPath,
  openPath,
  rowActivation,
  onOpen,
  emptyState,
}: FileTreeProps): ReactNode {
  // "Today" is today as of this listing: the folder is re-listed on every visit.
  const [now] = useState(() => Date.now());
  // Folder counts are cached for this visit: scrolling back costs nothing, and
  // the next visit re-reads them, as it re-lists the folder.
  const [visit] = useState(() => crypto.randomUUID());
  const rows = useMemo(
    () => buildRows(listings, root, shows),
    [listings, root, shows],
  );

  const hierarchy = useMemo<HierarchyConfig<EntryRow>>(
    () => ({
      getParentId: (r) => r.parentId,
      getRank: (r) => r.rank,
      lazyChildren: {
        hasChildren: (r) => r.browsable,
        state: (r) => childrenState(listings, r.path),
        load: (r) => request(r.path),
      },
    }),
    [listings, request],
  );

  // When the listing is narrow Kind, then Modified, give their room to the
  // names (`dropOrder`); Size stays longest.
  const fields = useMemo<FieldDef<EntryRow>[]>(
    () => [
      { id: "name", label: "Name", primary: true, value: (r) => r.name },
      KIND_FIELD,
      timeField("modified", "Modified", (r) => r.mtimeMs, now, {
        dropOrder: 2,
      }),
      {
        id: "size",
        label: "Size",
        type: "number",
        width: "80px",
        align: "end",
        value: (r) => (r.kind === "dir" ? null : r.size),
        cell: (r) =>
          r.kind === "dir" ? (
            <FolderSize
              path={r.path}
              listed={listings.get(r.path)?.result}
              shows={shows}
              visit={visit}
            />
          ) : (
            formatSize(r.size)
          ),
      },
      timeField("created", "Created", (r) => r.birthtimeMs, now, {
        visible: false,
      }),
      timeField("accessed", "Accessed", (r) => r.atimeMs, now, {
        visible: false,
      }),
      {
        id: "category",
        label: "Category",
        type: "enum",
        options: ENTRY_CATEGORY_OPTIONS,
        visible: false,
        value: (r) => entryCategory(r),
      },
      {
        id: "extension",
        label: "Extension",
        visible: false,
        value: (r) => entryExtension(r.name),
      },
      { id: "path", label: "Path", visible: false, value: (r) => r.path },
      FOLDERS_FIELD,
      {
        id: "link",
        label: "Link target",
        visible: false,
        value: (r) => r.symlinkTarget ?? null,
      },
    ],
    [now, shows, listings, visit],
  );

  // A nested outline table (its config row) with its column labels: the
  // header row of sortable titles, and in a narrow pane Kind, then Modified,
  // give their room to the names (`dropOrder`).
  const tableOptions = useMemo(
    () => ({
      header: true,
      guides: true,
      addLabel: null,
      leadingIcon: (r: EntryRow) => (
        <FileTypeIcon
          name={r.name}
          isDir={r.kind === "dir"}
          className="size-4"
        />
      ),
      openOnActivate: (r: EntryRow) => r.browsable,
      labelClassName: (r: EntryRow) =>
        r.path === openPath ? cn("font-semibold") : undefined,
    }),
    [openPath],
  );

  return (
    <DataView<EntryRow>
      rows={rows}
      fields={fields}
      fieldExtensions={FileBrowserSlots.Fields}
      itemActions={FileBrowserSlots.RowActions}
      rowKey={(r) => r.id}
      views={["table"]}
      storageKey={FILE_TREE_VIEW}
      toolbar={HOSTED}
      density="compact"
      hierarchy={hierarchy}
      search={{ query, onQueryChange }}
      searchAccessor={(r) => r.name}
      selectedRowId={selectedPath ?? undefined}
      rowActivation={rowActivation}
      onRowOpen={onOpen}
      viewOptions={{ table: tableOptions }}
      emptyState={emptyState}
    />
  );
}
