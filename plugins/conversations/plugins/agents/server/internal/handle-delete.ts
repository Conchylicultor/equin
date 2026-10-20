import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { deleteAgent } from "../../core";
import { _agents } from "./tables";
import { agentIdKind } from "../../core";

export const handleDelete = implement(deleteAgent, async ({ params }) => {
  const children = await db
    .select({ id: _agents.id })
    .from(_agents)
    .where(eq(_agents.parentId, params.id))
    .limit(1);
  if (children.length > 0) {
    throw new HttpError(409, "Agent has children");
  }
  const [row] = await db
    .delete(_agents)
    .where(eq(_agents.id, agentIdKind.key(params.id)))
    .returning();
  if (!row) throw new HttpError(404, "Not found");
  // Launches cascade via FK; the DB change-feed invalidates the agents and
  // agent-launches resources so subscribed detail views refresh.
  // return undefined → implement() sends 204
});
