import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

export default [
  appExhibit({
    id: "deploy-sessions/list",
    label: "Sessions list (made-up visits)",
    widths: [760, 1124],
    load: () => import("./internal/sessions-list"),
  }),
];
