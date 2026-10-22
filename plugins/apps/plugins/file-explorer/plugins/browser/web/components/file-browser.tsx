import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { Bar } from "@plugins/primitives/plugins/bar/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
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
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  PathBar,
  type PathTarget,
} from "@plugins/primitives/plugins/path-bar/web";
import { SurfaceChromeContext } from "@plugins/primitives/plugins/pane/web";
import {
  beforeOpen,
  runActivation,
  type Activation,
} from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import {
  legacyDraftKeys,
  useDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  hasHostPaths,
  hostFsVolumeInfo,
  readHostPaths,
  type HostFsEntry,
} from "@plugins/infra/plugins/host-fs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import type { RowSelectionState } from "@plugins/primitives/plugins/tree/core";
import { DROP_TARGET_RING } from "@plugins/primitives/plugins/data-view/web";
import {
  absolutePath,
  baseName,
  displayPath,
  formatCount,
  HOME,
  isWithin,
  joinPath,
  parentPath,
  type EntryFilter,
  type EntryRow,
  type LensHideRule,
} from "../../core";
import { hostPathSource, useHomeDir } from "../internal/host-path-source";
import {
  isOnDisk,
  unlistedCount,
  useListings,
  type Listings,
} from "../internal/listings";
import { useMoveInto } from "../internal/move-into";
import {
  useLocalNavigator,
  type ExplorerNavigator,
} from "../internal/navigator";
import { WithLenses, type ComposedLens } from "../internal/lenses";
import { ExplorerControlsSlot } from "../internal/controls-slot";
import { useViewportAtMost } from "../internal/use-viewport-at-most";
import { FileTree } from "./file-tree";
import { PreviewPane } from "./preview-pane";

const backIcon = symbol("chevron-left");
const forwardIcon = symbol("chevron-right");
const upIcon = symbol("arrow-upward");
const hiddenOnIcon = symbol("visibility");
const hiddenOffIcon = symbol("visibility-off");

/** Which lens hide rules are switched to show, by rule id. Absent → hidden. */
type LensShown = Readonly<Record<string, boolean>>;
const NONE_SHOWN: LensShown = {};

// Device preferences, kept like Finder keeps them — so a long TTL.
const showHiddenStore = defineStore({
  owner: "file-explorer.show-hidden",
  label: "File browser preferences",
  area: "local",
  cap: "2 KB",
  ttl: 365 * 24 * 60 * 60 * 1000,
  whenFull: "refuse",
  schema: z.boolean(),
  legacy: legacyDraftKeys("file-explorer:show-hidden"),
});
const lensShownStore = defineStore<LensShown>({
  owner: "file-explorer.lens-shown",
  label: "File browser lens preferences",
  area: "local",
  cap: "2 KB",
  ttl: 365 * 24 * 60 * 60 * 1000,
  whenFull: "refuse",
  schema: z.record(z.string(), z.boolean()),
  legacy: legacyDraftKeys("file-explorer:lens-shown"),
});

export interface FileBrowserProps {
  /**
   * Where the browser is and how it moves. The `/files` app passes its route
   * navigator (back / forward are the browser history; every location is a
   * link). Absent → the browser keeps its own location and history, starting
   * at `initialPath` — for a browser embedded in another surface.
   */
  navigator?: ExplorerNavigator;
  /** Where an embedded browser starts. Default `~`. */
  initialPath?: string;
  /**
   * The highest folder this browser may show: up and the path bar stop here
   * (an embedded browser rooted at a checkout). Absent → the whole host.
   */
  root?: string;
  /**
   * Where a file opens instead, given its absolute path (a consumer with its
   * own preview) — a `LinkTarget` when that is a place, so ⌘/middle-click
   * opens it in a new browser tab. When set, the browser has no preview pane
   * of its own: selecting or opening a file activates this instead.
   */
  fileTarget?: (path: string) => Activation;
}

/**
 * A file browser over the host filesystem: a toolbar (back / forward / up, the
 * Dolphin path bar, a filter), the folder as a lazily-listed tree with Name /
 * Modified / Size, a status bar, and the selected file previewed in a
 * resizable pane beside it.
 */
export function FileBrowser(props: FileBrowserProps): ReactNode {
  const home = useHomeDir();
  if (home.kind === "pending") return <Loading variant="rows" />;
  if (home.kind === "failed") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the home directory"
        error={home.error}
        refetch={home.refetch}
      />
    );
  }
  return <FileBrowserReady {...props} home={home.home} />;
}

