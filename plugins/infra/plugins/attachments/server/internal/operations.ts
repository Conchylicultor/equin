import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { _attachments } from "./tables";
import { AttachmentBlobs } from "./blobs";
import type { Attachment } from "../../shared/types";

// Mint an attachment from raw bytes (server-side seeding, no HTTP round-trip).
// Stores the bytes (`AttachmentBlobs` — a file on the desktop) and inserts an
// unlinked `_attachments` row; callers
// link the returned id from their own submit path (see `Attachments.defineLink`).
export async function createAttachment(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<Attachment> {
  const id = crypto.randomUUID();
  const diskPath = await AttachmentBlobs.get().write(id, filename, bytes);

  const [row] = await db
    .insert(_attachments)
    .values({
      id,
      filename,
      mime,
      size: bytes.byteLength,
      diskPath,
    })
    .returning();

  if (!row) throw new Error("failed to record attachment");
  return toAttachment(row);
}

export async function getAttachment(id: string): Promise<Attachment | null> {
  const [row] = await db
    .select()
    .from(_attachments)
    .where(eq(_attachments.id, id))
    .limit(1);
  return row ? toAttachment(row) : null;
}

export async function deleteAttachment(id: string): Promise<boolean> {
  const [row] = await db
    .delete(_attachments)
    .where(eq(_attachments.id, id))
    .returning({ diskPath: _attachments.diskPath });
  if (!row) return false;
  // Best-effort blob cleanup, after the DB row is already deleted.
  await AttachmentBlobs.get().delete(row.diskPath);
  return true;
}

function toAttachment(row: typeof _attachments.$inferSelect): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    diskPath: row.diskPath,
    createdAt: row.createdAt.toISOString(),
  };
}
