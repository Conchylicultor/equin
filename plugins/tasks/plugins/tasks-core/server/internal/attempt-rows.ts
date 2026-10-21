import { sql } from "drizzle-orm";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import {
  BASE_RELATION,
  childrenJoin,
  expr,
  jsonAgg,
  type RollupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import type { ServeAllCollectionOptions } from "@plugins/network/plugins/live/server";
import { AttemptStatusSchema, type AttemptWithConversations } from "../../core";
import { attemptDerived, type AttemptFacts } from "./derived";
import { attemptConvAgg, attemptPushAgg } from "./rollup-spec";
import { _attemptPushAgg } from "./rollup-table";
import { _attempts, _conversations } from "./tables";

// How `attemptRows` (core: the whole ordered set of attempts, key `attempts`)
// binds to the database — the ONE spelling both the served collection
// (`./resources.ts`) and the tests (`./tree-oracle.test.ts`, which compiles it
// against a throwaway database; `./all-parity.test.ts`, which holds it equal
// to `attempts_v`) read, so neither can drift from what ships.
//
// It reads the BASE table and the attempt rollups, never a view (A8): every
// row field but the five derived ones is a column of `attempts` by name; the
// derived `status` / `active` / `retained` / `finishedAt` are
// `attemptDerived` (./derived.ts) — the definition `attempts_v` interpolates
// — over the two rollups joined row-wise; `conversations` is a children
// `jsonAgg` of the attempt's non-system conversations. A conversation write
// reaches its attempt through the children route (gated on what the list
// reads: `attempt_id`, `id`, `kind`, `title`, `status`, `created_at`,
// `spawned_by`) and the conversation rollup's source route (`status`,
// `ended_at`); a push through the push rollup's (`created_at`). Neither
// `waiting_for`, `last_viewed_at` nor `updated_at` is read, so a poller
// write reaches nothing — the gate the old hand-rolled cascade signature
// approximated (C1).

const conv = {
  kind: "rollup",
  alias: "conv",
  rollup: attemptConvAgg,
  on: { from: BASE_RELATION, col: _attempts.id },
} as const satisfies RollupJoin;
const push = {
  kind: "rollup",
  alias: "push",
  rollup: attemptPushAgg,
  on: { from: BASE_RELATION, col: _attempts.id },
} as const satisfies RollupJoin;

// The attempt's conversations a surface lists: every kind but `system`
// (machine-spawned automation never surfaces in the attempt view), oldest
// first — the `ConversationSummary` fields, timestamps as the ISO text a
// `Date` crosses the wire as.
const convs = childrenJoin({
  alias: "convs",
  table: _conversations,
  fk: _conversations.attemptId,
  where: (c) => sql`${c.convs.kind} <> 'system'`,
  aggregates: (c) => ({
    list: jsonAgg(
      {
        id: c.convs.id,
        title: c.convs.title,
        status: c.convs.status,
        kind: c.convs.kind,
        createdAt: c.convs.createdAt,
        spawnedBy: c.convs.spawnedBy,
      },
      { orderBy: [[c.convs.createdAt, "asc"]] },
    ),
  }),
});

const joins = [conv, push, convs] as const;

/** An attempt's two rollup rows, as the compile reads them off `j`. */
const factsOf = (j: {
  conv: Pick<
    AttemptFacts,
    "hasConv" | "hasLiveConv" | "hasOpenConv" | "maxEndedAt" | "hasWorkingConv"
  >;
  push: Pick<AttemptFacts, "hasPush" | "hasDelivery" | "minPushAt">;
}): AttemptFacts => ({
  hasConv: j.conv.hasConv,
  hasLiveConv: j.conv.hasLiveConv,
  hasOpenConv: j.conv.hasOpenConv,
  maxEndedAt: j.conv.maxEndedAt,
  hasPush: j.push.hasPush,
  hasDelivery: j.push.hasDelivery,
  hasWorkingConv: j.conv.hasWorkingConv,
  minPushAt: j.push.minPushAt,
});

export const attemptRowsServeOptions = {
  from: _attempts,
  joins,
  columns: {
    status: (j) =>
      expr(attemptDerived(factsOf(j)).status, {
        decoder: parsed(AttemptStatusSchema, "attempts.status"),
        sqlType: "text",
        notNull: true,
      }),
    active: (j) =>
      expr(attemptDerived(factsOf(j)).active, {
        decoder: Boolean,
        sqlType: "boolean",
        notNull: true,
      }),
    retained: (j) =>
      expr(attemptDerived(factsOf(j)).retained, {
        decoder: Boolean,
        sqlType: "boolean",
        notNull: true,
      }),
    finishedAt: (j) =>
      expr(attemptDerived(factsOf(j)).finishedAt, {
        decoder: _attemptPushAgg.minPushAt,
        sqlType: "timestamp with time zone",
      }),
    conversations: (j) => j.convs.list,
  },
} satisfies ServeAllCollectionOptions<
  typeof _attempts,
  AttemptWithConversations,
  typeof joins
>;
