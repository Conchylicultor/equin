import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// An app exhibit: the card's chips, chevrons and icons need the running app
// (theme, icon sprites).
export default [
  appExhibit({
    id: "flag-raise/card",
    label: "Flag raised (items with folded details)",
    widths: [480, 760],
    load: () => import("./internal/card"),
  }),
];
