import { defineRetention } from "@plugins/infra/plugins/retention/server";
import { _jobAttemptReports } from "./tables";

// A link outlives its settle only when the settle was lost (the backend died
// between an attempt's report and its link write, or a row left the queue by
// a path that announces nothing). A day is far past any retry backoff; the
// report itself stays, saying the run was still retrying.
//
// `perWorktree: true`: every backend runs jobs over its own database.
export const attemptReportsRetention = defineRetention({
  table: _jobAttemptReports,
  column: "createdAt",
  ttlDays: 1,
  perWorktree: true,
});
