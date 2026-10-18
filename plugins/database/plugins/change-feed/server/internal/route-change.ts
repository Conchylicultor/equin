import {
  routeTableChange,
  type TableChange,
} from "@plugins/framework/plugins/server-core/core";
import type { ResourceRuntime } from "@plugins/framework/plugins/resource-runtime/core";
import type { DbChange } from "./parse-payload";

/** The router a change is delivered to (see `routeChange`). */
type ResourceRuntimeRouter = Pick<ResourceRuntime, "routeTableChange">;

/** A change from the Postgres feed: a NOTIFY, a catch-up row, a reconnect sweep. */
export type FeedChange = TableChange & { source: "feed" };

/**
 * A change from an in-process change producer (`defineChangeProducer`): the
 * ids its own statement returned, and nothing else. It has no key layout (a
 * produced table carries none — A3p), no `unchanged` set (it compares nothing),
 * and no source transaction (nobody is owed an ack), so it cannot state them.
 */
export interface ProducerChange {
  source: "producer";
  table: string;
  op: "U" | "D";
  /** The returned PKs, or `null` over the producer's id cap (FULL per tuple). */
  ids: readonly string[] | null;
  /** The earliest buffered emit's wall clock (see `PendingNotify.changedAt`). */
  changedAt: number;
}

/** What `routeChange` routes: every change source states which one it is. */
export type RoutedChange = FeedChange | ProducerChange;

/**
 * A parsed NOTIFY payload or changelog row as the feed change it is. A null
 * `xid` / `changedAt` (a pre-upgrade NOTIFY, a replay row) is omitted.
 */
export function feedChange(change: DbChange): FeedChange {
  return {
    source: "feed",
    table: change.table,
    op: change.op,
    ids: change.ids,
    keys: change.keys,
    unchanged: change.unchanged,
    ...(change.xid !== null ? { xid: change.xid } : {}),
    ...(change.changedAt !== null ? { changedAt: change.changedAt } : {}),
  };
}

// The router's input for either source: a producer change reads as a feed
// change that knows nothing of keys or unchanged columns.
function tableChangeOf(change: RoutedChange): TableChange {
  return change.source === "feed"
    ? change
    : {
        source: "producer",
        table: change.table,
        op: change.op,
        ids: change.ids,
        keys: null,
        unchanged: null,
        changedAt: change.changedAt,
      };
}

// Route one base-table change into the live-state recompute cascade.
//
// This is the SINGLE source of change routing: the LISTEN consumer (live changes),
// the L2 cold-boot catch-up driver (replayed changelog rows) AND the in-process
// change producers (`./producer`) all call it, so "catch-up ≡ replay the missed
// rows as if they just arrived" is true by construction and can never drift from
// the live path, and a produced table reaches its readers exactly as a triggered
// one would. See
// research/2026-06-22-global-live-state-l2-persisted-materialization.md §3.5.
//
// One router reads each change: `routeTableChange`, over every resource's
// declared reads — compiler-emitted routes (per-tuple read-sets, host-id
// maps) and reach plans (a view or rollup a plan reads is reached through its
// relation bases — `./relation-bases` — so a `conversations` write reaches a
// reader of `tasks_v`). A DB-backed resource that declares none is refused at
// boot (D6). See research/2026-09-29-global-scoped-change-routing.md and
// research/2026-10-17-global-live-declared-reads-externals-session2.md.
export const routeChange: (routed: RoutedChange) => void = createChangeRouter({
  routeTableChange,
});

/**
 * The routing above, into ANY runtime's router — `routeChange` is it
 * bound to server-core's process-global runtime. A suite that registers real
 * declarations on a runtime of its own (`createResourceRuntime`: the tree
 * oracle) routes its feed through this, so it never registers a key on the
 * global registry a barrel's module eval already registered it on.
 */
export function createChangeRouter(
  runtime: ResourceRuntimeRouter,
): (routed: RoutedChange) => void {
  const { routeTableChange } = runtime;
  // A routed table's trigger carries its key layout and, for a gated UPDATE,
  // the unchanged columns; every other table's leaves both null (unknown).
  return (routed) => routeTableChange(tableChangeOf(routed));
}
