import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { updateBlock } from "../../core";
import { BlockSchema } from "../../core";
import { liveBlocks } from "./live-blocks";
import { withPageForest } from "./page-forest";
import { updateBlockFields, type BlockColumnChanges } from "./forest-writer";
import { notifyBlockChange } from "./notify";
import { rewriteBlockData } from "./parse-block-data";

export const handleUpdateBlock = implement(
  updateBlock,
  async ({ params, body }) => {
    // The row's page scope names the forest to lock; its `type` is what `data`
    // must be validated against (`body.type ?? row.type`), not blindly persisted.
    // A trashed row is not addressable (404, like an unknown id) — writing onto
    // it would edit content the user cannot see.
    const [existing] = await db
      .select({ type: liveBlocks.type, pageId: liveBlocks.pageId })
      .from(liveBlocks)
      .where(eq(liveBlocks.id, params.id))
      .limit(1);
    if (!existing) throw new HttpError(404, "Not found");

    // A `type` change without a new `data` would strand the old type's payload under
    // the new type — always malformed against the new schema. Reject loudly rather
    // than persist an invalid row. (A `type`-less, `data`-less update — e.g. toggling
    // `expanded` — is valid and skips validation entirely.)
    if (typeof body.type === "string" && body.data === undefined) {
      throw new HttpError(
        400,
        `Changing block type to "${body.type}" requires a matching \`data\` payload.`,
      );
    }

    const { value: updated } = await withPageForest(
      existing.pageId,
      async (ctx) => {
        // Re-read the row under the lock: a concurrent conversion between the scope
        // read above and this write would otherwise have `data` validated against a
        // type the row no longer holds — and a concurrent delete would have
        // trashed it, which is the same 404. `data` rides along because a rewrite
        // is judged against the payload it replaces (`rewriteBlockData`: a data
        // edit never changes a page's author), and that has to be the one under
        // the lock.
        const [row] = await ctx.tx
          .select({ type: liveBlocks.type, data: liveBlocks.data })
          .from(liveBlocks)
          .where(eq(liveBlocks.id, params.id))
          .limit(1);
        if (!row) throw new HttpError(404, "Not found");

        const patch: BlockColumnChanges = {};
        if (typeof body.type === "string") patch.type = body.type;
        if (body.data !== undefined) {
          patch.data = rewriteBlockData({
            type: body.type ?? row.type,
            before: row,
            next: body.data,
          });
        }
        if (typeof body.expanded === "boolean") patch.expanded = body.expanded;
        await updateBlockFields(ctx.tx, params.id, patch);

        const [after] = await ctx.tx
          .select({
            id: liveBlocks.id,
            pageId: liveBlocks.pageId,
            type: liveBlocks.type,
          })
          .from(liveBlocks)
          .where(eq(liveBlocks.id, params.id))
          .limit(1);
        if (!after) throw new HttpError(404, "Not found");
        return after;
      },
    );

    await notifyBlockChange({
      pageId: updated.pageId,
      type: updated.type,
      blockId: updated.id,
    });
    const [row] = await db
      .select()
      .from(liveBlocks)
      .where(eq(liveBlocks.id, params.id))
      .limit(1);
    if (!row) throw new HttpError(404, "Not found after update");
    return BlockSchema.parse(row);
  },
);
