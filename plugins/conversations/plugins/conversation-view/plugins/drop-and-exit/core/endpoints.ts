import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const dropAndExit = defineEndpoint({
  route: "POST /api/conversations/:id/drop-and-exit",
  response: z.object({ ok: z.boolean(), dropped: z.boolean() }),
  needsMachine: { feature: "Closing an agent's conversation" },
});
