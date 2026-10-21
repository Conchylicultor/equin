import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// An app exhibit: the breakdown draws its rows with the app's icons.
export default [
  appExhibit({
    id: "context/breakdown",
    label: "Context breakdown — 200k and 1M windows",
    widths: [320],
    load: () => import("./internal/breakdown"),
  }),
];
