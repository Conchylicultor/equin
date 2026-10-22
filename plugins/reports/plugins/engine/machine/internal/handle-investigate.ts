import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { investigateReport } from "@plugins/reports/plugins/engine/server";
import { investigateReport as investigateReportEndpoint } from "@plugins/reports/core";

// On-demand: turn a recorded report into an investigation task (idempotent —
// re-clicking returns the existing live task). The `:id` path param is the
// report id; investigateReport throws if no such report exists, which surfaces
// as a 500 (a wiring/race bug, not a benign client condition). Desktop-only:
// the task's agent runs on the computer (`needsMachine`).
export const handleInvestigate = implementMachine(
  investigateReportEndpoint,
  async ({ params }) => {
    if (!params.id) throw new HttpError(400, "id required");
    return investigateReport(params.id);
  },
);
