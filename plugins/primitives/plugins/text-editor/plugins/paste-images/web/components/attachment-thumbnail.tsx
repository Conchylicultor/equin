import { ViewerThumbnail } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { attachmentUrl } from "../internal/markdown";

/**
 * A pasted image: the capped thumbnail that opens the full-window viewer. In an
 * editor its node wraps it in `TokenFrame` (selection ring, Remove).
 */
export function AttachmentThumbnail({
  attachmentId,
  alt,
}: {
  attachmentId: string;
  alt?: string;
}) {
  return (
    <ViewerThumbnail
      size="chip"
      image={{
        src: attachmentUrl(attachmentId),
        name: alt || "Pasted image",
        sourceLabel: "Pasted",
        alt: alt || undefined,
      }}
    />
  );
}
