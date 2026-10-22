import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import type { MachineResult } from "@plugins/infra/plugins/endpoints/core";
import { investigateReport } from "../core";

// On-demand: turn a recorded report into an investigation task. Idempotent on
// the server (re-calling returns the existing live task). Resolves to the task
// id, which the caller binds a launched conversation to. A user action, so it
// goes through the caller's transport (`useFetchEndpoint()`) — never the
// page's: this module is the scope's, apart from `report.ts`, which is the
// page's telemetry. Desktop-only (`needsMachine`): a host without the computer
// answers the unavailable arm, which the caller gates on beforehand with
// `useMachineAvailability(investigateReport)`.
export async function investigate(
  fetchEndpoint: FetchEndpoint,
  reportId: string,
): Promise<MachineResult<{ taskId: string }>> {
  return await fetchEndpoint(investigateReport, { id: reportId });
}
