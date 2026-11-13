import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const chordApp = defineApp({
  id: "chord",
  name: "Chord",
  basePath: "/chord",
  icon: symbol("queue-music"),
});
