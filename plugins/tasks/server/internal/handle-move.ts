import { eq, isNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { rankAdjacentTo } from "@plugins/primitives/plugins/rank/server";
import {
  _tasks,
  finishRefile,
  isDescendant,
  prepareRefile,
} from "@plugins/tasks/plugins/tasks-core/server";
import { moveTask } from "../../core";

export const handleMove = implement(moveTask, async ({ params, body }) => {
  if (body.folderId === params.id) {
    throw new HttpError(400, "Cannot file a task into itself");
  }
  if (body.targetId === params.id) {
    throw new HttpError(400, "Cannot position a task relative to itself");
  }
  if (
    body.folderId !== null &&
    (await isDescendant(params.id, body.folderId))
  ) {
    throw new HttpError(400, "Cannot file a task into its own descendant");
  }

  // Read the destination sibling set and write the new rank in ONE transaction:
  // the rank is minted against a consistent snapshot, so a concurrent insert
  // into the same folder cannot slip between the read and the write. Mirrors
  // `page/editor`'s `handle-move-block.ts`.
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select({ id: _tasks.id })
      .from(_tasks)
      .where(eq(_tasks.id, params.id))
      .limit(1);
    if (!before) throw new HttpError(404, "Not found");

    // The COMPLETE sibling set of the destination folder — the whole point of
    // resolving the anchor here rather than on the client, which only ever
    // holds a filtered/grouped projection of it.
    const siblings = await tx
      .select({ id: _tasks.id, parentId: _tasks.folderId, rank: _tasks.rank })
      .from(_tasks)
      .where(
        body.folderId === null
          ? isNull(_tasks.folderId)
          : eq(_tasks.folderId, body.folderId),
      );
    if (
      body.targetId !== null &&
      !siblings.some((s) => s.id === body.targetId)
    ) {
      throw new HttpError(
        400,
        `Target ${body.targetId} is not filed under the destination folder`,
      );
    }
    const rank = rankAdjacentTo(
      siblings,
      body.folderId,
      body.targetId,
      body.zone,
      new Set([params.id]),
    );

    // The re-file's other halves, on the same tx as the write: the cluster
    // union (at or before the edge write — the label must never lag behind
    // it), the mandate a task moved to the root keeps, then the subtree's
    // effective mandates and `tasks.refiled`.
    const refile = await prepareRefile(params.id, body.folderId, tx);
    await tx
      .update(_tasks)
      .set({ ...refile, rank: rank.toJSON() })
      .where(eq(_tasks.id, params.id));
    await finishRefile(params.id, body.folderId, tx);
  });

  // No `tasks.statusChanged` emit: a task's status derives from its drop/hold
  // flags, attempts, conversations and dependencies (`tasks_v`) — never from
  // where it is filed — so a re-file cannot flip it. The tasks live resource
  // repaints from the L4 change-feed on the write itself.
});
