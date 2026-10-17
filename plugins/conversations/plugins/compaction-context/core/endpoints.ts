import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const CompactionContextResponseSchema = z.object({
  /**
   * What the agent's context gets back, every contribution's part joined —
   * `""` when no contribution had anything to restore.
   */
  context: z.string(),
});
export type CompactionContextResponse = z.infer<
  typeof CompactionContextResponseSchema
>;

/**
 * The conversation's context was just compacted: every CompactionContext
 * contribution restores its part, and the joined text is returned for the hook
 * to inject. A POST, not a GET — contributions record what they hand back.
 */
export const compactionContext = defineEndpoint({
  route: "POST /api/conversations/:id/compaction-context",
  response: CompactionContextResponseSchema,
});
