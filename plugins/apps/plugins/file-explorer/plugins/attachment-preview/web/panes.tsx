import { useMemo, type ReactNode } from "react";
import {
  Pane,
  defineRoute,
  useOpenPane,
  useReservesFloatingBar,
} from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  matchResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { attachmentFile } from "@plugins/infra/plugins/attachments/core";
import type { AttachedFileRef } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import {
  PreviewPane,
  useHomeDir,
} from "@plugins/apps/plugins/file-explorer/plugins/browser/web";
import { displayPath } from "@plugins/apps/plugins/file-explorer/plugins/browser/core";

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
  title: { useText: useAttachmentTitle },
  useResolve: false,
  // Opened from a prompt at an app's bare root (the agent manager's home), it
  // stays beside that home rather than replacing it.
  companion: true,
  component: AttachmentPreview,
  width: 640,
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
  const close = attachmentPreviewPane.useClose();
  const endSafeArea = useReservesFloatingBar();
  if (home.kind === "pending") return <Loading />;
  if (home.kind === "failed") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="your home folder"
        error={home.error}
        refetch={home.refetch}
      />
    );
  }
  return matchResource(file, {
    loading: () => <Loading />,
    error: (error) => (
      <ResourceErrorInline
        variant="inline"
        subject="this attachment"
        error={error}
        refetch={file.refetch}
      />
    ),
    ready: (data) => (
      <PreviewPane
        key={data.id}
        path={displayPath(data.diskPath, home.home)}
        name={data.filename}
        home={home.home}
        git={undefined}
        onClose={close ?? undefined}
        closeLabel="Close"
        endSafeArea={endSafeArea}
      />
    ),
  });
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
