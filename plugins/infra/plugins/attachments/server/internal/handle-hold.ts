import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { holdAttachmentsEndpoint } from "../../shared/endpoints";
import { _attachmentHolds, _attachments } from "./tables";

// Reconcile one holder's held set to exactly `ids`, all expiring `ttlMs` from
// now. One transaction: release what the holder dropped, then upsert the rest
// that still exist — an id already gone is skipped rather than an FK
// violation.
export const handleHold = implement(
  holdAttachmentsEndpoint,
  async ({ body: { holder, ids, ttlMs } }) => {
    const expiresAt = ttlMs === null ? null : new Date(Date.now() + ttlMs);
    await db.transaction(async (tx) => {
      await tx
        .delete(_attachmentHolds)
        .where(
          ids.length === 0
            ? eq(_attachmentHolds.holder, holder)
            : and(
                eq(_attachmentHolds.holder, holder),
                notInArray(_attachmentHolds.attachmentId, ids),
              ),
        );
      if (ids.length === 0) return;
      const existing = await tx
        .select({ id: _attachments.id })
        .from(_attachments)
        .where(inArray(_attachments.id, ids));
      if (existing.length === 0) return;
      await tx
        .insert(_attachmentHolds)
        .values(
          existing.map(({ id }) => ({ holder, attachmentId: id, expiresAt })),
        )
        .onConflictDoUpdate({
          target: [_attachmentHolds.holder, _attachmentHolds.attachmentId],
          set: { expiresAt: sql`excluded.expires_at` },
        });
    });
  },
);
