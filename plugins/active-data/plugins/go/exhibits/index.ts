import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// An app exhibit: the cells render through <Markdown>, whose enhancers are
// slot contributions. Outside a conversation pane there is no prompt to reach,
// so the card draws without its ✎ / ▶ rail.
export default [
  appExhibit({
    id: "go/pick-table",
    label: "Go pick table",
    widths: [480, 740],
    load: () => import("./internal/pick-table"),
  }),
];
