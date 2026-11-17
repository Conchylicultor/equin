import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// An app exhibit: the body links to a build (the tab system) and its button
// carries a tooltip, which only the live app provides.
export default [
  appExhibit({
    id: "upstream/releases-row",
    label: "Releases row (the checkout that publishes)",
    widths: [380],
    load: () => import("./internal/releases-row"),
  }),
];
