import { attachmentsByOwner } from "@plugins/infra/plugins/attachments/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  ImageGallery,
  ViewerThumbnail,
} from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The task's attachments, live. */
function useTaskAttachments(taskId: string) {
  return useLive(attachmentsByOwner, { ownerType: "tasks", id: taskId });
}

/**
 * A task with no attachments ⇒ the host paints no card at all. Not known yet
 * paints none either (the card appears once the files are known); a failed
 * read keeps the card painted so its body renders the failure.
 */
export function useAttachmentsAvailable({
  taskId,
}: {
  taskId: string;
}): boolean {
  return foldResource(useTaskAttachments(taskId), {
    loading: () => false,
    error: () => true,
    ready: (list) => list.length > 0,
  });
}

/** How many files this task carries; nothing until the count is known. */
export function TaskAttachmentsCount({ taskId }: { taskId: string }) {
  const attachments = useTaskAttachments(taskId);
  if (attachments.status !== "ready") return null;
  return (
    <Text as="span" variant="caption" tone="muted">
      {attachments.data.length}
    </Text>
  );
}

export function TaskAttachments({ taskId }: { taskId: string }) {
  const result = useTaskAttachments(taskId);
  if (result.status === "loading") return <Loading variant="rows" />;
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the attachments"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }
  const attachments = result.data;
  if (attachments.length === 0) return null;

  return (
    // The task's images are one ← / → set in the viewer.
    <ImageGallery>
      <Stack direction="row" wrap gap="md">
        {/* eslint-disable-next-line data-view/no-adhoc-row-list -- mixed inline-image + file-chip section; bespoke layout (DataView candidate tracked in follow-up task) */}
        {attachments.map((a) =>
          a.mime.startsWith("image/") ? (
            <ViewerThumbnail
              key={a.id}
              image={{
                src: `/api/attachments/${a.id}`,
                name: a.filename,
                sourceLabel: "Attached",
              }}
            />
          ) : (
            <Row
              key={a.id}
              href={`/api/attachments/${a.id}`}
              download={a.filename}
              bordered
            >
              <span>{a.filename}</span>
              <Text as="span" variant="caption" tone="muted">
                {formatSize(a.size)}
              </Text>
            </Row>
          ),
        )}
      </Stack>
    </ImageGallery>
  );
}
