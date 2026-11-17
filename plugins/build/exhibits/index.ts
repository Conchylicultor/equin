import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// An app exhibit: the pill's button and icon need the running app (theme, icon
// sprites). It lives in the action bar, so its home is the chrome theme.
export default [
  appExhibit({
    id: "build/update-pill",
    label: "Update pill (waiting, ready, a user's fault retry)",
    home: "chrome",
    widths: [480],
    load: () => import("./internal/update-pill"),
  }),
];
