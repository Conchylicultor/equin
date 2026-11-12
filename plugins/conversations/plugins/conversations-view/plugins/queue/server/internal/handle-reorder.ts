import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { reorderQueue } from "../../core";
import { reorderGroup } from "./queue-ops";

// A move next to another group; a `section` in the body is a cross-section
// drop — see `reorderGroup`.
export const handleReorder = implement(reorderQueue, async ({ body }) => {
  if (body.conversationId === body.targetId && body.section === undefined) {
    return;
  }
  await db.transaction((tx) => reorderGroup(tx, body));
});
