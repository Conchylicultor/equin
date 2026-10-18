import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { queueHealthSummaryEndpoint } from "../core";
import {
  queueHealthTimer,
  startQueueHealthWatchdog,
  stopQueueHealthWatchdog,
} from "./internal/watchdog";
import { deadJobKind } from "./internal/dead-job-kind";
import { backlogKind } from "./internal/backlog-kind";
import { slotHogKind } from "./internal/slot-hog-kind";
import { slotBlockedKind } from "./internal/slot-blocked-kind";
import { classStarvedKind } from "./internal/class-starved-kind";
import { wedgedKind } from "./internal/wedged-kind";
import { queueHealthTool } from "./internal/mcp-tool";
import { handleQueueHealthSummary } from "./internal/summary-endpoint";
import { queuePulseServed } from "./internal/pulse";

export { queueHealthTickOnce } from "./internal/watchdog";

export default {
  description:
    "Queue-health watchdog: a 30s interval on the backend's own event loop — deliberately NOT a scheduled job, which would queue behind the wedge it exists to detect — that samples the graphile queue and files deduped reports for a wedged queue (every slot on every runner held by the same live jobs while ready work starves), a starved hold class (one tier of the runner ladder whose head has not moved for its own window, which is how the reserved-slot ladder is verified in production), a job holding a slot to WAIT on an admission gate rather than to work (read off the runtime profiler's job spans, which carry the wait/work split a graphile row cannot), backlog/stall, per-class slot-hogging, and terminally-dead jobs, through the existing reports engine. All six kinds are duressExempt. Also exposes a per-class queue-health summary endpoint + the get_queue_health MCP tool, and the push-based queue-health.pulse resource behind the health report's Job queue row (slot-ledger occupancy, waiting/stuck/dead jobs, pickup stats and a verdict whose next threshold crossing arms one timer).",
  httpRoutes: {
    [queueHealthSummaryEndpoint.route]: handleQueueHealthSummary,
  },
  register: [queueHealthTool, queueHealthTimer],
  contributions: [
    ...queuePulseServed.declare,
    deadJobKind,
    backlogKind,
    slotHogKind,
    slotBlockedKind,
    classStarvedKind,
    wedgedKind,
  ],
  // The watchdog is a timer on this backend's event loop, started and
  // stopped exactly like the jobs plugin's stuck-lock sweeper — see the long
  // comment in `internal/watchdog.ts` for why it must not be a `defineJob`.
  onReady: () => {
    startQueueHealthWatchdog();
  },
  onShutdown: () => {
    stopQueueHealthWatchdog();
  },
} satisfies MachinePluginDefinition;
