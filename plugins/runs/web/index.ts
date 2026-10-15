import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Runs } from "./internal/slots";
import { runsPresentation } from "./internal/presentation";

export { Runs } from "./internal/slots";
export type { RunKindContribution, RunRowProps } from "./internal/slots";
export { RunsDataView } from "./components/runs-data-view";
export type { RunsDataViewProps } from "./components/runs-data-view";
export { RunDuration } from "./components/run-duration";
export { useRun } from "./internal/use-run";
export { formatDuration } from "./internal/format";
export { RUNS_VIEW } from "./internal/view-id";
export { investigateRuns } from "./internal/investigate";
export type { RunInvestigation } from "./internal/investigate";

export default {
  description:
    "The merged run surface: <RunsDataView> over the `runs` union window (a live scroll: base fields derived from the collection and presented once, plus every arm's own fields, derived from its liveArm, each bound to its column), and the two seams an arm reaches it through (Runs.Kind for the arm itself — its kind and label — plus row activation, and Runs.Leading for the list row's status glyph); an arm presents its fields' cells with FieldPresentation.Register({ owner: arm }). Every row is a single field-driven line; a domain's detail lives in the pane its rows open. Also exports useRun (a live point read of one run by its (kind, id) pair) and <RunDuration> (finished duration, or a running run's ticking elapsed time).",
  slots: Runs,
  // The base fields' cells, widths and kind options, for every list of runs.
  contributions: [runsPresentation],
} satisfies PluginDefinition;
