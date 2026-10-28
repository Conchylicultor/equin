import { InlineText } from "@plugins/primitives/plugins/inline-text/web";
import { splitAttachmentRefs } from "../internal/markdown";
import { AttachmentThumbnail } from "./attachment-thumbnail";
import { AttachmentFileChip } from "./attachment-file-chip";

/**
 * A text editor's markdown drawn read-only: the text through every inline-text
 * walker (file links, chips), each attachment ref as the thumbnail or file chip
 * the editor showed it as. Inline content — the caller owns the block and its
 * whitespace (`whitespace-pre-wrap`). Each run carries its source offset as
 * `data-vstart`, so a display can map a selection back to the source.
 */
export function AttachmentText({ text }: { text: string }) {
  return (
    <>
      {splitAttachmentRefs(text).map((seg) => (
        <span key={seg.start} data-vstart={seg.start}>
          {seg.kind === "text" ? (
            <InlineText text={seg.value} />
          ) : seg.kind === "image" ? (
            <AttachmentThumbnail attachmentId={seg.id} alt={seg.alt} />
          ) : (
            <AttachmentFileChip attachmentId={seg.id} filename={seg.alt} />
          )}
        </span>
      ))}
    </>
  );
}
