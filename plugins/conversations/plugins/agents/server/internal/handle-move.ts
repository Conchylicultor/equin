import { eq, isNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { rankAdjacentTo } from "@plugins/primitives/plugins/rank/server";
import { moveAgent } from "../../core";
import { _agents } from "./tables";
import { isAgentDescendant } from "./hierarchy";
import { agentIdKind } from "../../core";

export const handleMove = implement(moveAgent, async ({ params, body }) => {
  if (body.parentId === params.id) {
    throw new HttpError(400, "Cannot parent an agent to itself");
  }
  if (body.targetId === params.id) {
    throw new HttpError(400, "Cannot position an agent relative to itself");
  }
  if (
    body.parentId !== null &&
    (await isAgentDescendant(params.id, body.parentId))
  ) {
    throw new HttpError(400, "Cannot parent an agent under its own descendant");
  }

  // Read the destination sibling set and write the new rank in ONE transaction:
  // the rank is minted against a consistent snapshot, so a concurrent insert
  // under the same parent cannot slip between the read and the write. Mirrors
  // `page/editor`'s `handle-move-block.ts`.
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ id: _agents.id })
      .from(_agents)
      .where(eq(_agents.id, agentIdKind.key(params.id)))
      .limit(1);
    if (!before) throw new HttpError(404, "Not found");

    // The COMPLETE sibling set of the destination parent — the whole point of
    // resolving the anchor here rather than on the client, which only ever
    // holds a filtered/grouped projection of it.
    const siblings = await tx
      .select({
        id: _agents.id,
        parentId: _agents.parentId,
        rank: _agents.rank,
      })
      .from(_agents)
      .where(
        body.parentId === null
          ? isNull(_agents.parentId)
          : eq(_agents.parentId, body.parentId),
      );
    if (
      body.targetId !== null &&
      !siblings.some((s) => s.id === body.targetId)
    ) {
      throw new HttpError(
        400,
        `Target ${body.targetId} is not a child of the destination parent`,
      );
    }
    const rank = rankAdjacentTo(
      siblings,
      body.parentId,
      body.targetId,
      body.zone,
      new Set([params.id]),
    );

    await tx
      .update(_agents)
      .set({
        parentId: body.parentId,
        rank: rank.toJSON(),
      })
      .where(eq(_agents.id, agentIdKind.key(params.id)));
  });

  // No destination force-expand on a re-parent: expand/collapse is device-local
  // view state owned by the data-view primitive, not a column. `TreeList.
  // onDragEnd` opens a collapsed drop target client-side, and the destination
  // folder's `updatedAt` is not a fact about the folder.
});
