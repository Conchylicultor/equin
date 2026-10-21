import { useMemo } from "react";
import {
  Pane,
  PaneChrome,
  useOpenPane,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useEditedFiles } from "@plugins/conversations/plugins/conversation-view/plugins/code/web";
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
import {
  FilePeekHeaderProvider,
  FilePeekTitle,
} from "./components/file-peek-header";

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
  width: 600,
  useResolve: false,
});

function FilePeekPaneBody() {
  const openPane = useOpenPane();
  const convId = conversationPane.useRouteEntry()?.params.convId;

  const { worktree, filePath: rawFilePath } = filePeekPane.useParams();

  const lineMatch = rawFilePath.match(/:(\d+)$/);
  const line = lineMatch ? parseInt(lineMatch[1]!, 10) : undefined;
  const filePath = lineMatch
    ? rawFilePath.slice(0, -lineMatch[0]!.length)
    : rawFilePath;

  const resolved = useResolvedFile(worktree, filePath);

  // Read the resolved file directly instead of swapping the pane — a swap
  // re-mounts the component (new URL → new params → new fetches), which
  // destroys in-progress text selection. Until (or unless) it resolves, the
  // path as requested: a relative one from the checkout, an absolute or `~`
  // one from the host, so a miss is reported by whichever source owns it.
  const file: FileRef =
    resolved.status === "resolved" || resolved.status === "exact"
      ? resolved.file
      : fileRefForPath(worktree, filePath);
  const effectivePath = file.path;

  const filesResult = useEditedFiles(convId ?? null);
  // `status` is a derived renderer hint, so an unknown file set (loading, a
  // failed read, an unresolved worktree, or a host without the computer to
  // measure it) safely defaults to "clean" — no display surface here; the file
  // content itself is a separate read, which renders its own unavailability.
  // Only a workspace file has one: a host file sits outside the worktree.
  const status = foldResource(filesResult, {
    loading: () => "clean" as const,
    error: () => "clean" as const,
    unavailable: () => "clean" as const,
    ready: (files) =>
      files.resolved && file.source === "workspace"
        ? (files.value.find((f) => f.path === file.path)?.status ?? "clean")
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
