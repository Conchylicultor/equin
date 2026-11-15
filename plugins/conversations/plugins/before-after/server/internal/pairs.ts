import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { createAttachment } from "@plugins/infra/plugins/attachments/server";
import type { IdReferent } from "@plugins/ids/server";
import { baIdKind, type BaId, type BeforeAfterColorScheme } from "../../core";
import { _beforeAfterPairs } from "./tables";
import { beforeAfterPairAttachments } from "./schema-attachments";

/** What a registered pair records — its images as PNG bytes. */
export interface NewBeforeAfterPair {
  conversationId: string;
  toolUseId: string | null;
  title: string;
  route: string | null;
  width: number;
  height: number;
  colorScheme: BeforeAfterColorScheme | null;
  before: { png: Uint8Array; label: string };
  after: { png: Uint8Array; label: string };
}

/**
 * Store a pair: mint its id, store both PNGs as attachments, insert the row
 * and link the images to it (so the orphan sweep keeps them). Returns the id.
 */
export async function registerBeforeAfterPair(
  pair: NewBeforeAfterPair,
): Promise<BaId> {
  const id = baIdKind.mint();
  const [before, after] = await Promise.all([
    createAttachment(pair.before.png, `${id}-before.png`, "image/png"),
    createAttachment(pair.after.png, `${id}-after.png`, "image/png"),
  ]);
  await db.insert(_beforeAfterPairs).values({
    id,
    conversationId: pair.conversationId,
    toolUseId: pair.toolUseId,
    title: pair.title,
    route: pair.route,
    width: pair.width,
    height: pair.height,
    colorScheme: pair.colorScheme,
    beforeAttachmentId: before.id,
    afterAttachmentId: after.id,
    beforeLabel: pair.before.label,
    afterLabel: pair.after.label,
  });
  await beforeAfterPairAttachments.add(id, [before.id, after.id]);
  return id;
}

/** A `ba-…`'s title, for the id registry and text a model reads. */
export async function resolveBeforeAfterReferent(
  id: string,
): Promise<IdReferent> {
  const [row] = await db
    .select({ title: _beforeAfterPairs.title })
    .from(_beforeAfterPairs)
    .where(eq(_beforeAfterPairs.id, baIdKind.key(id)))
    .limit(1);
  return row ? { found: true, title: row.title } : { found: false };
}
