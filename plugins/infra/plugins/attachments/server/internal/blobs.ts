import { defineHostService } from "@plugins/framework/plugins/server-core/core";

/**
 * Where attachment BYTES live. The rows (`attachments`, the owner links, the
 * holds) are portable tables; the bytes are the host's: the desktop's provider
 * (`attachments#machine`) writes one UUID-named file per attachment under
 * `~/.singularity/state/attachments/`, a host without a filesystem keeps them
 * in memory. A row records the key its blob was stored under (`disk_path`).
 */
export interface AttachmentBlobsImpl {
  /** Store `bytes` for the new attachment `id`; the key the row records. */
  write(id: string, filename: string, bytes: Uint8Array): Promise<string>;
  /** The bytes stored under `key`, or `null` when there are none (the file
   *  is gone) — a state the serve route answers `410` for. */
  read(key: string): Promise<Blob | null>;
  /** Drop the bytes under `key`. Best effort, after the row is already gone:
   *  bytes that are already missing are not an error, and a failure never
   *  undoes the row's deletion. */
  delete(key: string): Promise<void>;
  /** Make the store usable (`onReady`; before the first write too). */
  ensureRoot(): Promise<void>;
}

export const AttachmentBlobs =
  defineHostService<AttachmentBlobsImpl>("attachments.blobs");
