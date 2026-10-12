import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { buildProfileDetailPane } from "./panes";

export { buildProfileDetailPane } from "./panes";

export default {
  description:
    "Build step profiling: the Gantt detail pane of one build run (debug-profiling-build-detail).",
  contributions: [Pane.Register({ pane: buildProfileDetailPane })],
  slots: { "debug-profiling-build-detail": buildProfileDetailPane },
} satisfies PluginDefinition;
