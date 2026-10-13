import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Tasks } from "@plugins/tasks/plugins/task-list/web";
import { LiveExposures } from "@plugins/network/plugins/live/web";
import { taskTrackShape } from "../shared/resources";
import { TrackField } from "./components/track-field";

export { useStoredTracks, useTaskTrack } from "./hooks";
export { TaskTrackControl } from "./components/track-control";

export default {
  description:
    "Per-task track (main | sidequest): the track badge, a `track` enum field in the tasks DataView (badge cell, groupable, filterable), the clickable Track control the task detail header renders to switch it, and the exposed `track` field of every list whose rows reach a task.",
  contributions: [
    Tasks.Fields({ id: "track", section: null, component: TrackField }),
    // The `track` field of every list whose rows reach a task (the
    // conversation lists): an enum chip in its TRACK_META tint.
    LiveExposures.Register({ exposure: taskTrackShape.exposure }),
  ],
} satisfies PluginDefinition;
