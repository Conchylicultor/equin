import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2, watchConfig } from "@plugins/config_v2/server";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import { slowOpConfig } from "../core";
import { submitClientSlowOp } from "../shared/endpoints";
import { _slowOpCallers, _slowOps } from "./internal/tables";
import { slowOpKind } from "./internal/slow-op-kind";
import { handleClientSlowOp } from "./internal/handle-client-slow-op";
import {
  slowOpByIdServed,
  slowOpCallersServed,
  slowOpsListServed,
} from "./internal/resources";
import { slowOpCallersProducer, slowOpsProducer } from "./internal/producer";
import { installSlowSpanHook } from "./internal/install-slow-span";
import { slowOpCallersRetention, slowOpsRetention } from "./internal/retention";

export { _slowOps } from "./internal/tables";
export { recordSlowOp, recordSlowOpBatch } from "./internal/record-slow-op";
export type { RecordSlowOpInput } from "./internal/input";
export { readSlowOpMarkers } from "./internal/read-markers";

export default {
  description:
    "Durable slow-op store: deduped per-operation aggregates and their callers (one row per op × caller), both written through change producers, plus the slow-op report kind and the live collections the pane reads (slow-ops.ops list, slow-ops.op detail, slow-ops.callers). Subscribes to runtime-profiler slow spans and client signals; files one deduped report per distinct slow operation (investigation task filed on demand).",
  contributions: [
    ...slowOpsListServed.declare,
    ...slowOpByIdServed.declare,
    ...slowOpCallersServed.declare,
    ConfigV2.Register({ descriptor: slowOpConfig }),
    slowOpKind,
    // Both tables are written exactly while the app is slow, so neither carries
    // a change-feed trigger (that was the self-amplifying churn loop): each
    // batch is one upsert per table through its producer, coalesced to one
    // flush per 2 s. See ./internal/producer.
    slowOpsProducer.declare,
    slowOpCallersProducer.declare,
    // A slow-op row aggregates operations observed on the machine that recorded
    // them. `worktree` is a label for the cross-worktree Cluster view, not a
    // scope: the single-worktree pane selects without filtering on it, so
    // inherited rows surface in a fresh fork's own Slow Ops pane as if they were
    // its own until the 30-day sweep ages them out.
    ExcludeFromFork({
      table: _slowOps,
      reason:
        "Host-local operation aggregates; the single-worktree pane does not filter on `worktree`, so inherited rows read as the fork's own.",
    }),
    ExcludeFromFork({
      table: _slowOpCallers,
      reason:
        "The callers of the host-local slow_ops aggregates, excluded with them.",
    }),
  ],
  httpRoutes: {
    [submitClientSlowOp.route]: handleClientSlowOp,
  },
  register: [slowOpsRetention, slowOpCallersRetention],
  // watchConfig fires the callback IMMEDIATELY on registration AND on every
  // change, so the first call performs the initial install and subsequent calls
  // reinstall the hook with the new thresholds. installSlowSpanHook disposes the
  // prior subscription each time, so there is no double-install.
  onReady: () => {
    watchConfig(slowOpConfig, (vals) => {
      installSlowSpanHook(vals);
    });
  },
} satisfies ServerPluginDefinition;
