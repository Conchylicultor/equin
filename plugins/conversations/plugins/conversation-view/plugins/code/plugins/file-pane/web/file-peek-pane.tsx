import { useMemo } from "react";
import {
  Pane,
  PaneChrome,
  useOpenPane,
  defineRoute,
  type PaneExpandTarget,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useEditedFile } from "@plugins/conversations/plugins/conversation-view/plugins/code/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import {
  useResolvedFile,
  FileDisambiguation,
} from "@plugins/code-explorer/plugins/file-resolve/web";
import {
  FileContent,
  useFileRenderers,
} from "@plugins/primitives/plugins/file-viewer/web";
import {
  fileRefForPath,
  type FileRef,
} from "@plugins/primitives/plugins/file-viewer/core";
import { FileLinksWorkspaceProvider } from "@plugins/primitives/plugins/file-links/web";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import { useExplorerFileTarget } from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import {
  FilePeekHeaderProvider,
  FilePeekTitle,
} from "./components/file-peek-header";

/** The path as requested and its `:line` suffix, split. */
function splitLine(rawFilePath: string): { filePath: string; line?: number } {
  const lineMatch = rawFilePath.match(/:(\d+)$/);
  return lineMatch
    ? {
        filePath: rawFilePath.slice(0, -lineMatch[0]!.length),
        line: parseInt(lineMatch[1]!, 10),
      }
    : { filePath: rawFilePath };
}

/**
 * The path's resolution, and the file the pane reads: the resolved one, else
 * the path as requested (a relative one from the checkout, an absolute or `~`
 * one from the host).
 */
function usePeekedFile(worktree: string, filePath: string) {
  const resolved = useResolvedFile(worktree, filePath);
  const file: FileRef =
    resolved.status === "resolved" || resolved.status === "exact"
      ? resolved.file
      : fileRefForPath(worktree, filePath);
  return { resolved, file };
}

/**
 * Expand opens the file in Files — its folder listed, the file previewed —
 * once the path settles on one file.
 */
function useExpandToFiles(params: {
  worktree: string;
  filePath: string;
}): PaneExpandTarget {
  const { filePath } = splitLine(params.filePath);
  const { resolved, file } = usePeekedFile(params.worktree, filePath);
  const target = useExplorerFileTarget(file);
  if (resolved.status === "loading") return { kind: "pending" };
  if (resolved.status !== "resolved" && resolved.status !== "exact") {
    return { kind: "none" };
  }
  return target;
}

/** The file's basename, minus any trailing `:line` suffix. */
function fileTitle(filePath: string): string {
  const path = filePath.replace(/:\d+$/, "");
  return path.slice(path.lastIndexOf("/") + 1);
}

export const filePeekPane = Pane.define({
  route: defineRoute({
    id: "file-peek",
    segment: "file/:worktree/:filePath*",
  }),
  app: agentManagerApp,
  component: FilePeekPaneBody,
  // Tab/document title: the file name from the URL param, so a deep link
  // shows the file instead of the bare app name. The header paints the path as
  // a breadcrumb (FilePeekTitle); the renderer tabs beside it are a header item.
  title: {
    useText: ({ filePath }) => fileTitle(filePath),
    component: FilePeekTitle,
  },
  chrome: { history: false },
  expand: { app: fileExplorerApp, useTarget: useExpandToFiles },
  width: 600,
  useResolve: false,
});

// Paths inside the peeked file (a markdown file's links, say) name the same
// checkout the file was read from.
function FilePeekPaneBody() {
  const { worktree } = filePeekPane.useParams();
  return (
    <FileLinksWorkspaceProvider workspace={worktree}>
      <FilePeekPaneContent />
    </FileLinksWorkspaceProvider>
  );
}

