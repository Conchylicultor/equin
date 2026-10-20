import { asc } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { listAgents } from "../../core";
import { AgentSchema } from "../../core";
import { agents } from "./views";

export const handleList = implement(listAgents, async () => {
  const rows = await db.select().from(agents).orderBy(asc(agents.rank), asc(agents.createdAt));
  return rows.map((r) => AgentSchema.parse(r));
});
