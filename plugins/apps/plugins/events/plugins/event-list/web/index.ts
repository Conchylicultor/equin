import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Events } from "@plugins/apps/plugins/events/plugins/shell/web";
import { eventListPane } from "./panes";
import { eventPresentation } from "./internal/presentation";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { eventListPane } from "./panes";
// The one answer to "where does an event open". Exported so a second events
// surface (the run pane's extracted events) opens the same destination, instead
// of a near-copy that drifts.
export { useOpenEvent, useEventUrl } from "./internal/use-open-event";

export default {
  description:
    "The events DataView: the live `events.list` collection (live key-range pages kept fresh by the routed change feed) rendered as list / table / gallery, its fields derived from the events entity (the absolute When cell and the link chip presented here) and the saved views authored in config. Reachable from the Events sidebar.",
  contributions: [
    Pane.Register({ pane: eventListPane }),
    Events.Sidebar({
      id: "event-list",
      title: "Events",
      icon: symbol("event-note"),
      opens: { pane: eventListPane, params: {} },
    }),
    eventPresentation,
  ],
  slots: { "event-list": eventListPane },
} satisfies PluginDefinition;
