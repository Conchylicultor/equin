import { AssetThumbnail } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { attachmentUrl } from "../internal/markdown";

/**
 * A pasted image: the capped thumbnail that opens the full-window viewer. In an
 * editor its node wraps it in `TokenFrame` (selection ring, Remove). Its bytes
 * load over the subtree's transport (`AssetThumbnail`).
 */
export function AttachmentThumbnail({
  attachmentId,
  alt,
}: {
  attachmentId: string;
  alt?: string;
}) {
  return (
    <AssetThumbnail
      size="chip"
      asset={attachmentUrl(attachmentId)}
      image={{
        name: alt || "Pasted image",
        sourceLabel: "Pasted",
        alt: alt || undefined,
      }}
    />
  );
}
