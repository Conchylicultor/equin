import { defineRequestSink } from "@plugins/primitives/plugins/report-sink/core";
import type { UiContextMeta } from "@plugins/primitives/plugins/ui-context/core";

export interface BoundaryErrorReport {
  error: Error;
  componentStack: string | null;
  slot: string | null;
  label: string | null;
  // The composition lineage of the crashed subtree — which plugin contributed
  // into which slot, inside which named screen region. Optional because both
  // boundary classes construct the report before anything is mounted; only
  // `CrashFallback` can fill it in, from its own position in the DOM, after the
  // fallback has rendered. Absent or partial is a legitimate outcome: the
  // contribution half of the lineage is stamped by an opt-in middleware that
  // lives in `primitives/ui-context/element-picker`.
  uiContext?: UiContextMeta | null;
}

// Set by a domain plugin (e.g. `reports.crash`) at mount time. The boundary
// stores whatever the reporter returns as opaque `context` and threads it to
// ErrorBoundary.Action contributions. The boundary primitive never looks at the
// shape — that's the contract between the reporter-owner and action contributors.
// emit() returns the handler's Promise (or sync value) so the boundary can await
// the resolved context; it swallows a throw since it runs on the error path.
export const boundaryReportSink = defineRequestSink<
  BoundaryErrorReport,
  Promise<unknown> | unknown | void
>("primitives/plugins/error-boundary:boundaryReportSink");