function FileBrowserReady({
  navigator,
  initialPath = HOME,
  root,
  fileTarget,
  home,
}: FileBrowserProps & { home: string }): ReactNode {
  const local = useLocalNavigator({ dir: initialPath, open: null });
  const nav = navigator ?? local;
  const { dir, open } = nav.location;
  const { contentOwnsTopChrome, leadingControl } =
    useContext(SurfaceChromeContext);
  const atTopEdge = navigator !== undefined && contentOwnsTopChrome;
  const phone = useViewportAtMost(640);
  const narrow = useViewportAtMost(900);

  const [showHidden, setShowHidden] = useDraft(showHiddenStore, false);
  const [lensShown, setLensShown] = useDraft(lensShownStore, NONE_SHOWN);

  const listing = (
    <WithLenses dir={absolutePath(dir, home)}>
      {(lens) => (
        <ExplorerControlsSlot.Provider>
          <Listing
            key={dir}
            nav={nav}
            home={home}
            root={root}
            fileTarget={fileTarget}
            lens={lens}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden(!showHidden)}
            lensShown={lensShown}
            onToggleLens={(id) =>
              setLensShown({ ...lensShown, [id]: lensShown[id] !== true })
            }
            leading={atTopEdge ? leadingControl : undefined}
            endSafeArea={atTopEdge && open === null}
          />
        </ExplorerControlsSlot.Provider>
      )}
    </WithLenses>
  );

  // A consumer bringing its own preview gets the listing alone.
  if (fileTarget !== undefined) return listing;

  const preview =
    open === null ? null : (
      <WithLenses dir={absolutePath(parentPath(open, home) ?? "/", home)}>
        {(lens) => (
          <PreviewPane
            key={open}
            path={open}
            home={home}
            git={lens.fileGit(absolutePath(open, home))}
            onClose={() => runActivation(nav.fileTo(null))}
            endSafeArea={atTopEdge}
          />
        )}
      </WithLenses>
    );

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
 * One folder's listing: toolbar, tree and status bar. Keyed by the folder, so
 * the filter and the selection start fresh in every folder visited.
 */
