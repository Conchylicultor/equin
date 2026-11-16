import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// An app exhibit: the provenance chips read the id-kind presenters (a slot)
// and the avatars the theme, which only the live app provides.
export default [
  appExhibit({
    id: "commit-detail/message",
    label: "Commit message header",
    widths: [360, 560, 900],
    load: () => import("./internal/message"),
  }),
];
