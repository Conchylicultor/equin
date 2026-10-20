import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { taskTrackShape } from "../core";

export { useStoredTracks, useTaskTrack } from "./hooks";
export { TaskTrackControl } from "./components/track-control";

export default {
  description:
    "Per-task track (main | sidequest): the track badge, the clickable Track control the task detail header renders to switch it, and the exposed `track` field of every list whose rows reach a task (the task list, the conversation lists).",
  contributions: [
    // The `track` field of every list whose rows reach a task (the task list,
    // the conversation lists): an enum chip in its TRACK_META tint.
    FieldPresentation.Register({ owner: taskTrackShape.exposure }),
  ],
} satisfies PluginDefinition;
