import {
  attachmentsByOwner,
  getAttachmentFile,
  type Attachment,
} from "@plugins/infra/plugins/attachments/core";
import {
  assetPath,
  type AssetPath,
} from "@plugins/infra/plugins/endpoints/core";
import { useAssetSrc } from "@plugins/infra/plugins/endpoints/web";
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
  AssetThumbnail,
  ImageGallery,
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
        {attachments.map((a) => (
          <TaskAttachment key={a.id} attachment={a} />
        ))}
      </Stack>
    </ImageGallery>
  );
}

/**
 * One attachment: an image as a thumbnail of the task's set, any other file a
 * download row — its bytes loaded over the subtree's transport (`useAssetSrc`).
 */
function TaskAttachment({ attachment: a }: { attachment: Attachment }) {
  const asset = assetPath(getAttachmentFile, { id: a.id });
  if (a.mime.startsWith("image/")) {
    return (
      <AssetThumbnail
        asset={asset}
        image={{ name: a.filename, sourceLabel: "Attached" }}
      />
    );
  }
  return <TaskAttachmentFile attachment={a} asset={asset} />;
}

/** A non-image attachment: a row that downloads it once its bytes are loadable. */
function TaskAttachmentFile({
  attachment: a,
  asset,
}: {
  attachment: Attachment;
  asset: AssetPath;
}) {
  const src = useAssetSrc(asset);
  return (
    <Row
      href={src.kind === "ready" ? src.src : undefined}
      download={a.filename}
      bordered
    >
      <span>{a.filename}</span>
      <Text as="span" variant="caption" tone="muted">
        {formatSize(a.size)}
      </Text>
    </Row>
  );
}
