import { HOME, absolutePath } from "@plugins/infra/plugins/host-account/core";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import {
  PathBar,
  type PathBarSource,
  type PathTarget,
} from "@plugins/primitives/plugins/path-bar/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import {
  legacyDraftKeys,
  useDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { BrowsableFileSystem } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { parentPath, type LensHideRule } from "../../core";
import { useFolderPathSource } from "../internal/host-path-source";
import {
  useExplorerSystem,
  type ExplorerSystem,
  type ExplorerSystemState,
} from "../internal/explorer-system";
import {
  useLocalNavigator,
  type ExplorerNavigator,
} from "../internal/navigator";
import { WithLenses, type ComposedLens } from "../internal/lenses";
import { ExplorerControlsSlot } from "../internal/controls-slot";

const backIcon = symbol("chevron-left");
const forwardIcon = symbol("chevron-right");
const upIcon = symbol("arrow-upward");
const hiddenOnIcon = symbol("visibility");
const hiddenOffIcon = symbol("visibility-off");

/** Which lens hide rules are switched to show, by rule id. Absent → hidden. */
export type LensShown = Readonly<Record<string, boolean>>;
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
   * at `initialPath` in `fs` — for a browser embedded in another surface.
   */
  navigator?: ExplorerNavigator;
  /** The file system an embedded browser shows. Default the computer's disk. */
  fs?: BrowsableFileSystem;
  /** Where an embedded browser starts. Default `~`. */
  initialPath?: string;
  /**
   * The highest folder this browser may show: up and the path bar stop here
   * (an embedded browser rooted at a checkout). Absent → the whole system.
   */
  root?: string;
  /**
   * Where a file opens instead, given its absolute path in the browser's
   * file system (a consumer with its
   * own preview) — a `LinkTarget` when that is a place, so ⌘/middle-click
   * opens it in a new browser tab. When set, the browser has no preview pane
   * of its own: selecting or opening a file activates this instead.
   */
  fileTarget?: (path: string) => Activation;
  /**
   * Where the open file is previewed:
   * - `"split"` (default) — beside the listing, in a resizable split this
   *   browser draws (a browser hosted inside one pane);
   * - `"pane"` — in a pane of its own beside this one, which the navigator
   *   opens and closes (`/files`, whose preview is a Miller column): the
   *   browser draws the listing only, marking the open file.
   */
  preview?: "split" | "pane";
}

/**
 * A browser whose file system is read and whose folder is known: everything
 * its header and its body share. Selection, keyboard shortcuts, the tree and
 * the status bar are the body's own.
 */
export interface FileBrowserReady {
  kind: "ready";
  system: ExplorerSystem;
  nav: ExplorerNavigator;
  root: string | undefined;
  fileTarget: ((path: string) => Activation) | undefined;
  previewMode: "split" | "pane";
  lens: ComposedLens;
  showHidden: boolean;
  toggleHidden: () => void;
  lensShown: LensShown;
  toggleLens: (id: string) => void;
  /** The folder's name filter — empty again in every folder visited. */
  query: string;
  setQuery: (query: string) => void;
  /** The enclosing folder, or `null` at the root (the system's or `root`). */
  up: string | null;
  upTarget: Activation | undefined;
  pathSource: PathBarSource;
  pathTarget: (target: PathTarget) => Activation;
}

/**
 * What a browser's header and body read:
 * - `host-pending` — the host does not know what to browse yet (its own
 *   state, drawn by the host: {@link PendingFileBrowserProvider});
 * - `system` — the file system is loading, failed or not served here;
 * - `ready`.
 */
export type FileBrowserValue =
  | { kind: "host-pending" }
  | {
      kind: "system";
      state: Exclude<ExplorerSystemState, { kind: "ready" }>;
    }
  | FileBrowserReady;

const FileBrowserContext = createContext<FileBrowserValue | null>(null);

/** The surrounding browser's state. Throws outside a browser provider. */
export function useFileBrowser(): FileBrowserValue {
  const value = useContext(FileBrowserContext);
  if (value === null) {
    throw new Error(
      "File-browser header item or body rendered outside FileBrowserProvider: " +
        "the browser's host wraps its PaneChrome in the provider (or a " +
        "PendingFileBrowserProvider while it has nothing to browse yet), so " +
        "the header items only mount there.",
    );
  }
  return value;
}

