import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Bar } from "@plugins/primitives/plugins/bar/web";
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
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { HostFsEntry } from "@plugins/infra/plugins/host-fs/core";
import {
  absolutePath,
  baseName,
  formatCount,
  HOME,
  isWithin,
  joinPath,
  parentPath,
  type EntryFilter,
  type EntryRow,
  type LensHideRule,
} from "../../core";
import {
  hostPathSource,
  useHomeDir,
  useRootVolumeName,
} from "../internal/host-path-source";
import { useListings } from "../internal/listings";
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

const SHOW_HIDDEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Which lens hide rules are switched to show, by rule id. Absent → hidden. */
type LensShown = Readonly<Record<string, boolean>>;
const NONE_SHOWN: LensShown = {};

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

  // A device preference, kept like Finder keeps it — so a long TTL.
  const [showHidden, setShowHidden] = useDraft<boolean>(
    "file-explorer:show-hidden",
    false,
    { ttl: SHOW_HIDDEN_TTL_MS },
  );
  const [lensShown, setLensShown] = useDraft<LensShown>(
    "file-explorer:lens-shown",
    NONE_SHOWN,
    { ttl: SHOW_HIDDEN_TTL_MS },
  );

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
  const [selected, setSelected] = useState<string | null>(open);
  const treeRef = useRef<HTMLElement | null>(null);
  const rootName = useRootVolumeName();
  const source = useMemo(
    () => hostPathSource(home, rootName, root),
    [home, rootName, root],
  );
  const { listings, request } = useListings(dir);
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
    const select = () => setSelected(row.path);
    return row.browsable ? select : beforeOpen(fileAt(row.path), select);
  };
  const onOpen = (row: EntryRow) =>
    runActivation(row.browsable ? nav.to(row.path, open) : fileAt(row.path));

  const rootListing = listings.get(dir);
  const result = rootListing?.result ?? null;
  const entries =
    result?.kind === "ok"
      ? result.entries.filter((e) => shows(e, joinPath(dir, e.name)))
      : null;

  let body: ReactNode;
  if (rootListing?.error && result === null) {
    body = (
      <ListingProblem message={rootListing.error} retry={rootListing.retry} />
    );
  } else if (rootListing === undefined || result === null) {
    body = <Loading variant="rows" />;
  } else if (result.kind !== "ok") {
    body = (
      <ListingProblem
        message={
          result.kind === "denied"
            ? `You don't have permission to see the contents of “${baseName(dir)}”.`
            : result.kind === "missing"
              ? `“${dir}” does not exist.`
              : `“${dir}” is not a folder.`
        }
        retry={rootListing.retry}
      />
    );
  } else {
    body = (
      <FileTree
        root={dir}
        listings={listings}
        request={request}
        shows={shows}
        query={query}
        onQueryChange={setQuery}
        selectedPath={selected}
        openPath={open}
        rowActivation={rowActivation}
        onOpen={onOpen}
        emptyState={<Placeholder>This folder is empty</Placeholder>}
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
        <Scroll ref={treeRef} className="h-full rail-x-sm">
          {body}
        </Scroll>
      }
      footer={
        <StatusBar
          dir={dir}
          count={entries?.length ?? null}
          selected={selected}
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
  retry: () => void;
}): ReactNode {
  return (
    <Center axis="both" className="h-full p-lg">
      <Stack gap="md" align="center">
        <Text as="p" variant="body" className="text-muted-foreground">
          {message}
        </Text>
        <Button variant="outline" onClick={retry}>
          Try again
        </Button>
      </Stack>
    </Center>
  );
}

/** "N items · “name” selected", in the faint small type. */
function StatusBar({
  dir,
  count,
  selected,
}: {
  dir: string;
  count: number | null;
  selected: string | null;
}): ReactNode {
  const left = [
    count === null ? null : formatCount(count),
    selected !== null && isWithin(selected, dir)
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
