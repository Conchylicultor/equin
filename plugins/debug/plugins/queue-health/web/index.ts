import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Reports } from "@plugins/reports/web";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { queueHealthConfig } from "../core";
import { DeadJobSummary } from "./components/dead-job-summary";
import { BacklogSummary } from "./components/backlog-summary";
import { SlotHogSummary } from "./components/slot-hog-summary";
import { SlotBlockedSummary } from "./components/slot-blocked-summary";
import { ClassStarvedSummary } from "./components/class-starved-summary";
import { WedgedSummary } from "./components/wedged-summary";
import { QueueGlance } from "./components/queue-glance";
import { QueueDetail } from "./components/queue-detail";
import { OpenQueueAction } from "./components/open-queue-action";
import { useQueueHealth } from "./internal/use-queue-health";

export default {
  collapsed: true,
  description:
    "Queue-health report renderers: one-line Debug → Reports summaries for the queue-wedged, queue-class-starved, queue-dead-job, queue-backlog, queue-slot-hog, and queue-slot-blocked kinds, plus the threshold config registration, and the health report's Job queue row: per-class slot bars, the jobs that explain its colour, pickup-time stats, and an Open queue action.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: queueHealthConfig }),
    Reports.KindView({ match: "queue-dead-job", component: DeadJobSummary }),
    Reports.KindView({ match: "queue-backlog", component: BacklogSummary }),
    Reports.KindView({ match: "queue-slot-hog", component: SlotHogSummary }),
    Reports.KindView({
      match: "queue-slot-blocked",
      component: SlotBlockedSummary,
    }),
    Reports.KindView({
      match: "queue-class-starved",
      component: ClassStarvedSummary,
    }),
    Reports.KindView({ match: "queue-wedged", component: WedgedSummary }),
    HealthReport.Row({
      kind: "status",
      id: "job-queue",
      title: "Job queue",
      useStatus: useQueueHealth,
      glance: QueueGlance,
      component: QueueDetail,
      actions: OpenQueueAction,
    }),
  ],
} satisfies PluginDefinition;
