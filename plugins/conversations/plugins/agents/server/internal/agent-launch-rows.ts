import { sql } from "drizzle-orm";
import {
  nullable,
  parsed,
} from "@plugins/database/plugins/sql-projection/server";
import {
  BASE_RELATION,
  expr,
  type RollupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import type { ServeAllCollectionOptions } from "@plugins/network/plugins/live/server";
import {
  AgentLaunchConversationRefSchema,
  type AgentLaunchWithStatus,
} from "../../core";
import { taskLatestConversation } from "./rollup-spec";
import { _agent_launches } from "./tables";

// How `agentLaunchRows` (shared: the whole ordered set of agent launches, key
// `agent-launches`) binds to the database — the ONE spelling both the served
// collection (`./resources.ts`) and the tree oracle
// (`./agent-launches-oracle.test.ts`, which compiles it against a throwaway
// database) read, so neither can drift from what ships.
//
// It reads `agent_launches` and the `task_latest_conversation` rollup, LEFT
// joined on the launch's task (`task_id` is not the launch's key, so every
// route into it is a reverse onto `agent_launches.task_id`): the rollup's
// `conversations` source (gated on what the rollup reads — `kind`, `title`,
// `status`, `created_at`, `attempt_id`) through the `attempts` hop, and its
// `attempts` source carrying `task_id` (an attempt deleted or moved between
// tasks reaches the launches of both). Neither `waiting_for`,
// `last_viewed_at` nor `updated_at` is read, so a poller write reaches nothing
// — the gate the old hand-rolled cascade signature approximated.
//
// `latestConversationStatus` is the rollup's decoded `status` (`null` with no
// rollup row: the LEFT join), and `latestConversation` the rollup row as one
// JSON object, `null` with none (C27).

const latest = {
  kind: "rollup",
  alias: "latest",
  rollup: taskLatestConversation,
  on: { from: BASE_RELATION, col: _agent_launches.taskId },
} as const satisfies RollupJoin;

const joins = [latest] as const;

export const agentLaunchRowsServeOptions = {
  from: _agent_launches,
  joins,
  columns: {
    latestConversationStatus: (j) => j.latest.status,
    latestConversation: (j) =>
      expr(
        sql`CASE WHEN ${j.latest.taskId} IS NULL THEN NULL ELSE json_build_object('id', ${j.latest.conversationId}, 'title', ${j.latest.title}, 'status', ${j.latest.status}) END`,
        {
          decoder: nullable(
            parsed(
              AgentLaunchConversationRefSchema,
              "agent-launches.latestConversation",
            ),
          ),
          sqlType: "json",
        },
      ),
  },
} satisfies ServeAllCollectionOptions<
  typeof _agent_launches,
  AgentLaunchWithStatus,
  typeof joins
>;
