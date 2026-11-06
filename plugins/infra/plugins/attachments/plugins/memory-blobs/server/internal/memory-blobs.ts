import { hostStorage } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";
import type { AttachmentBlobsImpl } from "@plugins/infra/plugins/attachments/server";

// The bytes of every attachment, keyed by the attachment id (the key its row
// records). Held in memory and written through to the host's storage
// (`attachment-blobs`), so a persistent host keeps them across reloads; loaded
// on first use, never at module evaluation.
// Bytes hold no instant: a snapshot's shift leaves them as they are.
const persisted = () =>
  hostStorage().store<Blob>("attachment-blobs", { shiftTime: (blob) => blob });
let held: Map<string, Blob> | null = null;
const blobs = (): Map<string, Blob> => (held ??= new Map(persisted().loaded));

export const memoryBlobs: AttachmentBlobsImpl = {
  async write(id, _filename, bytes) {
    const blob = new Blob([new Uint8Array(bytes)]);
    blobs().set(id, blob);
    persisted().put(id, blob);
    return id;
  },
  async read(key) {
    return blobs().get(key) ?? null;
  },
  async delete(key) {
    blobs().delete(key);
    persisted().delete(key);
  },
  async ensureRoot() {},
};
