import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { opRateConfig } from "../core";
import { opRateMonitorJob } from "./internal/monitor-job";
import { opRateKind } from "./internal/op-rate-kind";
import { opTimeKind } from "./internal/op-time-kind";
import {
  historyContributions,
  hourCallsRetention,
  windowCountsRetention,
  windowsRetention,
} from "./internal/history-contributions";

export default {
  description:
    "Profiler-diff monitor: a cheap per-worktree scheduled job that diffs the runtime profiler's per-op call counts (op-rate) AND cumulative wall-clock time (op-time count×cost) each tick, files deduped reports per hot/over-budget op plus a per-kind aggregate-time rollup, and captures a coherent-instant trace on each op-time per-op trip — all through the existing reports engine.",
  register: [
    opRateMonitorJob,
    windowCountsRetention,
    windowsRetention,
    hourCallsRetention,
  ],
  contributions: [
    ConfigV2.Register({ descriptor: opRateConfig }),
    opRateKind,
    opTimeKind,
    ...historyContributions,
  ],
} satisfies ServerPluginDefinition;
