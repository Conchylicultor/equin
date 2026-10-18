import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import { slowEventsPane, traceDetailPane } from "./panes";
import { SlowEvents } from "./slots";
import { EventsView } from "./components/events-view";
import { triggerKindPresentation } from "./internal/presentation";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { SlowEvents } from "./slots";
export { slowEventsPane, traceDetailPane } from "./panes";
export {
  groupIncidents,
  incidentColorClass,
  type IncidentInfo,
} from "./internal/incidents";
export { IncidentBadge } from "./components/incident-badge";

export default {
  description:
    "Debug → Slow Events: the tabbed pane host (Events list + detail Gantt) over the durable trace store, and the SlowEvents.View tab slot the Slow Ops aggregate/cluster views merge into.",
  contributions: [
    triggerKindPresentation,
    Pane.Register({ pane: slowEventsPane }),
    Pane.Register({ pane: traceDetailPane }),
    SlowEvents.View({
      id: "events",
      title: "Events",
      icon: symbol("list"),
      order: 10,
      component: EventsView,
    }),
    DebugApp.Sidebar({
      id: "trace-slow-events",
      title: "Slow Events",
      icon: symbol("bolt"),
      opens: { pane: slowEventsPane, params: {} },
    }),
  ],
  slots: {
    ...SlowEvents,
    traces: slowEventsPane,
    "trace-detail": traceDetailPane,
  },
} satisfies PluginDefinition;
