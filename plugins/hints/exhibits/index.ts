import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// App exhibits: the card's buttons and icons need the running app (theme,
// icon sprites). Hints float over every app, so they wear the chrome theme by
// default — pick an app in the viewer to see one in place.
export default [
  appExhibit({
    id: "hints/card",
    label: "Hint card (tour step and tip)",
    home: "chrome",
    widths: [360, 640],
    load: () => import("./internal/card"),
  }),
  appExhibit({
    id: "hints/spotlight",
    label: "Tour step spotlight",
    home: "chrome",
    widths: [640, 960],
    load: () => import("./internal/spotlight"),
  }),
  appExhibit({
    id: "hints/welcome",
    label: "Tour welcome card",
    home: "chrome",
    widths: [480, 960],
    load: () => import("./internal/welcome"),
  }),
];
