import { hostStorage } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";
import type { AttachmentBlobsImpl } from "@plugins/infra/plugins/attachments/server";

// The bytes of every attachment, keyed by the attachment id (the key its row
// records). Held in memory and written through to the host's storage
// (`attachment-blobs`), so a persistent host keeps them across reloads; loaded
// on first use, never at module evaluation. Kept as bytes, a Blob made on each
// read: a host store never holds a Blob (WebKit's IndexedDB cannot store one).
// Bytes hold no instant: a snapshot's shift leaves them as they are.
const persisted = () =>
  hostStorage().store<Uint8Array>("attachment-blobs", {
    shiftTime: (bytes) => bytes,
  });
let held: Map<string, Uint8Array> | null = null;
const blobs = (): Map<string, Uint8Array> =>
  (held ??= new Map(persisted().loaded));

export const memoryBlobs: AttachmentBlobsImpl = {
  async write(id, _filename, bytes) {
    const copy = new Uint8Array(bytes);
    blobs().set(id, copy);
    persisted().put(id, copy);
    return id;
  },
  async read(key) {
    const bytes = blobs().get(key);
    return bytes === undefined ? null : new Blob([bytes as BlobPart]);
  },
  async delete(key) {
    blobs().delete(key);
    persisted().delete(key);
  },
  async ensureRoot() {},
};
