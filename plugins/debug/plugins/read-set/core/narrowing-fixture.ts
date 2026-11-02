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
 * - `stamp-agent-author` records an agent-notes author on a block under a
 *   conversation id the fixture mints (`narrowing-fixture-…`): the column
 *   has no foreign key, and there is no HTTP writer of the table.
 * - `clear-agent-authors` deletes a block's fixture-minted stamps.
 * - `clear-row-order` deletes a fixture data view's manual row order
 *   (`dataViewId` prefixed {@link NARROWING_FIXTURE_DATA_VIEW}): the row-order
 *   endpoint never deletes.
 *
 * - The by-id suite (`--suite byid`) writes rows of eight tables it creates
 *   itself: `create-fixture-row` (a deploy server, a stored version, an
 *   attachment, a task, or an attempt on a fixture task) answers the minted id
 *   as `rowId`; `write-fixture-row` makes one real write about a fixture row
 *   (a server's key, a version's snapshot, an attachment's filename, a claude
 *   call recorded under a correlation id, a task's subject link, a task's
 *   source url); `delete-fixture-rows` removes what the run created. Every one
 *   names a fixture-marked row (`narrowing-fixture` name / source / id prefix /
 *   author) and refuses (409) any other.
 *
 * Every conversation action but `create-conversation` refuses (409) a
 * conversation the fixture did not create; `clear-row-order` refuses a data
 * view outside the fixture's prefix. Refused on main (403). Spawns nothing.
 */
export const NARROWING_FIXTURE_SPAWNED_BY = "narrowing-fixture";

/** The task-subject kind the by-id suite links its fixture tasks under. */
export const NARROWING_FIXTURE_SUBJECT_KIND = "narrowing-fixture";

/** The prefix of every data-view id the measurement writes rows under. */
export const NARROWING_FIXTURE_DATA_VIEW = "narrowing-fixture:";

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
  z.object({ action: z.literal("stamp-agent-author"), blockId: z.string() }),
  z.object({ action: z.literal("clear-agent-authors"), blockId: z.string() }),
  z.object({ action: z.literal("clear-row-order"), dataViewId: z.string() }),
  z.object({
    action: z.literal("create-fixture-row"),
    row: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("deploy-server") }),
      z.object({ kind: z.literal("version"), entityId: z.string() }),
      z.object({ kind: z.literal("attachment") }),
      z.object({ kind: z.literal("task") }),
      z.object({ kind: z.literal("attempt"), taskId: z.string() }),
    ]),
  }),
  z.object({
    action: z.literal("write-fixture-row"),
    target: z.enum([
      "server-ssh-key",
      "version-snapshot",
      "attachment-filename",
      "claude-cli-call",
      "task-subject",
      "task-source-url",
    ]),
    // The fixture row written: a server / version / attachment / task id, or
    // the correlation id of a claude call.
    id: z.string(),
    // What it is set to (ignored by `claude-cli-call`, which inserts a call).
    value: z.string(),
  }),
  z.object({
    action: z.literal("delete-fixture-rows"),
    kind: z.enum([
      "deploy-server",
      "version",
      "attachment",
      "task",
      "claude-cli-calls",
    ]),
    id: z.string(),
  }),
]);
export type NarrowingFixtureBody = z.infer<typeof NarrowingFixtureBodySchema>;

export const narrowingFixture = defineEndpoint({
  route: "POST /api/debug/read-set/narrowing-fixture",
  body: NarrowingFixtureBodySchema,
  // The conversation written (or minted, for an author stamp); `null` for a
  // clean-up that names none.
  response: z.object({
    conversationId: z.string().nullable(),
    // The id of the row `create-fixture-row` minted; `null` for every other action.
    rowId: z.string().nullable(),
  }),
  internal: {
    why: "measurement fixture: driven by network/live's e2e/narrowing.ts, no browser client",
  },
});
