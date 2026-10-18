import type { AttachmentBlobsImpl } from "@plugins/infra/plugins/attachments/server";

// The bytes of every attachment, keyed by the attachment id (the key its row
// records). Lost with the process.
const blobs = new Map<string, Blob>();

export const memoryBlobs: AttachmentBlobsImpl = {
  async write(id, _filename, bytes) {
    blobs.set(id, new Blob([new Uint8Array(bytes)]));
    return id;
  },
  async read(key) {
    return blobs.get(key) ?? null;
  },
  async delete(key) {
    blobs.delete(key);
  },
  async ensureRoot() {},
};
