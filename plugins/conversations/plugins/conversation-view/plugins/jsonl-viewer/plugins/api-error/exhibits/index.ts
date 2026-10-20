import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// An app exhibit: the row's actions cluster reads the viewer's row context.
export default [
  appExhibit({
    id: "jsonl-viewer/api-error",
    label: "Transcript API error rows (usage limit, server error)",
    widths: [420, 760],
    load: () => import("./internal/api-error-rows"),
  }),
];
