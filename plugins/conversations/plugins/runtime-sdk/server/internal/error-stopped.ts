import { sql } from "drizzle-orm";
import type { LookupJoin } from "@plugins/infra/plugins/query-resource/core";
import {
  serveCollection,
  type ServeCollectionOptions,
} from "@plugins/network/plugins/live/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import {
  errorStoppedConversations,
  type ErrorStoppedConversation,
} from "../../core";
import { _sdkAgentsTable } from "./tables";

// Served from the conversations table with the agent's side row joined: the
// reducer sets `stopped_at` (and `stop_error`) on the CLI's notice of a failed
// model request and clears it on the next turn or process, so a resume (or the
// conversation closing) moves the row out of the window.
// REQUIRED (INNER): a conversation without an agent row never stopped on an
// API error. Its `on` is the host identity, so a side-row write is routed to its
// own conversation's row alone.
const agentJoin = {
  kind: "lookup",
  alias: "agent",
  table: _sdkAgentsTable,
  pk: _sdkAgentsTable.conversationId,
  on: { from: "base", col: _conversations.id },
  required: true,
} satisfies LookupJoin<"agent", typeof _sdkAgentsTable>;

const errorStoppedServeOptions: ServeCollectionOptions<
  typeof _conversations,
  ErrorStoppedConversation,
  readonly [typeof agentJoin],
  never // no default scopes
> = {
  from: _conversations,
  joins: [agentJoin],
  columns: {
    stoppedAt: (j) => j.agent.stoppedAt,
    stopError: (j) => j.agent.stopError,
    account: (j) => j.agent.account,
  },
  where: (j) =>
    sql`${j.base.status} IN ('starting', 'working', 'waiting') AND ${j.agent.stoppedAt} IS NOT NULL`,
};

export const errorStoppedServed = serveCollection(
  errorStoppedConversations,
  errorStoppedServeOptions,
);
