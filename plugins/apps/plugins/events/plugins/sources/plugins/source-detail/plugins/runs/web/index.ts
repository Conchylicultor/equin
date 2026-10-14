import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { EventSourceDetail } from "@plugins/apps/plugins/events/plugins/sources/web";
import { SourceRunsSection } from "./components/runs-section";
import { eventSourceRunPane } from "./panes";
import { runPresentation } from "./internal/presentation";
import { RunActions, EventSourceRunDetail } from "./slots";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { RunActions, EventSourceRunDetail } from "./slots";
export { eventSourceRunPane } from "./panes";

export default {
  description:
    "Runs section of the Events source side-pane: the run ledger as a DataView (outcome, event counts, duration, error), including the cheap `unchanged` runs — the record that makes 'why did nothing happen' answerable. A row drills into the run's own pane, whose regions are contributions.",
  contributions: [
    EventSourceDetail.Section({
      id: "runs",
      label: "Runs",
      icon: symbol("history"),
      component: SourceRunsSection,
      // Open by default: the ledger is the answer to "did my source do
      // anything, and why not", which is the first question after adding one.
      useDefaultOpen: () => true,
    }),
    Pane.Register({ pane: eventSourceRunPane }),
    runPresentation,
  ],
  slots: {
    itemActions: RunActions,
    ...EventSourceRunDetail,
    "event-source-run": eventSourceRunPane,
  },
} satisfies PluginDefinition;
