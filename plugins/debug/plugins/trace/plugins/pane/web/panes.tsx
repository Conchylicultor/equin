import { Pane, PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import {
  traceListRoute,
  traceDetailRoute,
} from "@plugins/debug/plugins/trace/plugins/engine/core";
import { SlowEvents } from "./slots";
import { TraceDetail } from "./components/trace-detail";

// Root pane (/debug/traces): the tab host. Owns no list logic itself — the
// Events tab (this plugin) + Aggregates/Cluster tabs (slow-ops) render via the
// SlowEvents slot.
export const slowEventsPane = Pane.define({
  title: "Slow Events",
  route: traceListRoute,
  app: debugApp,
  component: SlowEventsBody,
});

function SlowEventsBody() {
  return (
    <PaneChrome pane={slowEventsPane}>
      <SlowEvents.Host />
    </PaneChrome>
  );
}

// Detail pane (/debug/traces/x/:id): the unified Gantt for one trace. Wider than
// the default column to fit the timeline.
export const traceDetailPane = Pane.define({
  title: "Trace",
  route: traceDetailRoute,
  app: debugApp,
  component: TraceDetailBody,
  // No route guard — the detail self-fetches by id and renders a graceful 404
  // (the boot-profile detail precedent).
  useResolve: false,
});

function TraceDetailBody() {
  const { id } = traceDetailPane.useParams();
  return (
    <PaneChrome pane={traceDetailPane}>
      <TraceDetail id={id} />
    </PaneChrome>
  );
}
