import { useMemo, type ReactNode } from "react";
import {
  Pane,
  defineRoute,
  useOpenPane,
  PaneChrome,
} from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  matchResource,
  ResourceErrorInline,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { attachmentFile } from "@plugins/infra/plugins/attachments/core";
import type { AttachedFileRef } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import {
  FilePreviewBody,
  FilePreviewHeader,
  FilePreviewProvider,
  FilePreviewTitle,
  PendingFilePreviewPane,
  useFilePreview,
  useHomeDir,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import { displayPath } from "@plugins/infra/plugins/host-account/core";

/**
 * `attachment/:id` — a file someone attached (to a prompt, a task), previewed
 * through the Files preview: every renderer tab the file viewer offers for it,
 * Open with default app, and its size and age.
 *
 * Its home is Files, but it opens BESIDE whatever surface holds the chip — the
 * agent manager's home, a conversation, the Improve popover over any app — so
 * Expand ("Open in Files") is the one move that leaves the host.
 */
export const attachmentPreviewPane = Pane.define({
  route: defineRoute({ id: "attachment-preview", segment: "attachment/:id" }),
  app: fileExplorerApp,
  title: { useText: useAttachmentTitle, component: FilePreviewTitle },
  actions: FilePreviewHeader,
  useResolve: false,
  // Opened from a prompt at an app's bare root (the agent manager's home), it
  // stays beside that home rather than replacing it.
  companion: true,
  component: AttachmentPreview,
});

function useAttachmentTitle(params: { id: string }): string {
  const file = useLive(attachmentFile, { id: params.id });
  // The tab title is a word, not a state: loading and a failed read both name
  // the pane by its kind, and the body says which one it is.
  return foldResource(file, {
    loading: () => "Attachment",
    error: () => "Attachment",
    ready: (data) => data.filename,
  });
}

function AttachmentPreview(): ReactNode {
  const { id } = attachmentPreviewPane.useParams();
  const file = useLive(attachmentFile, { id });
  const home = useHomeDir();
  // The header names the attachment ("Attachment" until it is read) in every
  // state, so the pane always wears the standard header.
  const pending = (body: ReactNode): ReactNode => (
    <PendingFilePreviewPane pane={attachmentPreviewPane} name="Attachment">
      {body}
    </PendingFilePreviewPane>
  );
  if (home.kind === "pending") return pending(<Loading />);
  if (home.kind === "failed") {
    return pending(
      <ResourceErrorInline
        variant="inline"
        subject="your home folder"
        error={home.error}
        refetch={home.refetch}
      />,
    );
  }
  if (home.kind === "unavailable") {
    return pending(<Placeholder>{home.message}</Placeholder>);
  }
  return matchResource(file, {
    loading: () => pending(<Loading />),
    error: (error) =>
      pending(
        <ResourceErrorInline
          variant="inline"
          subject="this attachment"
          error={error}
          refetch={file.refetch}
        />,
      ),
    ready: (data) => (
      <ReadyAttachmentPreview
        key={data.id}
        path={displayPath(data.diskPath, home.home)}
        name={data.filename}
        home={home.home}
      />
    ),
  });
}

function ReadyAttachmentPreview({
  path,
  name,
  home,
}: {
  path: string;
  name: string;
  home: string;
}): ReactNode {
  const preview = useFilePreview({
    fs: "computer",
    path,
    name,
    home,
    git: undefined,
  });
  return (
    <FilePreviewProvider value={preview}>
      <PaneChrome pane={attachmentPreviewPane}>
        <FilePreviewBody />
      </PaneChrome>
    </FilePreviewProvider>
  );
}

/**
 * A file chip's link: the preview beside everything already on screen — the
 * caller is often not a pane at all (the Improve popover), so the open appends
 * rather than pushing relative to one.
 */
export function useAttachmentPreviewTarget(): (
  file: AttachedFileRef,
) => LinkTarget {
  const openPane = useOpenPane();
  return useMemo(
    () => (file: AttachedFileRef) =>
      openPane.to(
        attachmentPreviewPane,
        { id: file.attachmentId },
        { mode: "append" },
      ),
    [openPane],
  );
}
