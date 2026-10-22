import { sql } from "drizzle-orm";
import type { LookupJoin } from "@plugins/infra/plugins/query-resource/core";
import {
  serveCollection,
  type ServeCollectionOptions,
} from "@plugins/network/plugins/live/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import {
  limitStoppedConversations,
  type LimitStoppedConversation,
} from "../../core";
import { _sdkAgentsTable } from "./tables";

// Served from the conversations table with the agent's side row joined: the
// reducer sets `limit_hit_at` on the CLI's usage-limit notice and clears it
// on the next turn or process, so a resume (or the conversation closing)
// moves the row out of the window.
// REQUIRED (INNER): a conversation without an agent row never stopped at a
// limit. Its `on` is the host identity, so a side-row write is routed to its
// own conversation's row alone.
const agentJoin = {
  kind: "lookup",
  alias: "agent",
  table: _sdkAgentsTable,
  pk: _sdkAgentsTable.conversationId,
  on: { from: "base", col: _conversations.id },
  required: true,
} satisfies LookupJoin<"agent", typeof _sdkAgentsTable>;

const limitStoppedServeOptions: ServeCollectionOptions<
  typeof _conversations,
  LimitStoppedConversation,
  readonly [typeof agentJoin],
  never // no default scopes
> = {
  from: _conversations,
  joins: [agentJoin],
  columns: {
    limitHitAt: (j) => j.agent.limitHitAt,
    account: (j) => j.agent.account,
  },
  where: (j) =>
    sql`${j.base.status} IN ('starting', 'working', 'waiting') AND ${j.agent.limitHitAt} IS NOT NULL`,
};

export const limitStoppedServed = serveCollection(
  limitStoppedConversations,
  limitStoppedServeOptions,
);
