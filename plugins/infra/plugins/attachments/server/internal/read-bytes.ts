import { AttachmentBlobs } from "./blobs";
import { getAttachment } from "./operations";

/** An attachment whose row or bytes are gone from this host. */
export class AttachmentMissingError extends Error {
  constructor(
    readonly attachmentId: string,
    readonly part: "row" | "bytes",
  ) {
    super(
      part === "row"
        ? `attachment not found: ${attachmentId}`
        : `the bytes of attachment ${attachmentId} are gone from the store`,
    );
    this.name = "AttachmentMissingError";
  }
}

/**
 * An attachment's bytes, read from the host's blob store by the key its row
 * recorded — on every host (the desktop's files, a browser host's memory).
 * Throws {@link AttachmentMissingError} when the row or its bytes are gone.
 */
export async function readAttachmentBytes(
  attachmentId: string,
): Promise<Uint8Array> {
  const att = await getAttachment(attachmentId);
  if (!att) throw new AttachmentMissingError(attachmentId, "row");
  const blob = await AttachmentBlobs.get().read(att.diskPath);
  if (blob === null) throw new AttachmentMissingError(attachmentId, "bytes");
  return new Uint8Array(await blob.arrayBuffer());
}
