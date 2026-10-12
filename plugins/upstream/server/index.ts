import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { automationConfigRegistration } from "@plugins/tasks/plugins/automations/server";
import { upstreamMergeConfig } from "../shared/config";
import { detectUpstreamUpdatesJob } from "./internal/detect-job";
import {
  UPSTREAM_CATEGORY_ID,
  upstreamMergeAutomation,
} from "./internal/merge-automation";
import { upstreamUpdatesKind } from "./internal/report-kind";

export {
  upstreamUpdatesKind,
  UPSTREAM_UPDATES_KIND,
} from "./internal/report-kind";
export type { UpstreamUpdatesPayload } from "./internal/report-kind";

export default {
  description:
    "Daily upstream.detect-updates job (main only): when the repo this checkout was cloned from has commits local `main` does not, it records one rolling `upstream-updates-available` report — the bell and Debug → Reports, whose Investigate mints a merge task. And the Upstream merges automation (upstream-merge; off by default, daily once on, editable from the Automations pane): when upstream is ahead and no merge task is open, it files ONE auto-started task (Upstream category, linked to the report) whose agent runs `./singularity upstream merge`, builds and checks the app, and lands it only as far as its Push setting allows (never, by default).",
  contributions: [
    upstreamUpdatesKind,
    automationConfigRegistration(upstreamMergeConfig),
    TaskCategory({ id: UPSTREAM_CATEGORY_ID, label: "Upstream", order: 12 }),
  ],
  register: [detectUpstreamUpdatesJob, upstreamMergeAutomation],
} satisfies ServerPluginDefinition;
