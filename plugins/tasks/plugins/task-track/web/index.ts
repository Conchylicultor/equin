import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Tasks } from "@plugins/tasks/plugins/task-list/web";
import { TrackField } from "./components/track-field";

export { useStoredTracks, useTaskTrack } from "./hooks";
export { TaskTrackControl } from "./components/track-control";

export default {
  description:
    "Per-task track (main | sidequest): the track badge, a `track` enum field in the tasks DataView (badge cell, groupable, filterable), and the clickable Track control the task detail header renders to switch it.",
  contributions: [
    Tasks.Fields({ id: "track", section: null, component: TrackField }),
  ],
} satisfies PluginDefinition;
