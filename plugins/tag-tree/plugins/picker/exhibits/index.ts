import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// App exhibits: the picker's rows read the tree-disclosure slot and its menus
// the app's overlays, so they need the running app. Fixture rows, no writes.
export default [
  appExhibit({
    id: "tag-tree/picker",
    label: "Tag picker (the mockup's tree, homepage picked)",
    widths: [300],
    load: () => import("./internal/picker"),
  }),
  appExhibit({
    id: "tag-tree/path-chip",
    label: "Tag path chip (tagged deep, tagged, untagged)",
    widths: [480],
    load: () => import("./internal/path-chip"),
  }),
];
