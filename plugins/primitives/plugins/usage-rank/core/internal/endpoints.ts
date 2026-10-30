import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const RecordUsageBodySchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
});
export type RecordUsageBody = z.infer<typeof RecordUsageBodySchema>;

/**
 * Record one use of `(namespace, key)` — decays the stored score to now, adds
 * 1, bumps the raw count and stamps `lastUsedAt`, in ONE atomic upsert.
 * Idempotency is not desired: each call IS a use.
 *
 * Named `…Endpoint` because the web barrel exports the fire-and-forget CALLER
 * as `recordUsage`; keeping both names distinct means a consumer can never
 * import the contract where it meant the call.
 */
export const recordUsageEndpoint = defineEndpoint({
  route: "POST /api/usage-rank/record",
  body: RecordUsageBodySchema,
});
