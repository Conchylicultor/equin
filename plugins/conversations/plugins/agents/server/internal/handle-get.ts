import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { getAgent } from "../../core";
import { AgentSchema } from "../../core";
import { agents } from "./views";
import { agentIdKind } from "../../core";

export const handleGet = implement(getAgent, async ({ params }) => {
  const [row] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentIdKind.key(params.id)))
    .limit(1);
  if (!row) throw new HttpError(404, "Not found");
  return AgentSchema.parse(row);
});