const HOST_PENDING: FileBrowserValue = { kind: "host-pending" };

/**
 * Publishes a browser's state — its file system, where it is and how it
 * moves, the toolbar's toggles and filter — to its header items and its body.
 * A host that owns a pane header wraps its `PaneChrome` in it:
 *
 *     <FileBrowserProvider {...props}>
 *       <PaneChrome pane={…}><FileBrowserBody/></PaneChrome>
 *     </FileBrowserProvider>
 *
 * and borrows the {@link FileBrowserHeader} slot. Every state (the file
 * system loading, failed, absent) keeps the provider, so the header holds its
 * place and the body says what is wrong under it.
 */
export function FileBrowserProvider({
  children,
  ...props
}: FileBrowserProps & { children: ReactNode }): ReactNode {
  const state = useExplorerSystem(
    props.navigator?.location.fs ?? props.fs ?? "computer",
  );
  return (
    // The cell the header publishes and the tree's portal reads: one per
    // browser, around both.
    <ExplorerControlsSlot.Provider>
      {state.kind === "ready" ? (
        <ReadyProvider {...props} system={state.system}>
          {children}
        </ReadyProvider>
      ) : (
        <SystemPendingProvider state={state}>{children}</SystemPendingProvider>
      )}
    </ExplorerControlsSlot.Provider>
  );
}

function SystemPendingProvider({
  state,
  children,
}: {
  state: Exclude<ExplorerSystemState, { kind: "ready" }>;
  children: ReactNode;
}): ReactNode {
  const value = useMemo<FileBrowserValue>(
    () => ({ kind: "system", state }),
    [state],
  );
  return (
    <FileBrowserContext.Provider value={value}>
      {children}
    </FileBrowserContext.Provider>
  );
}

/**
 * A browser's place while its host does not know what to browse yet (the
 * conversation whose checkout it shows is loading, the file system named is
 * none): the header items hold back, and `children` — the host's own state —
 * is the body.
 */
export function PendingFileBrowserProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return (
    <ExplorerControlsSlot.Provider>
      <FileBrowserContext.Provider value={HOST_PENDING}>
        {children}
      </FileBrowserContext.Provider>
    </ExplorerControlsSlot.Provider>
  );
}

function ReadyProvider({
  navigator,
  initialPath = HOME,
  root,
  fileTarget,
  preview: previewMode = "split",
  system,
  children,
}: FileBrowserProps & {
  system: ExplorerSystem;
  children: ReactNode;
}): ReactNode {
  const local = useLocalNavigator({
    fs: system.fs,
    dir: initialPath,
    open: null,
  });
  const nav = navigator ?? local;
  return (
    <WithLenses
      fs={system.fs}
      dir={absolutePath(nav.location.dir, system.home)}
    >
      {(lens) => (
        <PublishReady
          system={system}
          nav={nav}
          root={root}
          fileTarget={fileTarget}
          previewMode={previewMode}
          lens={lens}
        >
          {children}
        </PublishReady>
      )}
    </WithLenses>
  );
}

