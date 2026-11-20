import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// App exhibits: the row's parts are slot contributions of other plugins (the
// Visitors block, Deploy, Investigate), which only the live app registers.
// Each draws its own fixture for the state (`SiteLivePart.exhibit`).
export default [
  appExhibit({
    id: "site-row/live",
    label: "Deployed site row — live, up to date",
    home: "chrome",
    widths: [380],
    load: () => import("./internal/live"),
  }),
  appExhibit({
    id: "site-row/deploying",
    label: "Deployed site row — deploying",
    home: "chrome",
    widths: [380],
    load: () => import("./internal/deploying"),
  }),
  appExhibit({
    id: "site-row/behind",
    label: "Deployed site row — behind main",
    home: "chrome",
    widths: [380],
    load: () => import("./internal/behind"),
  }),
  appExhibit({
    id: "site-row/reconnecting",
    label: "Deployed site row — reconnecting",
    home: "chrome",
    widths: [380],
    load: () => import("./internal/reconnecting"),
  }),
  appExhibit({
    id: "site-row/down",
    label: "Deployed site row — down",
    home: "chrome",
    widths: [380],
    load: () => import("./internal/down"),
  }),
  appExhibit({
    id: "site-row/failed",
    label: "Deployed site row — deploy failed",
    home: "chrome",
    widths: [380],
    load: () => import("./internal/failed"),
  }),
  appExhibit({
    id: "site-row/two-sites",
    label: "Deployed site rows — two sites",
    home: "chrome",
    widths: [380],
    load: () => import("./internal/two-sites"),
  }),
];
