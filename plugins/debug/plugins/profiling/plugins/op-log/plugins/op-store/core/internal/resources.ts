import { liveCollection } from "@plugins/network/plugins/live/core";
import { opLogOpsEntityRef } from "./schemas";

// Both collections are the `op_log_ops` entity's rows, declared by FIELDS: a
// listed field's label and type are the entity's (`OP_ROW_LISTED`), and every
// other key rides the row (`OP_ROW_CARRIED`), in no list and never filterable.
// No base exposures: the rows are the op-log reducer's state (`OpRow`), and
// nothing extends the entity.
//
// Both are ingested from the host's op log on disk (the builds, tests and
// pushes this machine runs), so only the desktop app answers them
// (`needsMachine`, served by `machine/`): a reader under an in-browser server
// gets `unavailable`. The boot preload is unchanged on the desktop.
const OPS_ON_THIS_MACHINE = {
  feature: "Builds, tests and pushes on this machine",
} as const;
const OP_ROW_LISTED_PICK = [
  "kind",
  "opSlug",
  "requestedAt",
  "completedAt",
  "outcome",
] as const;
const OP_ROW_CARRIED_PICK = [
  "opId",
  "branch",
  "conversationId",
  "lane",
  "mode",
  "buildId",
  "pid",
  "grantedAt",
  "interrupted",
  "closedBy",
  "waits",
  "openWait",
  "cycle",
  "closedWaitMs",
  "holdMs",
  "totalMs",
  "steps",
  "lastSeq",
  "sleeps",
  "sleepStamp",
] as const;

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
  from: opLogOpsEntityRef,
  baseExposures: false,
  carry: { pick: [...OP_ROW_LISTED_PICK, ...OP_ROW_CARRIED_PICK] },
  id: "opId",
  all: {
    orderBy: [["requestedAt", "asc"]],
    unbounded: { reason: "every op in flight on the host" },
  },
  preload: "boot",
  needsMachine: OPS_ON_THIS_MACHINE,
});

/**
 * Every stored op, in flight or closed (30 days, the retention window), newest
 * first — the Ops Gantt / detail / stats read model. A time window is
 * `where: { requestedAt: { gte: cutoff } }` (quantize the cutoff so the tuple
 * is stable); one op is `useLiveRow(opsHistory, opId)`.
 */
export const opsHistory = liveCollection("op-store.history", {
  from: opLogOpsEntityRef,
  pick: OP_ROW_LISTED_PICK,
  baseExposures: false,
  carry: { pick: OP_ROW_CARRIED_PICK },
  id: "opId",
  sortable: ["requestedAt", "completedAt"],
  default: { orderBy: [["requestedAt", "desc"]], limit: 500 },
  maxLimit: 2000,
  needsMachine: OPS_ON_THIS_MACHINE,
});
