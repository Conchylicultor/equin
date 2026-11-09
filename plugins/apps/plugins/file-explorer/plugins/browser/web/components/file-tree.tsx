import { absolutePath } from "@plugins/infra/plugins/host-account/core";
import { useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  DataView,
  defineDataView,
  rowRead,
  type FieldDef,
  type HierarchyConfig,
  type RowDragConfig,
  type RowDropConfig,
  type RowSelectionConfig,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import type { TreeChildrenState } from "@plugins/primitives/plugins/tree/core";
import {
  compareFileNames,
  dirPeekOf,
  fileUrl,
  handOffComputerFiles,
  hasFileLocations,
  isBrowsable,
  writeFileLocations,
  type BrowsableFileSystem,
  type DirPeekValue,
  type DraggedFile,
  type FileDirPeek,
  type FileEntry,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import type { LiveValueTupleRead } from "@plugins/network/plugins/live/web";
import { assetUrlOver } from "@plugins/infra/plugins/endpoints/web";
import {
  useTransport,
  type Transport,
} from "@plugins/primitives/plugins/networking/web";
import { useNativeFileDrag } from "@plugins/menu-bar/plugins/app-window/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { FileTypeIcon } from "@plugins/primitives/plugins/file-type/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import {
  ENTRY_CATEGORY_OPTIONS,
  entryCategory,
  entryExtension,
  entryKindLabel,
  fileEntry,
  formatCount,
  formatModified,
  formatModifiedFull,
  formatSize,
  itemCount,
  joinPath,
  type EntryFilter,
  type EntryRow,
  type FolderRefusal,
  type ListedFolder,
} from "../../core";
import { isOnDisk, type Listing, type Listings } from "../internal/listings";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { FileBrowserSlots } from "../slots";
import { ExplorerControlsSlot } from "../internal/controls-slot";
import type { ExplorerSystem } from "../internal/explorer-system";

const FILE_TREE_VIEW = defineDataView("file-explorer.tree");

/**
 * A native drag out of a folder macOS does not let this app read: no target
 * can take such a file, so the drag never starts. (The first drag out of a
 * protected folder asks the user; after a no, this is what every drag says.)
 */
const DRAG_DENIED_TOAST = {
  variant: "error",
  title: "Can't drag files out of this folder",
  description:
    "macOS hasn't allowed this app to read it. Allow it in System Settings › Privacy & Security › Files and Folders, then drag again.",
} as const;

/** What a folder's refused listing says, in the user's terms. */
function refusalMessage(refusal: FolderRefusal): string {
  switch (refusal.code) {
    case "denied":
      return "Permission denied";
    case "missing":
      return "This folder no longer exists";
    case "not-a-dir":
      return "Not a folder";
    case "unreadable-archive":
    case "invalid-path":
      return refusal.message;
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
  entries: readonly FileEntry[],
  shows: EntryFilter,
): FileEntry[] {
  return entries
    .filter((e) => shows(e, joinPath(dir, e.name)))
    .sort((a, b) => compareFileNames(a.name, b.name));
}

/**
 * The rows under `root`: its own entries, then — for every folder whose
 * listing has been fetched — that folder's entries, recursively. A folder's
 * children exist as rows only once listed; until then the tree shows its
 * chevron and asks for them (lazy children).
 */
function buildRows(
  fs: BrowsableFileSystem,
  listings: Listings,
  root: string,
  shows: EntryFilter,
): EntryRow[] {
  const rows: EntryRow[] = [];
  const walk = (dir: string, parentId: string | null) => {
    const listing = listings.get(dir);
    if (listing?.kind !== "ok") return;
    let rank: Rank | null = null;
    for (const entry of visibleEntries(dir, listing.entries, shows)) {
      rank = Rank.between(rank, null);
      const path = joinPath(dir, entry.name);
      rows.push({
        id: path,
        parentId,
        rank,
        fs,
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
  switch (listing.kind) {
    case "loading":
      return { kind: "loading" };
    case "ok":
      return { kind: "loaded" };
    // Never under a listed root (the root is unavailable too, and no tree is
    // drawn); nothing to retry without a computer.
    case "unavailable":
      return { kind: "failed", message: listing.message, retry: () => {} };
    case "refused":
      return {
        kind: "failed",
        message: refusalMessage(listing),
        retry: () => void listing.refetch(),
      };
    case "failed":
      return {
        kind: "failed",
        message: listing.error.message,
        retry: () => void listing.refetch(),
      };
  }
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

/** The row's lead: the file-type glyph in the tree head's icon box. */
const TYPE_GLYPH_FIELD: FieldDef<EntryRow> = {
  id: "fileType",
  label: "Type",
  type: "icon",
  header: false,
  filterable: false,
  sortable: false,
  groupable: false,
  value: (r) => r.name,
  cell: (r) => (
    <FileTypeIcon name={r.name} isDir={r.kind === "dir"} className="size-4" />
  ),
};

/**
 * The type glyph is the row's lead, pinned: under the record recipe a state
 * leads ahead of a visual, so a contributed state field (a git badge, from a
 * plugin's custom columns) would otherwise take the one lead slot — empty off
 * a checkout — and push the glyph out to a trailing column.
 */
const TREE_PLACE = { [TYPE_GLYPH_FIELD.id]: "lead" } as const;

/** The Kind column: what the entry is, in words ("PDF document", "Folder"). */
const KIND_FIELD: FieldDef<EntryRow> = {
  id: "kind",
  label: "Kind",
  width: "140px",
  align: "start",
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
  { visible }: { visible?: boolean } = {},
): FieldDef<EntryRow> {
  return {
    id,
    label,
    type: "date",
    width: "96px",
    align: "start",
    ...(visible === undefined ? {} : { visible }),
    value: (r) => {
      const ms = get(r);
      return ms === undefined ? null : new Date(ms);
    },
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

/** A listing as far as counting its folder goes: listed, refused, or not yet. */
function listedFolder(listing: Listing | undefined): ListedFolder | undefined {
  switch (listing?.kind) {
    case "ok":
      return { kind: "listed", entries: listing.entries };
    case "refused":
      return { kind: "refused", code: listing.code, message: listing.message };
    // Not answered yet, or a read that failed (the peek counts it instead).
    case "loading":
    case "failed":
    case "unavailable":
    case undefined:
      return undefined;
  }
}

/**
 * A folder's Size cell: how many items it holds, by the browser's visibility
 * rules (Show hidden files, every lens hide rule), expanded or not. An
 * expanded folder counts its listing; any other is counted from its peek
 * (`host-fs.peek`: its child names, one directory read, pushed while read) —
 * read by the DataView for the folders on screen (the Size field's
 * `rowRead`), never by this cell, so what the tree keeps subscribed is the
 * folders it shows, however long the folder and however far it was
 * scrolled. Never a 0 that is really a failure.
 */
function FolderSize({
  path,
  listing,
  shows,
  peek,
}: {
  path: string;
  listing: Listing | undefined;
  shows: EntryFilter;
  /** The folder's peek: `loading` while off screen, or while listed (not read). */
  peek: LiveValueTupleRead<DirPeekValue>;
}): ReactNode {
  const listed = listedFolder(listing);
  if (peek.status === "unavailable") {
    return muted("—", peek.message);
  }
  if (
    peek.status === "error" &&
    peek.error.kind !== "refused" &&
    listed?.kind !== "listed"
  ) {
    return (
      <ResourceErrorInline
        variant="icon"
        error={peek.error}
        refetch={peek.refetch}
        subject="this folder's items"
      />
    );
  }
  let peeked: FileDirPeek | FolderRefusal | undefined;
  if (peek.status === "ready") peeked = peek.data;
  else if (peek.status === "error" && peek.error.code !== undefined) {
    peeked = {
      kind: "refused",
      code: peek.error.code,
      message: peek.error.message,
    };
  }
  const count = itemCount(path, listed, peeked, shows);
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
      return muted("Unreadable", count.message);
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
  /** The folders the tree has open now: what is read live. */
  setOpen: (paths: readonly string[]) => void;
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
  /**
   * The file system the tree lists — what `~` is there (a drag carries
   * absolute paths) and what it can do (move, a real file to drag out).
   */
  system: ExplorerSystem;
  /** The selected rows (a set and its anchor), by path. */
  rowSelection: RowSelectionConfig;
  /**
   * The dragged rows' absolute paths, as a drag starts — with its end when
   * the drag was handed to the OS (no `dragend` will follow), else `null`.
   */
  onDragPaths: (
    paths: readonly string[],
    ended: Promise<unknown> | null,
  ) => void;
  /** Files dropped on a folder row (`dir`, display form). */
  onDropInto: (dir: string, dt: DataTransfer) => void;
}

/**
 * The folder's contents as a DataView tree: Name / Kind / Modified / Size in
 * aligned columns (Created, Accessed, Category, Extension, Path and Link
 * target hidden until switched on) plus the client fields of the `fileEntry` kind (git's), folders first (a
 * pinned sort rule, so they stay on top under any header sort), every folder lazily listed through its file system on first
 * expand — an archive file (a zip) expands like one. Clicking a folder makes it the listing; clicking a file selects it
 * (and opens it beside the listing). Double-click or Enter opens either. A
 * row's hover actions are the `FileBrowserSlots.RowActions` contributions.
 */
export function FileTree({
  root,
  listings,
  request,
  setOpen,
  shows,
  query,
  onQueryChange,
  selectedPath,
  openPath,
  rowActivation,
  onOpen,
  emptyState,
  system,
  rowSelection,
  onDragPaths,
  onDropInto,
}: FileTreeProps): ReactNode {
  // "Today" is today as of this visit to the folder.
  const [now] = useState(() => Date.now());
  const rows = useMemo(
    () => buildRows(system.fs, listings, root, shows),
    [system.fs, listings, root, shows],
  );

  const hierarchy = useMemo<HierarchyConfig<EntryRow>>(
    () => ({
      getParentId: (r) => r.parentId,
      getRank: (r) => r.rank,
      lazyChildren: {
        hasChildren: (r) => r.browsable,
        state: (r) => childrenState(listings, r.path),
        load: (r) => request(r.path),
        onOpenChange: (open) => setOpen(open.map((r) => r.path)),
      },
    }),
    [listings, request, setOpen],
  );

  // Rows drag as files of their system with their kinds (the selection when
  // the grabbed row is in it), so any surface taking `FILE_LOCATIONS_MIME` —
  // a folder row here, the Favorites sidebar — can take them without reading
  // the system again. On the computer's disk (`openNative`), in an installed
  // app window, rows drag as real files instead (the OS drag: Finder, Mail, a
  // website's upload take them), which this page still reads as its own
  // files; in a browser tab, one file also carries Chrome's `DownloadURL`
  // (dropped on the desktop or Finder, it is saved there).
  const fileDrag = useNativeFileDrag();
  const transport = useTransport();
  const rowDrag = useMemo<RowDragConfig<EntryRow>>(() => {
    const { fs, home, capabilities } = system;
    const entriesOf = (dragged: readonly EntryRow[]): DraggedFile[] =>
      dragged.map((r) => ({ path: absolutePath(r.path, home), kind: r.kind }));
    return {
      write: (dragged, dt) => {
        const entries = entriesOf(dragged);
        writeFileLocations(dt, fs, entries);
        if (capabilities.openNative) writeDownloadUrl(dt, entries, transport);
        onDragPaths(
          entries.map((e) => e.path),
          null,
        );
      },
      handOff: (dragged) => {
        // A row inside an archive is no file the OS can drag.
        if (
          fileDrag === null ||
          fs !== "computer" ||
          !dragged.every((r) => isOnDisk(listings, r.parentId ?? root))
        )
          return null;
        const entries = entriesOf(dragged);
        const ended = handOffComputerFiles(entries, fileDrag).then(
          (outcome) => {
            if (outcome === "denied") showToast(DRAG_DENIED_TOAST);
            return outcome;
          },
        );
        onDragPaths(
          entries.map((e) => e.path),
          ended,
        );
        return ended;
      },
    };
  }, [system, onDragPaths, fileDrag, transport, listings, root]);
  // A real folder takes them — not an archive file, nor a folder inside one
  // (its listing is an archive's: `within`), which cannot be written to.
  const rowDrop = useMemo<RowDropConfig<EntryRow>>(
    () => ({
      accepts: (r, types) =>
        system.capabilities.move &&
        r.kind === "dir" &&
        hasFileLocations(types) &&
        isOnDisk(listings, r.parentId ?? root),
      onDrop: (r, dt) => onDropInto(r.path, dt),
    }),
    [system, listings, root, onDropInto],
  );

  // When the listing is narrow the trailing columns (Kind) give their room to
  // the names first, then Modified (the edge); Size is emphasised.
  // `name` and `path` are the `fileEntry` kind's own fields; these are the
  // columns computed from the row and this tree's context.
  const extraFields = useMemo<FieldDef<EntryRow>[]>(
    () => [
      TYPE_GLYPH_FIELD,
      KIND_FIELD,
      timeField("modified", "Modified", (r) => r.mtimeMs, now),
      {
        id: "size",
        label: "Size",
        type: "byte-size",
        width: "80px",
        value: (r) => (r.kind === "dir" ? null : r.size),
        // A folder not listed is peeked — for the folders on screen only.
        rowRead: rowRead({
          value: dirPeekOf(system.fs),
          params: (r: EntryRow) =>
            r.kind === "dir" &&
            listedFolder(listings.get(r.path))?.kind !== "listed"
              ? { path: r.path }
              : null,
          cell: (r, peek) =>
            r.kind === "dir" ? (
              <FolderSize
                path={r.path}
                listing={listings.get(r.path)}
                shows={shows}
                peek={peek}
              />
            ) : (
              formatSize(r.size)
            ),
        }),
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
      FOLDERS_FIELD,
      {
        id: "link",
        label: "Link target",
        visible: false,
        value: (r) => r.symlinkTarget ?? null,
      },
    ],
    [now, shows, listings, system],
  );

  // A nested outline table (its config row) with its column labels: the
  // header row of sortable titles.
  const tableOptions = useMemo(
    () => ({
      header: true,
      guides: true,
      addLabel: null,
      openOnActivate: (r: EntryRow) => r.browsable,
      labelClassName: (r: EntryRow) =>
        r.path === openPath ? cn("font-semibold") : undefined,
    }),
    [openPath],
  );

  return (
    <DataView<EntryRow>
      rows={rows}
      collection={fileEntry}
      extraFields={extraFields}
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
      rowSelection={rowSelection}
      rowDrag={rowDrag}
      rowDrop={rowDrop}
      rowActivation={rowActivation}
      onRowOpen={onOpen}
      place={TREE_PLACE}
      emphasis={["size"]}
      viewOptions={{ table: tableOptions }}
      emptyState={emptyState}
    />
  );
}

/**
 * Chrome's `DownloadURL` drag type for a drag of ONE file — `mime:name:url`,
 * the one way a page drags a file out as a file: dropped on the desktop or a
 * Finder window, Chrome saves it there (other browsers ignore it). Only for a
 * file of the computer's disk whose bytes have a URL (the page's own server);
 * never for a folder.
 */
function writeDownloadUrl(
  dt: DataTransfer,
  entries: readonly DraggedFile[],
  transport: Transport,
): void {
  const [only] = entries;
  if (entries.length !== 1 || only === undefined || only.kind !== "file") {
    return;
  }
  const name = only.path.slice(only.path.lastIndexOf("/") + 1);
  // The format's own separator: a name holding one cannot be spelled.
  if (name === "" || name.includes(":")) return;
  const asset = assetUrlOver(
    transport,
    fileUrl({ fs: "computer", path: only.path }),
  );
  if (asset.kind !== "ready") return;
  const url = new URL(asset.url, window.location.href).href;
  dt.setData("DownloadURL", `application/octet-stream:${name}:${url}`);
}
