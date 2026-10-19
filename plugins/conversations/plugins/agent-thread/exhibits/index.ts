import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

// App exhibits: step labels are StepLabel dispatch contributions and the
// user bubble walks the inline-text registry, so the thread needs the running
// app. 420 is a host's side panel (Places' Ask panel), 640 a wide pane.
export default [
  appExhibit({
    id: "agent-thread/running",
    label: "Agent thread (running)",
    widths: [420, 640],
    load: () => import("./internal/running"),
  }),
  appExhibit({
    id: "agent-thread/done",
    label: "Agent thread (done, two turns)",
    widths: [420, 640],
    load: () => import("./internal/done"),
  }),
  appExhibit({
    id: "agent-thread/failed",
    label: "Agent thread (failed)",
    widths: [420, 640],
    load: () => import("./internal/failed"),
  }),
  appExhibit({
    id: "agent-thread/question",
    label: "Agent thread (waiting on a question)",
    widths: [420, 640],
    load: () => import("./internal/question"),
  }),
];
