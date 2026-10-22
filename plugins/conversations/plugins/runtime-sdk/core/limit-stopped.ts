import { z } from "zod";
import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  liveCollection,
  type LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import { conversationsEntityRef } from "@plugins/tasks/plugins/tasks-core/core";

/**
 * The conversations whose agent stopped at its Claude account's usage limit
 * and has not run a turn since: active conversations (starting, working,
 * waiting) whose `conversations_ext_sdk_agent` row holds a `limitHitAt`.
 * Latest stop first. `account` is the one the agent ran on (null for an agent
 * started before agents named theirs).
 */
export const limitStoppedConversations = liveCollection(
  "runtime-sdk.limit-stopped",
  {
    from: conversationsEntityRef,
    pick: ["title", "status"],
    fields: {
      // Never NULL: the base `where` keeps only rows that hold one (a LEFT
      // join's field accepts null all the same).
      limitHitAt: nullable(dateField({ label: "Stopped at" })),
    },
    carry: {
      pick: ["id"],
      fields: { account: nullable(textField()) },
    },
    baseExposures: false,
    id: "id",
    sortable: ["limitHitAt"],
    default: { orderBy: [["limitHitAt", "desc"]], limit: 50 },
    maxLimit: 200,
  },
);

/** One stopped conversation as {@link limitStoppedConversations} delivers it. */
export type LimitStoppedConversation =
  typeof limitStoppedConversations extends LiveRowsCollection<infer R>
    ? R
    : never;

/** The turn a resume sends: the CLI's own words for carrying on. */
export const RESUME_TURN_TEXT = "Continue from where you left off.";

export const ResumeLimitedResultSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("resumed") }),
  z.object({ id: z.string(), kind: z.literal("not-found") }),
  z.object({ id: z.string(), kind: z.literal("failed"), message: z.string() }),
]);
export type ResumeLimitedResult = z.infer<typeof ResumeLimitedResultSchema>;

/**
 * Resume conversations stopped at a usage limit: send each the resume turn.
 * Its agent restarts first on the account a launch picks now (the sdk
 * runtime's send), so the turn runs where there is room. One result per id.
 */
export const resumeLimitedConversations = defineEndpoint({
  route: "POST /api/runtime-sdk/resume-limited",
  body: z.object({ ids: z.array(z.string().min(1)).min(1) }),
  response: z.object({ results: z.array(ResumeLimitedResultSchema) }),
  needsMachine: { feature: "Resuming agents" },
});