function Listing({
  nav,
  home,
  root,
  fileTarget,
  lens,
  showHidden,
  onToggleHidden,
  lensShown,
  onToggleLens,
  leading,
  endSafeArea,
}: {
  nav: ExplorerNavigator;
  home: string;
  root: string | undefined;
  fileTarget: ((path: string) => Activation) | undefined;
  lens: ComposedLens;
  showHidden: boolean;
  onToggleHidden: () => void;
  lensShown: LensShown;
  onToggleLens: (id: string) => void;
  leading: ReactNode;
  endSafeArea: boolean;
}): ReactNode {
  const { dir, open } = nav.location;
  const [query, setQuery] = useState("");
  // The selected rows, by path: Finder's set and the anchor a range grows
  // from. The anchor is the primary row — the one the status bar names.
  const [selection, setSelection] = useState<RowSelectionState>(() => ({
    selected: new Set(open === null ? [] : [open]),
    anchor: open,
  }));
  const selected = selection.anchor;
  const treeRef = useRef<HTMLElement | null>(null);
  // The name of the volume mounted at `/` ("Macintosh HD") for its crumb —
  // which reads "/" itself until the volume names it, or when it cannot.
  const rootVolume = useLive(hostFsVolumeInfo, { path: "/" });
  let rootName: string | undefined;
  switch (rootVolume.status) {
    case "ready":
      rootName = rootVolume.data.name;
      break;
    case "loading":
    case "error":
    case "unavailable":
      rootName = undefined;
      break;
  }
  const fetchEndpoint = useFetchEndpoint();
  const source = useMemo(
    () => hostPathSource(fetchEndpoint, home, rootName, root),
    [fetchEndpoint, home, rootName, root],
  );
  const { listings, request, setOpen, readers } = useListings(dir);
  const moveInto = useMoveInto();
  // The paths this listing is dragging right now: dropping them back into
  // the folder they sit in is no move, so the pane does not offer it.
  const dragging = useRef<readonly string[] | null>(null);
  const onDragPaths = useCallback((paths: readonly string[]) => {
    dragging.current = paths;
    window.addEventListener(
      "dragend",
      () => {
        dragging.current = null;
      },
      { once: true, capture: true },
    );
  }, []);
  const publishControls = ExplorerControlsSlot.usePublishRef();

  // Show hidden files, then every lens hide rule that is not switched to show.
  const activeHides = useMemo(
    () => lens.hides.filter((rule) => lensShown[rule.id] !== true),
    [lens, lensShown],
  );
  const shows = useCallback<EntryFilter>(
    (entry: Pick<HostFsEntry, "hidden">, path: string) => {
      if (!showHidden && entry.hidden) return false;
      if (activeHides.length === 0) return true;
      const abs = absolutePath(path, home);
      return !activeHides.some((rule) => rule.isHidden(abs));
    },
    [showHidden, activeHides, home],
  );

  const atRoot =
    root !== undefined && absolutePath(dir, home) === absolutePath(root, home);
  const up = atRoot ? null : parentPath(dir, home);

  const shortcuts = useMemo(
    () => [
      {
        id: "file-explorer.close-preview",
        keys: "escape",
        label: "Close the preview",
        when: () => open !== null,
        handler: () => runActivation(nav.fileTo(null)),
      },
      {
        id: "file-explorer.up",
        keys: "backspace",
        label: "Go to the enclosing folder",
        when: () => up !== null,
        handler: () => {
          if (up !== null) runActivation(nav.to(up, open));
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

  // After the shortcuts' memo: handing `up` to `nav.to` before it would read,
  // to the React Compiler, as a possible mutation of a memo dependency.
  const upTarget = up === null ? undefined : nav.to(up, open);
  const pathTarget = (target: PathTarget): Activation =>
    target.kind === "dir"
      ? nav.to(target.path, open)
      : nav.to(parentPath(target.path, home) ?? "/", target.path);

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
    runActivation(row.browsable ? nav.to(row.path, open) : fileAt(row.path));

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
      runActivation(nav.fileTo(anchor));
    }
  };

  // Host paths dropped on a folder (`target`, display form) move into it.
  // The drop's data is read here, before anything is awaited.
  const dropInto = (target: string, dt: DataTransfer) => {
    const read = readHostPaths(dt);
    if (read.kind === "absent") return;
    if (read.kind === "malformed") {
      throw new Error(
        `file-explorer: malformed host-paths drop: ${read.error}`,
      );
    }
    void moveInto(read.paths, absolutePath(target, home)).then((moved) => {
      if (moved.length === 0) return;
      const gone = new Set(moved.map((p) => displayPath(p, home)));
      setSelection((s) => ({
        selected: new Set([...s.selected].filter((p) => !gone.has(p))),
        anchor: s.anchor !== null && gone.has(s.anchor) ? null : s.anchor,
      }));
      if (open !== null && gone.has(open)) runActivation(nav.fileTo(null));
    });
  };
  // The listing's own empty space — below the rows too — is this folder.
  const background = useBackgroundDrop({
    accepts: (types) =>
      hasHostPaths(types) &&
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
        home={home}
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
      header={
        // The mockup's tight 4px toolbar rhythm.
        <Bar tier="pane" endSafeArea={endSafeArea} className="gap-xs">
          {leading}
          <IconButton
            icon={backIcon}
            label="Back"
            variant="ghost"
            disabled={!nav.canBack}
            onClick={nav.back}
          />
          <IconButton
            icon={forwardIcon}
            label="Forward"
            variant="ghost"
            disabled={!nav.canForward}
            onClick={nav.forward}
          />
          <IconButton
            icon={upIcon}
            label="Enclosing folder"
            variant="ghost"
            disabled={upTarget === undefined}
            {...activationProps(upTarget)}
          />
          {/* The mockup sets the first crumb's text 18px past Up and leaves
              only the bar's 4px gap before Filter: the crumbs' own insets
              (border + 2px + 2px) plus this 8px lead. */}
          <Fill className="pl-sm">
            <PathBar
              path={dir}
              source={source}
              activationFor={pathTarget}
              text="body"
              leafWeight="semibold"
            />
          </Fill>
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Filter"
            aria-label="Filter this folder"
            appearance="filled"
            // 180px, or 132px beside an open file; 130px at 1100px and under,
            // and gone at 900px and under.
            wrapperClassName={cn(
              open === null ? "w-[180px]" : "w-[132px]",
              "max-[1100px]:w-[130px] max-[900px]:hidden",
            )}
          />
          <IconButton
            icon={showHidden ? hiddenOnIcon : hiddenOffIcon}
            label={showHidden ? "Hide hidden files" : "Show hidden files"}
            variant="ghost"
            onClick={onToggleHidden}
          />
          {lens.hides.map((rule) => (
            <LensToggle
              key={rule.id}
              rule={rule}
              shown={lensShown[rule.id] === true}
              onToggle={() => onToggleLens(rule.id)}
            />
          ))}
          {/* The folder view's own controls (view switcher, creators, sort /
              filter / fields), portaled in by the tree's hosted frame. Empty —
              and collapsed — while no tree is mounted. */}
          <Line
            ref={publishControls}
            className={cn(rigidClass(), "gap-sm empty:hidden")}
          />
        </Bar>
      }
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

/** A lens hide rule's toolbar toggle: "Show ignored files" / "Hide …". */
function LensToggle({
  rule,
  shown,
  onToggle,
}: {
  rule: LensHideRule;
  shown: boolean;
  onToggle: () => void;
}): ReactNode {
  return (
    <IconButton
      icon={rule.icon}
      active={shown}
      aria-pressed={shown}
      label={shown ? `Hide ${rule.label}` : `Show ${rule.label}`}
      variant="ghost"
      onClick={onToggle}
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
  target?.focus();
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
