import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  backfillPageLinksJob,
  pageLinksBackfillWarmup,
} from "./internal/backfill-job";

export default {
  description:
    "Backlinks index, desktop-only half: the boot backfill (a warm-up enqueuing a job that reindexes every live page's outgoing links, off the serving-critical boot path).",
  register: [backfillPageLinksJob, pageLinksBackfillWarmup],
} satisfies MachinePluginDefinition;
