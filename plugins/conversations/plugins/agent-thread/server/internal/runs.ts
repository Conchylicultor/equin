import { sql } from "drizzle-orm";
import {
  expr,
  type LookupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import {
  serveCollection,
  type ServeCollectionOptions,
} from "@plugins/network/plugins/live/server";
import {
  _attempts,
  _conversations,
} from "@plugins/tasks/plugins/tasks-core/server";
import { threadRuns, type ThreadRun } from "../../core";

// The conversation's attempt, REQUIRED (INNER: `conversations.attempt_id` is a
// NOT NULL cascade FK). Its route is a reverse route on the attempt's pk,
// gated on the columns read here (`workspace`, `task_id`) — written at insert,
// so an attempt's later writes (its status rollups live elsewhere) reach no
// tuple. Only the attempt: a run's row carries no task column but its id.
const attemptJoin = {
  kind: "lookup",
  alias: "attempt",
  table: _attempts,
  pk: _attempts.id,
  on: { from: "base", col: _conversations.attemptId },
  required: true,
} satisfies LookupJoin<"attempt", typeof _attempts>;

/**
 * `agent-thread.runs`: every conversation whose attempt runs under a scratch
 * profile, its `profile` the spec's — so `where: { profile }` is the runs of
 * one host. No index backs the profile filter (a JSON extraction on the
 * joined attempt): the window walks conversations newest first until it
 * holds its limit, which the few runs a host reads make cheap.
 */
export const threadRunsServeOptions: ServeCollectionOptions<
  typeof _conversations,
  ThreadRun,
  readonly [typeof attemptJoin],
  never // no default scopes
> = {
  from: _conversations,
  joins: [attemptJoin],
  columns: {
    taskId: (j) => j.attempt.taskId,
    profile: (j) =>
      expr(sql`(${j.attempt.workspace} ->> 'profile')`, {
        decoder: String,
        sqlType: "text",
        notNull: true,
      }),
  },
  where: (j) =>
    sql`(${j.attempt.workspace} ->> 'kind') = 'scratch' AND (${j.attempt.workspace} ->> 'profile') IS NOT NULL`,
};

export const threadRunsServed = serveCollection(
  threadRuns,
  threadRunsServeOptions,
);
