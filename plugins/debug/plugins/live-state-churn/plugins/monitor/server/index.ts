import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { onResourcePush } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { liveStateChurnConfig } from "../core";
import { liveStateChurnMonitorJob } from "./internal/monitor-job";
import { noopKind } from "./internal/noop-kind";
import { recordPush } from "./internal/accumulator";

export default {
  description:
    "Live-state churn monitor: an in-process accumulator fed by every keyed live-state push, plus a per-worktree scheduled job that files deduped reports for resources sustaining a high rate of no-op (empty-diff) pushes, through the existing reports engine.",
  register: [liveStateChurnMonitorJob],
  contributions: [
    ConfigV2.Register({ descriptor: liveStateChurnConfig }),
    noopKind,
  ],
  // Install the push accumulator at boot. onResourcePush returns an unsubscribe,
  // but this is a process-lifetime registration (one observer for the whole
  // backend), so we intentionally never tear it down.
  onReady: () => {
    onResourcePush(recordPush);
  },
} satisfies ServerPluginDefinition;
