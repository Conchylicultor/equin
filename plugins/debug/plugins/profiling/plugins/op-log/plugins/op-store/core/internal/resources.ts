import { liveCollection } from "@plugins/network/plugins/live/core";
import { OP_ROW_CARRIED, OP_ROW_LISTED } from "./schemas";

/**
 * Every op still in flight (`closed_by IS NULL`), oldest first — the set the
 * op-status banner and chip render, as the WHOLE ordered set (`all`) plus its
 * `:rows` point sibling. ONE param-less subscription for the whole host: a
 * surface filters by `opSlug` on the client rather than opening a tuple per
 * worktree, so it needs every op — a window would hide the newest past its
 * edge (the banner's "+N others", a worktree's chip). Bounded by what the host
 * runs at once: an op leaves the set when it closes.
 *
 * `preload: "boot"`: the banner is first-paint chrome. The rows may be stale for
 * the moment between boot and the first drain, which the ingester runs before
 * anything else in `onReady`.
 *
 * The key is `op-store.in-flight.all`, not the old window's
 * `op-store.in-flight`: no bundle ever declared this key with another
 * contract, so a tab on an older one gets `unknown-key` (a `skew` verdict) and
 * never parses these rows.
 */
export const opsInFlight = liveCollection("op-store.in-flight.all", {
  carry: { fields: { ...OP_ROW_CARRIED, ...OP_ROW_LISTED } },
  id: "opId",
  all: {
    orderBy: [["requestedAt", "asc"]],
    unbounded: { reason: "every op in flight on the host" },
  },
  preload: "boot",
});

/**
 * Every stored op, in flight or closed (30 days, the retention window), newest
 * first — the Ops Gantt / detail / stats read model. A time window is
 * `where: { requestedAt: { gte: cutoff } }` (quantize the cutoff so the tuple
 * is stable); one op is `useLiveRow(opsHistory, opId)`.
 */
export const opsHistory = liveCollection("op-store.history", {
  fields: OP_ROW_LISTED,
  carry: { fields: OP_ROW_CARRIED },
  id: "opId",
  sortable: ["requestedAt", "completedAt"],
  default: { orderBy: [["requestedAt", "desc"]], limit: 500 },
  maxLimit: 2000,
});
