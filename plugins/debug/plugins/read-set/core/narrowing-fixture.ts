import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * The narrowing measurement's writes on a worktree database
 * (`network/live/e2e/narrowing.ts`, Resources [12]): the conversation writes
 * whose cost per live tuple it measures, made on a FIXTURE conversation so no
 * real conversation's attempt or session chain is ever touched.
 *
 * - `create-conversation` inserts a fixture conversation into an attempt
 *   through tasks-core's one insert funnel (so the push ledger's attribution
 *   generation moves, as for a real launch). Closed (`done`) from the start:
 *   no runtime holds it and the status reconciler never reads it.
 * - `record-session` adopts a synthetic Claude session id, as the status
 *   reconciler does (the tail on the row, then the chain).
 * - `move-conversation` re-points it at another attempt.
 * - `delete-conversation` deletes its row (its chain rows stay: the chain is
 *   append-only and outlives the row by design).
 *
 * Every action but `create-conversation` refuses (409) a conversation the
 * fixture did not create. Refused on main (403). Spawns nothing.
 */
export const NARROWING_FIXTURE_SPAWNED_BY = "narrowing-fixture";

export const NarrowingFixtureBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create-conversation"), attemptId: z.string() }),
  z.object({ action: z.literal("record-session"), conversationId: z.string() }),
  z.object({
    action: z.literal("move-conversation"),
    conversationId: z.string(),
    attemptId: z.string(),
  }),
  z.object({
    action: z.literal("delete-conversation"),
    conversationId: z.string(),
  }),
]);
export type NarrowingFixtureBody = z.infer<typeof NarrowingFixtureBodySchema>;

export const narrowingFixture = defineEndpoint({
  route: "POST /api/debug/read-set/narrowing-fixture",
  body: NarrowingFixtureBodySchema,
  response: z.object({ conversationId: z.string() }),
  internal: {
    why: "measurement fixture: driven by network/live's e2e/narrowing.ts, no browser client",
  },
});
