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
 * The CLI's kind of failure for a usage limit — the one stop a resume moves
 * to another account (the sdk runtime's send).
 */
export const USAGE_LIMIT_ERROR = "rate_limit";

/** A failure the CLI names no kind for, in words. */
export const API_ERROR = "API error";

/**
 * What stopped a turn, in words: the CLI's kind of failure (`rate_limit`,
 * `server_error`, `authentication_failed`, …) as a noun phrase.
 */
export function stopErrorLabel(error: string | null | undefined): string {
  if (error === USAGE_LIMIT_ERROR) return "usage limit";
  if (!error || error === "unknown") return API_ERROR;
  return error.replace(/[_-]+/g, " ");
}

/**
 * The conversations whose agent's turn a failed model request stopped — a
 * usage limit, a server error, a lost connection: the CLI's own notice of it
 * (its synthetic assistant line with an `error`), once its retries gave up —
 * and has not run a turn since: active conversations (starting, working,
 * waiting) whose `conversations_ext_sdk_agent` row holds a `stoppedAt`.
 * Latest stop first. `stopError` is the CLI's kind of failure; `account` is
 * the one the agent ran on (null for an agent started before agents named
 * theirs).
 */
export const errorStoppedConversations = liveCollection(
  "runtime-sdk.error-stopped",
  {
    from: conversationsEntityRef,
    pick: ["title", "status"],
    fields: {
      // Never NULL: the base `where` keeps only rows that hold one (a LEFT
      // join's field accepts null all the same).
      stoppedAt: nullable(dateField({ label: "Stopped at" })),
      stopError: nullable(textField({ label: "Error" })),
    },
    carry: {
      pick: ["id"],
      fields: { account: nullable(textField()) },
    },
    baseExposures: false,
    id: "id",
    sortable: ["stoppedAt"],
    default: { orderBy: [["stoppedAt", "desc"]], limit: 50 },
    maxLimit: 200,
  },
);

/** One stopped conversation as {@link errorStoppedConversations} delivers it. */
export type ErrorStoppedConversation =
  typeof errorStoppedConversations extends LiveRowsCollection<infer R>
    ? R
    : never;

/** The turn a resume sends: the CLI's own words for carrying on. */
export const RESUME_TURN_TEXT = "Continue from where you left off.";

export const ResumeStoppedResultSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("resumed") }),
  z.object({ id: z.string(), kind: z.literal("not-found") }),
  z.object({ id: z.string(), kind: z.literal("failed"), message: z.string() }),
]);
export type ResumeStoppedResult = z.infer<typeof ResumeStoppedResultSchema>;

/**
 * Resume conversations an API error stopped: send each the resume turn. An
 * agent a usage limit stopped restarts first on the account a launch picks
 * now (the sdk runtime's send), so the turn runs where there is room. One
 * result per id.
 */
export const resumeStoppedConversations = defineEndpoint({
  route: "POST /api/runtime-sdk/resume-stopped",
  body: z.object({ ids: z.array(z.string().min(1)).min(1) }),
  response: z.object({ results: z.array(ResumeStoppedResultSchema) }),
  needsMachine: { feature: "Resuming agents" },
});
