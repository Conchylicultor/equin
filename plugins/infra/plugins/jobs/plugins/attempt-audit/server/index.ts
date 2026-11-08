import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { jobAttemptFailedKind } from "./internal/kind";
import { attemptReports } from "./internal/handler";
import { attemptReportsRetention } from "./internal/retention";

export default {
  description:
    "Job attempt audit: registers a handler on the jobs plugin's attempt seam and files every failed job attempt as a job-attempt-failed report (error) — retried or not — then restates that occurrence once its run settles: recovered on attempt N, or gave up and why (last attempt failed, worker died, cancelled, superseded). The report stays open for investigation either way; job_attempt_reports links each unsettled attempt to its report occurrence, durably across restarts.",
  contributions: [jobAttemptFailedKind],
  sinkHandlers: [attemptReports],
  register: [attemptReportsRetention],
} satisfies ServerPluginDefinition;