function FilePeekPaneContent() {
  const openPane = useOpenPane();
  const convId = conversationPane.useRouteEntry()?.params.convId;

  const { worktree, filePath: rawFilePath } = filePeekPane.useParams();

  const { filePath, line } = splitLine(rawFilePath);

  // Read the resolved file directly instead of swapping the pane — a swap
  // re-mounts the component (new URL → new params → new fetches), which
  // destroys in-progress text selection. Until (or unless) it resolves, the
  // path as requested: a relative one from the checkout, an absolute or `~`
  // one from the host, so a miss is reported by whichever source owns it.
  const { resolved, file } = usePeekedFile(worktree, filePath);
  const effectivePath = file.path;

  // This one file's entry in the edited set (`null`: clean), wherever in the
  // set it falls. Only a workspace file has one: a host file sits outside the
  // worktree, so it reads nothing.
  const fileResult = useEditedFile(
    file.source === "workspace" ? (convId ?? null) : null,
    file.path,
  );
  // `status` is a derived renderer hint, so an unknown file set (loading, a
  // failed read, an unresolved worktree, or a host without the computer to
  // measure it) safely defaults to "clean" — no display surface here; the file
  // content itself is a separate read, which renders its own unavailability.
  const status = foldResource(fileResult, {
    loading: () => "clean" as const,
    error: () => "clean" as const,
    unavailable: () => "clean" as const,
    ready: (entry) =>
      entry.resolved && file.source === "workspace"
        ? (entry.value?.status ?? "clean")
        : "clean",
  });
  const renderers = useFileRenderers({
    file,
    ...(file.source === "workspace"
      ? { git: { checkout: file.workspace, path: file.path, status } }
      : {}),
  });

  // The header's title and renderer tabs read this (see file-peek-header): the
  // requested path and no tabs until the path resolves to one file (or to
  // none, whose miss the file content reports).
  const settled =
    resolved.status === "exact" ||
    resolved.status === "resolved" ||
    resolved.status === "not-found";
  const header = useMemo(
    () =>
      settled
        ? { path: effectivePath, renderers }
        : { path: filePath, renderers: null },
    [settled, effectivePath, filePath, renderers],
  );

  if (resolved.status === "loading") {
    return (
      <FilePeekHeaderProvider value={header}>
        <PaneChrome pane={filePeekPane}>
          <Text
            as="div"
            variant="body"
            className="px-md py-sm text-muted-foreground"
          >
            Resolving…
          </Text>
        </PaneChrome>
      </FilePeekHeaderProvider>
    );
  }

  // The resolution itself could not be answered (a refused workspace, a failed
  // read, a host without the computer): said as such, never read as a miss.
  if (resolved.status === "error" || resolved.status === "unavailable") {
    return (
      <FilePeekHeaderProvider value={header}>
        <PaneChrome pane={filePeekPane}>
          {resolved.status === "error" ? (
            <ResourceErrorInline
              variant="block"
              subject={`where ${filePath} is`}
              error={resolved.read.error}
              refetch={resolved.read.refetch}
            />
          ) : (
            <Placeholder>{resolved.message}</Placeholder>
          )}
        </PaneChrome>
      </FilePeekHeaderProvider>
    );
  }

  if (resolved.status === "ambiguous") {
    return (
      <FilePeekHeaderProvider value={header}>
        <PaneChrome pane={filePeekPane}>
          <FileDisambiguation
            query={filePath}
            matches={resolved.matches}
            total={resolved.total}
            activationFor={(fp) =>
              openPane.to(
                filePeekPane,
                {
                  worktree,
                  filePath: line != null ? `${fp}:${line}` : fp,
                },
                { mode: "swap" },
              )
            }
          />
        </PaneChrome>
      </FilePeekHeaderProvider>
    );
  }

  return (
    <FilePeekHeaderProvider value={header}>
      <PaneChrome pane={filePeekPane}>
        <FileContent file={file} line={line} active={renderers.active} />
      </PaneChrome>
    </FilePeekHeaderProvider>
  );
}
