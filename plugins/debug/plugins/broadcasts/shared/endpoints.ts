import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { OP_KIND_IDS } from "@plugins/infra/plugins/worktree/core";

export const BroadcastEntrySchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  since: z.string().optional(),
  until: z.string().optional(),
  // Which op commands the broadcast prints on — the op-kind vocabulary itself.
  commands: wholeList(z.enum(OP_KIND_IDS), {
    reason: "a subset of the op kinds — a closed vocabulary of a handful",
  }).optional(),
});
export type BroadcastEntry = z.infer<typeof BroadcastEntrySchema>;

export const WriteBroadcastsBodySchema = z.object({
  entries: z.array(z.unknown()),
});
export type WriteBroadcastsBody = z.infer<typeof WriteBroadcastsBodySchema>;

const WriteBroadcastsResponseSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type WriteBroadcastsResponse = z.infer<
  typeof WriteBroadcastsResponseSchema
>;

export const writeBroadcasts = defineEndpoint({
  route: "PUT /api/debug/broadcasts",
  body: WriteBroadcastsBodySchema,
  response: WriteBroadcastsResponseSchema,
});