function PublishReady({
  system,
  nav,
  root,
  fileTarget,
  previewMode,
  lens,
  children,
}: {
  system: ExplorerSystem;
  nav: ExplorerNavigator;
  root: string | undefined;
  fileTarget: ((path: string) => Activation) | undefined;
  previewMode: "split" | "pane";
  lens: ComposedLens;
  children: ReactNode;
}): ReactNode {
  const { home } = system;
  const { dir, open } = nav.location;
  const [showHidden, setShowHidden] = useDraft(showHiddenStore, false);
  const [lensShown, setLensShown] = useDraft(lensShownStore, NONE_SHOWN);
  // The filter belongs to the folder: another folder starts it empty.
  const [filter, setFilter] = useState({ dir, query: "" });
  const query = filter.dir === dir ? filter.query : "";
  const pathSource = useFolderPathSource(system, root);

  const value = useMemo<FileBrowserReady>(() => {
    const atRoot =
      root !== undefined &&
      absolutePath(dir, home) === absolutePath(root, home);
    const up = atRoot ? null : parentPath(dir, home);
    return {
      kind: "ready",
      system,
      nav,
      root,
      fileTarget,
      previewMode,
      lens,
      showHidden,
      toggleHidden: () => setShowHidden(!showHidden),
      lensShown,
      toggleLens: (id) =>
        setLensShown({ ...lensShown, [id]: lensShown[id] !== true }),
      query,
      setQuery: (next) => setFilter({ dir, query: next }),
      up,
      upTarget: up === null ? undefined : nav.to(up, open),
      pathSource,
      pathTarget: (target) =>
        target.kind === "dir"
          ? nav.to(target.path, open)
          : nav.to(parentPath(target.path, home) ?? "/", target.path),
    };
  }, [
    system,
    nav,
    root,
    fileTarget,
    previewMode,
    lens,
    showHidden,
    setShowHidden,
    lensShown,
    setLensShown,
    query,
    dir,
    open,
    home,
    pathSource,
  ]);
  return (
    <FileBrowserContext.Provider value={value}>
      {children}
    </FileBrowserContext.Provider>
  );
}

/** The header items' view of the browser: only once it is ready. */
function useReadyHeader(): FileBrowserReady | null {
  const value = useFileBrowser();
  return value.kind === "ready" ? value : null;
}

/** Back / forward through the browser's history, and Up to the enclosing folder. */
export function FileBrowserNav(): ReactNode {
  const browser = useReadyHeader();
  if (browser === null) return null;
  const { nav, upTarget } = browser;
  return (
    // The mockup's tight 4px toolbar rhythm.
    <Line className="gap-xs">
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
    </Line>
  );
}

/**
 * The folder's place as the system's path bar — the browser panes' title
 * (`title.component`), so it takes the header's slack. Its type is the
 * container's (the pane title's, or the all-in-one bar's); only the current
 * folder's weight is its own.
 */
export function FileBrowserPath(): ReactNode {
  const browser = useReadyHeader();
  if (browser === null) return null;
  const { nav, pathSource, pathTarget } = browser;
  return (
    // The mockup sets the first crumb's text 18px past Up: the crumbs' own
    // insets (border + 2px + 2px) plus this 8px lead.
    <Fill className="pl-sm">
      <PathBar
        path={nav.location.dir}
        source={pathSource}
        activationFor={pathTarget}
        leafWeight="semibold"
      />
    </Fill>
  );
}

/** The folder's name filter. */
export function FileBrowserFilter(): ReactNode {
  const browser = useReadyHeader();
  if (browser === null) return null;
  const { query, setQuery, nav } = browser;
  return (
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
      // 180px, or 132px beside an open file; 130px at 1100px and under, and
      // gone at 900px and under.
      wrapperClassName={cn(
        nav.location.open === null ? "w-[180px]" : "w-[132px]",
        "max-[1100px]:w-[130px] max-[900px]:hidden",
      )}
    />
  );
}

/**
 * Show hidden files, each lens's hide-rule toggle, then the folder view's own
 * controls (view switcher, creators, sort / filter / fields), portaled in by
 * the tree into the cell this publishes.
 */
export function FileBrowserToggles(): ReactNode {
  const browser = useReadyHeader();
  if (browser === null) return null;
  return <ReadyToggles browser={browser} />;
}

function ReadyToggles({ browser }: { browser: FileBrowserReady }): ReactNode {
  const { showHidden, toggleHidden, lens, lensShown, toggleLens } = browser;
  const publishControls = ExplorerControlsSlot.usePublishRef();
  return (
    <Line className="gap-xs">
      <IconButton
        icon={showHidden ? hiddenOnIcon : hiddenOffIcon}
        label={showHidden ? "Hide hidden files" : "Show hidden files"}
        variant="ghost"
        onClick={toggleHidden}
      />
      {lens.hides.map((rule) => (
        <LensToggle
          key={rule.id}
          rule={rule}
          shown={lensShown[rule.id] === true}
          onToggle={() => toggleLens(rule.id)}
        />
      ))}
      {/* Empty — and collapsed — while no tree is mounted. */}
      <Line
        ref={publishControls}
        className={cn(rigidClass(), "gap-sm empty:hidden")}
      />
    </Line>
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
