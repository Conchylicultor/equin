import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const RestoreBatchBodySchema = z.object({
  ids: z.array(z.string()),
});
export type RestoreBatchBody = z.infer<typeof RestoreBatchBodySchema>;

const RestoreResultSchema = z.union([
  z.object({ id: z.string(), ok: z.literal(true) }),
  z.object({ id: z.string(), ok: z.literal(false), error: z.string() }),
]);

export const restoreBatch = defineEndpoint({
  route: "POST /api/conversations-recover/restore-batch",
  body: RestoreBatchBodySchema,
  response: z.object({ results: z.array(RestoreResultSchema) }),
  needsMachine: { feature: "Restoring conversations" },
});
