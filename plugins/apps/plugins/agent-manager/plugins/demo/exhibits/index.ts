import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// The Agent Manager rendered in-process on its demo pack: needs the running
// app (the app's own plugins draw it), never the instance's data.
export default [
  appExhibit({
    id: "agent-manager/demo",
    label: "Agent Manager demo (in-process, fake data)",
    widths: [1280],
    load: () => import("./internal/demo"),
  }),
];
