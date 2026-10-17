import { appExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";
import { TASK_DRAFT_FORM_WIDTH } from "../core";

// App exhibits: the composer's launch-option pills and prose actions are slot
// contributions and its URL default is config, so both need the running app.
// Both live in the Improve popover, opened from the action bar, so they wear the
// app chrome's theme.
export default [
  appExhibit({
    id: "task-draft/composer",
    label: "Task composer (Improve)",
    home: "chrome",
    widths: [360, 480, 640, 900],
    load: () => import("./internal/composer"),
  }),
  appExhibit({
    id: "task-draft/form",
    label: "Task draft form (Improve popover)",
    home: "chrome",
    // The form is one fixed column: framed exactly, then with room around it.
    widths: [TASK_DRAFT_FORM_WIDTH, 720],
    load: () => import("./internal/form"),
  }),
];
