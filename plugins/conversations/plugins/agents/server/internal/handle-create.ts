import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { assertChoiceLaunchable } from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { createAgent } from "../../core";
import { AgentSchema } from "../../core";
import { agentIdKind } from "../../core";
import { _agents } from "./tables";
import { agents } from "./views";
import { agentRankAfterSibling, nextAgentRankUnder } from "./rank";

export const handleCreate = implement(createAgent, async ({ body }) => {
  // A model this machine cannot run (unknown, or retired) is a 400 listing
  // what can — never stored on an agent whose every launch would be refused.
  if (body.model) assertChoiceLaunchable(body.model, getModelCatalog());
  const id = agentIdKind.mint();
  const parentId = body.parentId ?? null;
  // Positional intent when the client anchored the insert; plain append otherwise.
  const rank = body.afterId
    ? await agentRankAfterSibling(parentId, body.afterId)
    : await nextAgentRankUnder(parentId);
  await db.insert(_agents).values({
    id,
    parentId,
    name: body.name ?? "Untitled",
    prompt: body.prompt ?? null,
    model: body.model ?? null,
    icon: body.icon ?? null,
    iconColor: body.iconColor ?? null,
    rank: rank.toJSON(),
  });
  // No parent force-expand here: expand/collapse is device-local view state owned
  // by the data-view primitive, not a column. The tree reveals the new child
  // client-side (`useTreeRow.addChild` expands the row it created under), so the
  // parent's `updatedAt` no longer moves just because a child was added.
  const [row] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);
  if (!row) throw new HttpError(500, "Failed to retrieve created agent");
  return AgentSchema.parse(row);
});
