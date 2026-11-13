import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const eventsApp = defineApp({
  id: "events",
  name: "Events",
  basePath: "/events",
  icon: symbol("event"),
});
