import {
  absolutePath,
  displayPath,
} from "@plugins/infra/plugins/host-account/core";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { Bar } from "@plugins/primitives/plugins/bar/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  Button,
  cn,
  ControlSizeProvider,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import {
  beforeOpen,
  PLAIN_GESTURE,
  runActivation,
  type Activation,
} from "@plugins/primitives/plugins/link-gesture/core";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import {
  hasFileLocations,
  readFileLocations,
  type FileEntry,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { showToast } from "@plugins/shell/plugins/toast/web";
import type { RowSelectionState } from "@plugins/primitives/plugins/tree/core";
import { DROP_TARGET_RING } from "@plugins/primitives/plugins/data-view/web";
import {
  baseName,
  formatCount,
  isWithin,
  joinPath,
  parentPath,
  type EntryFilter,
  type EntryRow,
} from "../../core";
import {
  isOnDisk,
  unlistedCount,
  useListings,
  type Listings,
} from "../internal/listings";
import { useMoveInto } from "../internal/move-into";
import { FILES_SCOPE } from "../internal/theme";
import { useViewportAtMost } from "../internal/use-viewport-at-most";
import { FileTree } from "./file-tree";
import { SplitPreview } from "./file-preview";
import {
  FileBrowserFilter,
  FileBrowserNav,
  FileBrowserPath,
  FileBrowserProvider,
  FileBrowserToggles,
  useFileBrowser,
  type FileBrowserProps,
  type FileBrowserReady,
} from "./file-browser-header";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

/**
 * A file browser over one file system (the computer's disk, the browser's
 * storage — whatever this host serves), all in one box, for a host with no
 * pane header of its own (a plugin's detail section): a sub-header laying the
 * browser's header items (back / forward / up, the path bar, the filter, the
 * toggles), then the body. A host that owns a pane header renders
 * {@link FileBrowserProvider} around its `PaneChrome`, borrows the
 * `FileBrowserHeader` slot, and draws {@link FileBrowserBody} instead.
 */
export function FileBrowser(props: FileBrowserProps): ReactNode {
  return (
    <FileBrowserProvider {...props}>
      <Theme name={FILES_SCOPE} surface="canvas" className="h-full">
        <Column
          fill
          className="h-full"
          scrollBody={false}
          header={
            // The mockup's tight 4px toolbar rhythm.
            <Bar tier="subpane" className="gap-xs">
              <FileBrowserNav />
              {/* No pane title to size it: the crumbs read in body type. */}
              <Fill>
                <Text as="div" variant="body">
                  <FileBrowserPath />
                </Text>
              </Fill>
              <FileBrowserFilter />
              <FileBrowserToggles />
            </Bar>
          }
          body={<FileBrowserBodyContent />}
        />
      </Theme>
    </FileBrowserProvider>
  );
}

/**
 * The browser's body under its host's pane header: the folder as a tree, the
 * status bar, and — with `preview: "split"` — the open file beside it; or what
 * stops the file system from being browsed. In Files' theme: hosted beside a
 * conversation or inside a folder peek, the browser IS the Files app.
 */
export function FileBrowserBody(): ReactNode {
  return (
    <Theme name={FILES_SCOPE} surface="canvas" className="h-full">
      <FileBrowserBodyContent />
    </Theme>
  );
}

function FileBrowserBodyContent(): ReactNode {
  const browser = useFileBrowser();
  switch (browser.kind) {
    case "host-pending":
      throw new Error(
        "FileBrowserBody rendered under a PendingFileBrowserProvider: while " +
          "the host has nothing to browse, it draws its own state as the body.",
      );
    case "system": {
      const { state } = browser;
      if (state.kind === "pending") return <Loading variant="rows" />;
      if (state.kind === "failed") {
        return (
          <ResourceErrorInline
            variant="block"
            subject="this file system"
            error={state.error}
            refetch={state.refetch}
          />
        );
      }
      return <Placeholder>{state.message}</Placeholder>;
    }
    case "ready":
      return <ReadyBody browser={browser} />;
  }
}

function ReadyBody({ browser }: { browser: FileBrowserReady }): ReactNode {
  const { nav, system, fileTarget, previewMode } = browser;
  const { dir, open } = nav.location;
  const phone = useViewportAtMost(640);
  const narrow = useViewportAtMost(900);

  // Keyed by the folder, so the selection starts fresh in every folder
  // visited (the filter does too: the provider's own).
  const listing = <Listing key={dir} browser={browser} />;

  // A consumer bringing its own preview, or a preview pane beside this one,
  // gets the listing alone.
  if (fileTarget !== undefined || previewMode === "pane") return listing;

  const preview =
    open === null ? null : (
      <SplitPreview
        key={open}
        system={system}
        path={open}
        onClose={(gesture) => runActivation(nav.fileTo(null), gesture)}
      />
    );

  // The split follows the viewport, which a server render does not have.
  if (phone === null || narrow === null) return <Loading />;

  // At 640px and under an open file replaces the listing.
  if (preview !== null && phone) return preview;

  return (
    // The mockup's split: listing and preview at 1 : 1.1, or 1 : 1.2 at 900px
    // and under (where the listing may also shrink further). Re-keyed at the
    // breakpoint so the default split applies anew.
    <ResizablePanelGroup
      key={narrow ? "narrow" : "wide"}
      orientation="horizontal"
      id="file-explorer-split"
    >
      <ResizablePanel id="listing" minSize={narrow ? "240px" : "320px"}>
        {listing}
      </ResizablePanel>
      {open !== null && (
        <>
          <ResizableHandle />
          <ResizablePanel
            id="preview"
            minSize={narrow ? "320px" : "360px"}
            defaultSize={narrow ? "54.55%" : "52.38%"}
          >
            {preview}
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

/**
 * One folder's listing: tree and status bar, with the browser's keyboard
 * shortcuts. Keyed by the folder, so the selection starts fresh in every
 * folder visited.
 */
function Listing({ browser }: { browser: FileBrowserReady }): ReactNode {
  const { nav, system, fileTarget, lens, showHidden, lensShown, query, up } =
    browser;
  const setQuery = browser.setQuery;
  const { dir, open } = nav.location;
  const { home } = system;
  // The selected rows, by path: Finder's set and the anchor a range grows
  // from. The anchor is the primary row — the one the status bar names.
  const [selection, setSelection] = useState<RowSelectionState>(() => ({
    selected: new Set(open === null ? [] : [open]),
    anchor: open,
  }));
  const selected = selection.anchor;
  const treeRef = useRef<HTMLElement | null>(null);
  const { listings, request, setOpen, readers } = useListings(system.fs, dir);
  const moveInto = useMoveInto(system.fs);
  // The paths this listing is dragging right now: dropping them back into
  // the folder they sit in is no move, so the pane does not offer it.
  const dragging = useRef<readonly string[] | null>(null);
  const onDragPaths = useCallback(
    (paths: readonly string[], ended: Promise<unknown> | null) => {
      dragging.current = paths;
      const done = () => {
        if (dragging.current === paths) dragging.current = null;
      };
      // A drag handed to the OS ends with its promise (its rejection
      // reported by the row drag); a browser drag with `dragend`.
      if (ended !== null) void ended.then(done, done);
      else
        window.addEventListener("dragend", done, {
          once: true,
          capture: true,
        });
    },
    [],
  );

  // Show hidden files, then every lens hide rule that is not switched to show.
  const activeHides = useMemo(
    () => lens.hides.filter((rule) => lensShown[rule.id] !== true),
    [lens, lensShown],
  );
  const shows = useCallback<EntryFilter>(
    (entry: Pick<FileEntry, "hidden">, path: string) => {
      if (!showHidden && entry.hidden) return false;
      if (activeHides.length === 0) return true;
      const abs = absolutePath(path, home);
      return !activeHides.some((rule) => rule.isHidden(abs));
    },
    [showHidden, activeHides, home],
  );

  const shortcuts = useMemo(
    () => [
      {
        id: "file-explorer.close-preview",
        keys: "escape",
        label: "Close the preview",
        when: () => open !== null,
        handler: () => runActivation(nav.fileTo(null), PLAIN_GESTURE),
      },
      {
        id: "file-explorer.up",
        keys: "backspace",
        label: "Go to the enclosing folder",
        when: () => up !== null,
        handler: () => {
          if (up !== null) runActivation(nav.to(up, open), PLAIN_GESTURE);
        },
      },
      {
        id: "file-explorer.focus-tree",
        keys: "arrowdown",
        label: "Move into the listing",
        // A focused row walks the tree itself; this only brings focus to it.
        when: (e: KeyboardEvent) =>
          !(e.target instanceof Element && e.target.closest("[data-tree-row]")),
        handler: () => focusRow(treeRef.current, selected),
      },
    ],
    [nav, open, up, selected],
  );
  useSurfaceShortcuts(shortcuts);

  const fileAt = (path: string): Activation =>
    fileTarget !== undefined
      ? fileTarget(absolutePath(path, home))
      : nav.fileTo(path);
  // A click selects; on a file it also opens it beside the listing — a link,
  // so ⌘/middle-click previews it in a new browser tab instead. A folder's
  // click descends (the tree's `openOnActivate`), through `onOpen`.
  const rowActivation = (row: EntryRow): Activation => {
    const select = () => setSelection(only(row.path));
    return row.browsable ? select : beforeOpen(fileAt(row.path), select);
  };
  const onOpen = (row: EntryRow) =>
    runActivation(
      row.browsable ? nav.to(row.path, open) : fileAt(row.path),
      PLAIN_GESTURE,
    );

  // A ⌘/Shift-click changes the set only; the preview follows its anchor
  // when that is a file the gesture added (a plain click opens it itself).
  const onSelectionChange = (next: RowSelectionState) => {
    setSelection(next);
    const anchor = next.anchor;
    if (
      fileTarget === undefined &&
      next.selected.size > 1 &&
      anchor !== null &&
      anchor !== open &&
      next.selected.has(anchor) &&
      isFile(listings, anchor, home)
    ) {
      runActivation(nav.fileTo(anchor), PLAIN_GESTURE);
    }
  };

  // Files dropped on a folder (`target`, display form) move into it — files
  // of this browser's system only: moving between two file systems is not
  // offered yet (it says so). The drop's data is read here, before anything
  // is awaited.
  const dropInto = (target: string, dt: DataTransfer) => {
    const read = readFileLocations(dt);
    if (read.kind === "absent") return;
    if (read.kind === "malformed") {
      throw new Error(
        `file-explorer: malformed file-locations drop: ${read.error}`,
      );
    }
    if (read.fs !== system.fs) {
      showToast({
        variant: "error",
        description:
          "Moving files between two file systems is not supported yet",
      });
      return;
    }
    void moveInto(
      read.entries.map((e) => e.path),
      absolutePath(target, home),
    ).then((moved) => {
      if (moved.length === 0) return;
      const gone = new Set(moved.map((p) => displayPath(p, home)));
      setSelection((s) => ({
        selected: new Set([...s.selected].filter((p) => !gone.has(p))),
        anchor: s.anchor !== null && gone.has(s.anchor) ? null : s.anchor,
      }));
      if (open !== null && gone.has(open)) {
        runActivation(nav.fileTo(null), PLAIN_GESTURE);
      }
    });
  };
  // The listing's own empty space — below the rows too — is this folder.
  const background = useBackgroundDrop({
    accepts: (types) =>
      system.capabilities.move &&
      hasFileLocations(types) &&
      isOnDisk(listings, dir) &&
      !allIn(dragging.current, absolutePath(dir, home)),
    onDrop: (dt) => dropInto(dir, dt),
  });

  const rootListing = listings.get(dir);
  const entries =
    rootListing?.kind === "ok"
      ? rootListing.entries.filter((e) => shows(e, joinPath(dir, e.name)))
      : null;

  let body: ReactNode;
  if (rootListing === undefined || rootListing.kind === "loading") {
    body = <Loading variant="rows" />;
  } else if (rootListing.kind === "unavailable") {
    body = <ListingProblem message={rootListing.message} />;
  } else if (rootListing.kind === "failed") {
    body = (
      <ResourceErrorInline
        variant="block"
        error={rootListing.error}
        refetch={rootListing.refetch}
        subject="this folder"
      />
    );
  } else if (rootListing.kind === "refused") {
    body = (
      <ListingProblem
        message={
          rootListing.code === "denied"
            ? `You don't have permission to see the contents of “${baseName(dir)}”.`
            : rootListing.code === "missing"
              ? `“${dir}” does not exist.`
              : rootListing.code === "not-a-dir"
                ? `“${dir}” is not a folder.`
                : rootListing.message
        }
        retry={() => void rootListing.refetch()}
      />
    );
  } else {
    body = (
      <FileTree
        root={dir}
        listings={listings}
        request={request}
        setOpen={setOpen}
        shows={shows}
        query={query}
        onQueryChange={setQuery}
        selectedPath={selected}
        openPath={open}
        rowActivation={rowActivation}
        onOpen={onOpen}
        emptyState={<Placeholder>This folder is empty</Placeholder>}
        system={system}
        rowSelection={{ ...selection, onChange: onSelectionChange }}
        onDragPaths={onDragPaths}
        onDropInto={dropInto}
      />
    );
  }

  return (
    <Column
      fill
      className="h-full"
      scrollBody={false}
      body={
        <Scroll
          ref={treeRef}
          {...background.props}
          className={cn(
            "h-full rail-x-sm",
            background.over && cn(DROP_TARGET_RING, "ring-inset"),
          )}
        >
          {readers}
          {rootListing?.kind === "ok" &&
          rootListing.refreshError !== undefined ? (
            // A re-read failed: the rows below are the last ones read.
            <ResourceErrorInline
              variant="inline"
              error={rootListing.refreshError.error}
              refetch={rootListing.refreshError.refetch}
              subject="this folder's latest contents"
            />
          ) : null}
          {body}
        </Scroll>
      }
      footer={
        <StatusBar
          dir={dir}
          count={entries?.length ?? null}
          unlisted={unlistedCount(rootListing)}
          selected={selected}
          selectedCount={selection.selected.size}
        />
      }
    />
  );
}

/** A folder that cannot be shown, said as such — never as an empty one. */
function ListingProblem({
  message,
  retry,
}: {
  message: string;
  /** Ask again; absent where asking again cannot help (no computer). */
  retry?: () => void;
}): ReactNode {
  return (
    <Center axis="both" className="h-full p-lg">
      <Stack gap="md" align="center">
        <Text as="p" variant="body" className="text-muted-foreground">
          {message}
        </Text>
        {retry !== undefined && (
          <Button variant="outline" onClick={retry}>
            Try again
          </Button>
        )}
      </Stack>
    </Center>
  );
}

/**
 * "N items · “name” selected", in the faint small type — and, for a folder
 * holding more entries than one listing reads, how many are not shown.
 */
function StatusBar({
  dir,
  count,
  unlisted,
  selected,
  selectedCount,
}: {
  dir: string;
  count: number | null;
  /** Entries past the listing's cap, not shown (0: every entry is listed). */
  unlisted: number;
  selected: string | null;
  selectedCount: number;
}): ReactNode {
  const left = [
    count === null ? null : formatCount(count),
    unlisted > 0 ? `${formatCount(unlisted)} not listed` : null,
    selectedCount > 1
      ? `${selectedCount} selected`
      : selected !== null && isWithin(selected, dir)
        ? `“${baseName(selected)}” selected`
        : null,
  ]
    .filter((s) => s !== null)
    .join(" · ");
  return (
    // A compact region: the caption takes its small rung (`2xs`).
    <ControlSizeProvider size="xs">
      <Text
        as={Line}
        variant="caption"
        tone="faint"
        // eslint-disable-next-line rail/no-adhoc-band -- debt (task-1794239361-kagy27): a hand-rolled rule strip; move it onto its surface's header/footer or a Band
        className="h-7 gap-md border-t px-lg"
      >
        <Text variant="caption">{left}</Text>
      </Text>
    </ControlSizeProvider>
  );
}

/**
 * Bring keyboard focus into the listing: the selected row, else the first.
 * The rows are the tree's own focusable elements (`data-tree-row`), read
 * inside this listing's own scroll box only.
 */
function focusRow(
  container: HTMLElement | null,
  selected: string | null,
): void {
  if (container === null) return;
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>("[data-tree-row][tabindex]"),
  );
  const target =
    rows.find((r) => r.dataset.treeId === selected) ?? rows[0] ?? null;
  focusElement(target, { reveal: true });
}

/** Exactly `path`, which is the anchor — kept as is when it already is. */
function only(path: string): (s: RowSelectionState) => RowSelectionState {
  return (s) =>
    s.anchor === path && s.selected.size === 1 && s.selected.has(path)
      ? s
      : { selected: new Set([path]), anchor: path };
}

/** Whether `path` (display form) is a listed entry that opens as a file. */
function isFile(listings: Listings, path: string, home: string): boolean {
  const parent = parentPath(path, home);
  if (parent === null) return false;
  const listing = listings.get(parent);
  if (listing?.kind !== "ok") return false;
  const entry = listing.entries.find((e) => e.name === baseName(path));
  return (
    entry !== undefined && entry.kind !== "dir" && entry.archive === undefined
  );
}

/** Whether every one of `paths` (absolute) sits directly in `dir`. */
function allIn(paths: readonly string[] | null, dir: string): boolean {
  if (paths === null || paths.length === 0) return false;
  return paths.every((p) => {
    const cut = p.lastIndexOf("/");
    return (cut <= 0 ? "/" : p.slice(0, cut)) === dir;
  });
}

/**
 * An element as a native drop target for whatever its children let through:
 * a row that takes the drop stops it, so this sees only the rest — the space
 * between and below the rows. `over` while a drag it accepts is over it.
 */
function useBackgroundDrop({
  accepts,
  onDrop,
}: {
  accepts: (types: readonly string[]) => boolean;
  onDrop: (dt: DataTransfer) => void;
}): {
  over: boolean;
  props: {
    onDragOverCapture: () => void;
    onDropCapture: () => void;
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDragLeave: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
} {
  const [over, setOver] = useState(false);
  const types = (e: DragEvent<HTMLElement>) => Array.from(e.dataTransfer.types);
  return {
    over,
    props: {
      // A child taking the drag (an accepting row) stops it before it bubbles
      // here: the capture pass clears the highlight first, and the bubble pass
      // sets it again only when nothing below took it.
      onDragOverCapture: () => setOver(false),
      onDropCapture: () => setOver(false),
      onDragOver: (e) => {
        if (!accepts(types(e))) {
          setOver(false);
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: (e) => {
        // A leave onto a child is no leave (no `relatedTarget` in Chromium:
        // what is under the pointer says where it went).
        const to =
          e.relatedTarget ?? document.elementFromPoint(e.clientX, e.clientY);
        if (to instanceof Node && e.currentTarget.contains(to)) return;
        setOver(false);
      },
      onDrop: (e) => {
        setOver(false);
        if (!accepts(types(e))) return;
        e.preventDefault();
        onDrop(e.dataTransfer);
      },
    },
  };
}
