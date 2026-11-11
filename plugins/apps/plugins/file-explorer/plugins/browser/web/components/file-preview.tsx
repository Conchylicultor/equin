import type { Gesture } from "@plugins/primitives/plugins/link-gesture/core";
import { gestureOf } from "@plugins/primitives/plugins/link-gesture/web";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { absolutePath } from "@plugins/infra/plugins/host-account/core";
import { Bar } from "@plugins/primitives/plugins/bar/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { subThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { PaneChrome, type AnyPane } from "@plugins/primitives/plugins/pane/web";
import {
  fileStatOf,
  type BrowsableFileSystem,
  type FileLocation,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { FileTypeIcon } from "@plugins/primitives/plugins/file-type/web";
import {
  FileContent,
  FileExpandButton,
  FileTabs,
  useArchiveMembership,
  useFileRenderers,
  useOpenHostFile,
  type FileRenderersHandle,
} from "@plugins/primitives/plugins/file-viewer/web";
import type { FileViewerGit } from "@plugins/primitives/plugins/file-viewer/core";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { FILES_SCOPE, filesDocumentTheme } from "../internal/theme";
import {
  useExplorerSystem,
  type ExplorerSystem,
} from "../internal/explorer-system";
import { WithLenses } from "../internal/lenses";
import { baseName, formatModified, formatSize, parentPath } from "../../core";

const closeIcon = symbol("close");

type ArchiveMembership = ReturnType<typeof useArchiveMembership>;

/** What a preview knows once its file system and `~` are known. */
interface FilePreviewReady {
  fs: BrowsableFileSystem;
  /** The file, in display form (`~/…`). */
  path: string;
  /** What `~` is in `fs`. */
  home: string;
  file: FileLocation;
  renderers: FileRenderersHandle;
  membership: ArchiveMembership;
  /**
   * Where the renderer's Expand (Open in Sonata) is drawn: in the header's
   * items, or by the host as its pane's own Expand — never both.
   */
  rendererExpand: RendererExpandPlacement;
}

/**
 * Who draws the active renderer's Expand: `"items"` — the preview's header
 * items, beside the tabs; `"pane"` — the host, as the Expand of its pane
 * (`PaneChrome`'s `expand`), in place of the pane's own.
 */
export type RendererExpandPlacement = "items" | "pane";

/**
 * The state the preview's header and body share: the file's name (known from
 * the first frame), and the rest (`ready`) once its file system answers —
 * `null` while that is read, so the title can name the file in the loading and
 * failed states and the other header items hold back.
 */
export interface FilePreviewValue {
  name: string;
  ready: FilePreviewReady | null;
}

const FilePreviewContext = createContext<FilePreviewValue | null>(null);

/** Publishes the preview's state to its header items and its body. */
export function FilePreviewProvider({
  value,
  children,
}: {
  value: FilePreviewValue;
  children: ReactNode;
}): ReactNode {
  return (
    <FilePreviewContext.Provider value={value}>
      {children}
    </FilePreviewContext.Provider>
  );
}

function useFilePreviewHeader(): FilePreviewValue {
  const value = useContext(FilePreviewContext);
  if (value === null) {
    throw new Error(
      "File-preview header item rendered outside FilePreviewProvider: the " +
        "preview's host wraps its PaneChrome in the provider, so the header " +
        "items only mount there.",
    );
  }
  return value;
}

function useReadyFilePreview(): FilePreviewReady {
  const { ready } = useFilePreviewHeader();
  if (ready === null) {
    throw new Error(
      "FilePreviewBody rendered before the preview was ready: render it " +
        "only where the host holds a ready preview (useFilePreview).",
    );
  }
  return ready;
}

/**
 * The state of the file `path` of `fs`, ready: its renderers (the tabs and the
 * body share them) and its archive membership. `name` is what to call it when
 * that is not its name on disk — an attachment is stored as `<uuid>.pdf` but
 * is the `report.pdf` the user attached. `git` is its git context, when a lens
 * knows it. `rendererExpand` is who draws the renderer's Expand.
 */
export function useFilePreview({
  fs,
  path,
  name,
  home,
  git,
  rendererExpand,
}: {
  fs: BrowsableFileSystem;
  path: string;
  name?: string;
  home: string;
  git: FileViewerGit | undefined;
  rendererExpand: RendererExpandPlacement;
}): FilePreviewValue {
  const file = useMemo(() => ({ fs, path }), [fs, path]);
  const renderers = useFileRenderers({
    file,
    ...(git !== undefined ? { git } : {}),
  });
  const membership = useArchiveMembership(file);
  const displayName = name ?? baseName(path);
  return useMemo(
    () => ({
      name: displayName,
      ready: { fs, path, home, file, renderers, membership, rendererExpand },
    }),
    [displayName, fs, path, home, file, renderers, membership, rendererExpand],
  );
}

/** The preview of a file whose file system is not known (yet): only its name. */
export function usePendingFilePreview(name: string): FilePreviewValue {
  return useMemo(() => ({ name, ready: null }), [name]);
}

/**
 * The preview's header title: a 20px box holding the file's type icon, its
 * name, and `parent · size · modified` under it.
 */
export function FilePreviewTitle(): ReactNode {
  const { name, ready } = useFilePreviewHeader();
  return (
    // The mockup's header: 10px between its parts.
    <Line className="gap-smd">
      {/* The mockup's 20px icon box holding a 14px glyph: the Seti glyphs are
          cropped to fill their box, so the box alone would draw them half
          again too large. */}
      <Center className={cn(rigidClass(), "size-5")}>
        <FileTypeIcon name={name} className="size-3.5" />
      </Center>
      <Fill>
        <Stack gap="none">
          <Text as="span" className="truncate font-semibold text-foreground">
            {name}
          </Text>
          {ready !== null && (
            <PreviewMeta fs={ready.fs} path={ready.path} home={ready.home} />
          )}
        </Stack>
      </Fill>
    </Line>
  );
}

/**
 * The active renderer's own Expand (the MIDI preview's Open in Sonata) —
 * unless the host draws it as its pane's Expand —, then the renderer tabs —
 * shown only when there is a choice (a changed file in a git checkout also
 * offers its diff).
 */
export function FilePreviewTabs(): ReactNode {
  const { ready } = useFilePreviewHeader();
  if (ready === null) return null;
  const { renderers, rendererExpand } = ready;
  return (
    <>
      {rendererExpand === "items" && <FileExpandButton renderers={renderers} />}
      {renderers.resolved.length > 1 && <FileTabs {...renderers} />}
    </>
  );
}

/**
 * Open with default app — only the computer's disk hands a file to its apps.
 * No button for an archive member (nothing on disk to open) or when there is
 * no telling; pending until the stat lands.
 */
export function OpenWithDefaultApp(): ReactNode {
  const { ready } = useFilePreviewHeader();
  const openHostFile = useOpenHostFile();
  if (ready === null || ready.fs !== "computer") return null;
  const { membership, path } = ready;
  if (
    membership.kind !== "loading" &&
    !(membership.kind === "known" && !membership.inArchive)
  ) {
    return null;
  }
  return (
    <IconButton
      icon={navIcons.hostApp}
      label="Open with default app"
      variant="ghost"
      disabled={membership.kind === "loading"}
      onClick={() => openHostFile(path)}
    />
  );
}

/**
 * The file's content, in the files-document theme: the file viewer's best
 * renderer for it.
 */
export function FilePreviewBody(): ReactNode {
  const { file, renderers } = useReadyFilePreview();
  return (
    <Column
      fill
      className="h-full"
      scrollBody={false}
      // The Files layout hides its sidebar beside an open file on a narrow
      // window, keyed on this mark.
      data-files-preview=""
      body={
        <Scroll axis="both" className="h-full">
          <Theme
            name={subThemeScope(filesDocumentTheme)}
            surface="none"
            // The code renderer is its own scroll box, sized to this height.
            className="h-full"
          >
            <FileContent file={file} renderers={renderers} />
          </Theme>
        </Scroll>
      }
    />
  );
}

/**
 * `parent · size · modified`, from the file's own stat (its system's `stat`,
 * pushed while read, so an edit on disk moves them). Only the parent until
 * the stat answers; a refusal says why in its place.
 */
function PreviewMeta({
  fs,
  path,
  home,
}: {
  fs: BrowsableFileSystem;
  path: string;
  home: string;
}): ReactNode {
  const stat = useLive(fileStatOf(fs), { path });
  const [now] = useState(() => Date.now());
  const parent = parentPath(path, home) ?? "/";
  const parts = [parent];
  if (stat.status === "ready") {
    parts.push(
      formatSize(stat.data.entry.size),
      formatModified(stat.data.entry.mtimeMs, now),
    );
  } else if (stat.status === "error") {
    switch (stat.error.code) {
      case "missing":
        parts.push("no longer exists");
        break;
      case "denied":
        parts.push("permission denied");
        break;
      case "unsupported":
      case "invalid-path":
        parts.push(stat.error.message);
        break;
      case undefined:
        // A read that failed (not a refusal): said, with its Retry, below.
        break;
    }
  }
  const failed =
    stat.status === "error" && stat.error.kind !== "refused" ? stat : null;
  return (
    // The small caption rung (`2xs`), faint.
    <ControlSizeProvider size="xs">
      <Text variant="caption" tone="faint" className="truncate">
        {parts.join(" · ")}
      </Text>
      {failed !== null && (
        <ResourceErrorInline
          variant="inline"
          error={failed.error}
          refetch={failed.refetch}
          subject="its size"
        />
      )}
    </ControlSizeProvider>
  );
}

/**
 * A file of `fs` previewed in a pane of its own — the column beside a
 * `preview: "pane"` browser — in Files' theme, as the browser is. The preview
 * state lives above `PaneChrome` in every branch, so the header names the file
 * while its file system loads.
 */
export function FilePreviewPane({
  pane,
  fs,
  path,
}: {
  pane: AnyPane;
  fs: BrowsableFileSystem;
  /** The file, in display form (`~/…`). */
  path: string;
}): ReactNode {
  const state = useExplorerSystem(fs);
  const name = baseName(path);
  return (
    <Theme name={FILES_SCOPE} surface="canvas" className="h-full">
      {state.kind === "ready" ? (
        <WithLenses
          fs={fs}
          dir={absolutePath(
            parentPath(path, state.system.home) ?? "/",
            state.system.home,
          )}
        >
          {(lens) => (
            <ReadyFilePreviewPane
              pane={pane}
              system={state.system}
              path={path}
              git={lens.fileGit(absolutePath(path, state.system.home))}
            />
          )}
        </WithLenses>
      ) : (
        <PendingFilePreviewPane pane={pane} name={name}>
          {state.kind === "pending" ? (
            <Loading variant="rows" />
          ) : state.kind === "failed" ? (
            <ResourceErrorInline
              variant="block"
              subject="this file system"
              error={state.error}
              refetch={state.refetch}
            />
          ) : (
            <Placeholder>{state.message}</Placeholder>
          )}
        </PendingFilePreviewPane>
      )}
    </Theme>
  );
}

function ReadyFilePreviewPane({
  pane,
  system,
  path,
  git,
}: {
  pane: AnyPane;
  system: ExplorerSystem;
  path: string;
  git: FileViewerGit | undefined;
}): ReactNode {
  const preview = useFilePreview({
    fs: system.fs,
    path,
    home: system.home,
    git,
    rendererExpand: "pane",
  });
  // Already in Files beside its folder, the preview has no fuller view of its
  // own: Expand is the file's in the app that plays it (Open in Sonata), and
  // absent for a file no renderer opens elsewhere.
  const expand = preview.ready?.renderers.expand ?? undefined;
  return (
    <FilePreviewProvider value={preview}>
      <PaneChrome pane={pane} expand={expand}>
        <FilePreviewBody />
      </PaneChrome>
    </FilePreviewProvider>
  );
}

/**
 * A preview pane whose file is not readable yet (its file system loading,
 * failed, or absent): the standard header, named by `name`, over `children`.
 */
export function PendingFilePreviewPane({
  pane,
  name,
  children,
}: {
  pane: AnyPane;
  name: string;
  children: ReactNode;
}): ReactNode {
  const preview = usePendingFilePreview(name);
  return (
    <FilePreviewProvider value={preview}>
      <PaneChrome pane={pane}>{children}</PaneChrome>
    </FilePreviewProvider>
  );
}

/**
 * The open file of a browser over `system`, previewed INSIDE the pane that
 * holds the browser (the in-pane split — a region, not a pane): a sub-header
 * laying the same title, tabs and Open with default app items as the pane
 * header does, then Close, over the file's body.
 */
export function SplitPreview({
  system,
  path,
  onClose,
}: {
  system: ExplorerSystem;
  /** The file, in display form (`~/…`). */
  path: string;
  /** Absent where there is nothing to close to. */
  onClose: ((gesture: Gesture) => void) | undefined;
}): ReactNode {
  const { home } = system;
  return (
    <WithLenses
      fs={system.fs}
      dir={absolutePath(parentPath(path, home) ?? "/", home)}
    >
      {(lens) => (
        <SplitPreviewReady
          system={system}
          path={path}
          git={lens.fileGit(absolutePath(path, home))}
          onClose={onClose}
        />
      )}
    </WithLenses>
  );
}

function SplitPreviewReady({
  system,
  path,
  git,
  onClose,
}: {
  system: ExplorerSystem;
  path: string;
  git: FileViewerGit | undefined;
  onClose: ((gesture: Gesture) => void) | undefined;
}): ReactNode {
  const preview = useFilePreview({
    fs: system.fs,
    path,
    home: system.home,
    git,
    rendererExpand: "items",
  });
  return (
    <FilePreviewProvider value={preview}>
      <Column
        fill
        className="h-full"
        scrollBody={false}
        header={
          // Below the pane header that holds the browser, never at the
          // surface's top-right corner: no floating-bar safe area.
          <Bar tier="subpane" className="gap-smd">
            <Fill>
              <Text as="div" variant="label">
                <FilePreviewTitle />
              </Text>
            </Fill>
            <FilePreviewTabs />
            <OpenWithDefaultApp />
            {onClose && (
              <IconButton
                icon={closeIcon}
                label="Close (Esc)"
                variant="ghost"
                onClick={(e) => onClose(gestureOf(e))}
              />
            )}
          </Bar>
        }
        body={<FilePreviewBody />}
      />
    </FilePreviewProvider>
  );
}
