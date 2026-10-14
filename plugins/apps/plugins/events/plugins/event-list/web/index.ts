import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Events } from "@plugins/apps/plugins/events/plugins/shell/web";
import { eventListPane } from "./panes";
import { eventPresentation } from "./internal/presentation";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { eventListPane } from "./panes";
// The one rendering of "an event, as a row", and the one answer to "where does
// an event open". Exported so a second events surface (the run pane's extracted
// events) shows the same row and opens the same destination, instead of a
// near-copy that drifts. Both are this plugin's own internal files — a re-export
// of another plugin's symbol would be the boundary violation, this is not.
export { EventRow } from "./components/event-row";
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
