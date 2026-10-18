import { stat, unlink } from "node:fs/promises";
import type { AttachmentBlobsImpl } from "@plugins/infra/plugins/attachments/server";
import { diskPathFor, ensureAttachmentsRoot } from "./paths";

/**
 * The desktop's attachment bytes: one UUID-named file per attachment under the
 * host-global `state/attachments` data dir, the row's key being the file's
 * absolute path.
 */
export const fileBlobs: AttachmentBlobsImpl = {
  async write(id, filename, bytes) {
    await ensureAttachmentsRoot();
    const diskPath = diskPathFor(id, filename);
    await Bun.write(diskPath, bytes);
    return diskPath;
  },
  async read(diskPath) {
    try {
      await stat(diskPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return null;
    }
    return Bun.file(diskPath);
  },
  async delete(diskPath) {
    // eslint-disable-next-line promise-safety/no-absorbed-failure -- best-effort disk cleanup after the DB row is already deleted; the awaited result is discarded, so undefined only prevents an unhandled rejection, never feeds a decision
    await unlink(diskPath).catch(() => undefined);
  },
  async ensureRoot() {
    await ensureAttachmentsRoot();
  },
};
