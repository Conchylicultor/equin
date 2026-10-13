import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2, watchConfig } from "@plugins/config_v2/server";
import { ExcludeFromChangeFeed } from "@plugins/database/plugins/change-feed/server";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import { slowOpConfig } from "../core";
import { submitClientSlowOp } from "../shared/endpoints";
import { _slowOps } from "./internal/tables";
import { slowOpKind } from "./internal/slow-op-kind";
import { handleClientSlowOp } from "./internal/handle-client-slow-op";
import { slowOpsServed } from "./internal/slow-ops-served";
import { installSlowSpanHook } from "./internal/install-slow-span";
import { slowOpsRetention } from "./internal/retention";

export { _slowOps } from "./internal/tables";
export { recordSlowOp, recordSlowOpBatch } from "./internal/record-slow-op";
export type { RecordSlowOpInput } from "./internal/record-slow-op";
export { readSlowOpMarkers } from "./internal/read-markers";

export default {
  description:
    "Durable slow-op store: deduped per-operation aggregates with caller attribution, plus the slow-op report kind and the slow-ops.list snapshot value the pane reads. Subscribes to runtime-profiler slow spans and client signals; files one deduped report per distinct slow operation (investigation task filed on demand).",
  contributions: [
    ...slowOpsServed.declare,
    ConfigV2.Register({ descriptor: slowOpConfig }),
    slowOpKind,
    // A deduped slow-op aggregate UPDATEs a hot row on every threshold-exceeding
    // span — thousands/min under load. Wiring per-statement live-state
    // invalidation onto it made slow_ops the single largest source of change-feed
    // churn (a self-amplifying loop: slow app → more slow-op writes → more notify
    // cascade → slower app). The Slow Ops pane reads it through the
    // `slow-ops.list` external snapshot value (re-read on open / Refresh)
    // instead of live-ticking. See the change-feed exclusion doc.
    ExcludeFromChangeFeed({
      table: _slowOps,
      reason:
        "High-churn deduped observability counter; live-ticking it amplifies the very slowness it records. Pane re-reads a snapshot on open / Refresh.",
    }),
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
  ],
  httpRoutes: {
    [submitClientSlowOp.route]: handleClientSlowOp,
  },
  register: [slowOpsRetention],
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
